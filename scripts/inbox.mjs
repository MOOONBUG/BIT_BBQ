// Read-only local operator view. No public endpoint and no outgoing email.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [action = 'summary', id, ...extra] = process.argv.slice(2);
const excluded = 'MSC-51e08077-c0ac-49a4-aad4-b722de0bdb4f';
if (extra.length || !['summary', 'detail'].includes(action) || (action === 'summary' && id)) {
  throw Error('Use npm run inbox | npm run inbox -- detail MSC-ID. All operations are read-only.');
}
let sql;
if (action === 'detail') {
  if (!/^MSC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || '') || id === excluded)
    throw Error('Supply a complete customer enquiry ID; the internal test is excluded.');
  sql = `SELECT e.id,e.service_type,e.locale,e.email,e.page_url,e.market,e.goal,e.issue,e.preferred_time,e.status,
    datetime(e.created_at,'unixepoch','+8 hours') AS received_beijing,
    f.review_status,f.selection_week,f.duplicate_candidate,o.state AS notification_state,o.last_error_code
    FROM enquiries e LEFT JOIN free_reviews f ON f.enquiry_id=e.id
    LEFT JOIN notification_outbox o ON o.enquiry_id=e.id WHERE e.id='${id}' AND e.expires_at>unixepoch();`;
} else {
  sql = `SELECT e.service_type,e.status,COUNT(*) AS total FROM enquiries e
    WHERE e.id!='${excluded}' AND e.expires_at>unixepoch() GROUP BY e.service_type,e.status;
    SELECT e.id,e.service_type,e.locale,e.status,f.review_status,f.selection_week,f.duplicate_candidate,
      datetime(e.created_at,'unixepoch','+8 hours') AS received_beijing,o.state AS notification_state,o.last_error_code
    FROM enquiries e LEFT JOIN free_reviews f ON f.enquiry_id=e.id LEFT JOIN notification_outbox o ON o.enquiry_id=e.id
    WHERE e.id!='${excluded}' AND e.expires_at>unixepoch() AND
      (e.status IN ('new','reviewing') OR f.review_status IN ('received','waitlisted','selected'))
    ORDER BY e.created_at LIMIT 100;
    SELECT e.id,o.state,o.attempts,o.last_error_code,
      datetime(o.next_attempt_at,'unixepoch','+8 hours') AS next_attempt_beijing
    FROM notification_outbox o JOIN enquiries e ON e.id=o.enquiry_id
    WHERE e.id!='${excluded}' AND e.expires_at>unixepoch() AND
      (o.state='failed' OR (o.state='sending' AND o.lease_until<=unixepoch()) OR
       (o.state='pending' AND o.next_attempt_at<unixepoch()-900)) ORDER BY o.next_attempt_at LIMIT 100;
    SELECT c.id,c.enabled,c.weekly_limit,c.intake_limit,
      (SELECT COUNT(*) FROM free_reviews f WHERE f.campaign_id=c.id AND f.review_status IN ('received','waitlisted')) AS pending
    FROM review_campaigns c;`;
}
const args = [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute',
  'mooon-enquiries', '--remote', '--config', 'wrangler.api.json', '--command', sql, '--json'];
const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error('Could not read the live inbox. No records changed; this is not an empty-inbox result.');
  process.exitCode = result.status || 1;
} else {
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw Error('Unrecognized database response. Do not treat it as an empty inbox.'); }
  const expected = action === 'detail' ? 1 : 4;
  if (!Array.isArray(data) || data.length !== expected || data.some(row => row.success !== true || !Array.isArray(row.results)))
    throw Error('Database query incomplete. No records changed.');
  console.log('MooonStoreClinic | live read-only inbox | times: Asia/Shanghai');
  if (action === 'detail') {
    console.log('Private customer details: do not paste this output into public logs.');
    console.log(data[0].results.length ? JSON.stringify(data[0].results[0], null, 2) : 'No active matching enquiry found.');
  } else {
    for (const [index, label] of ['Active enquiry counts', 'Work queue (oldest first, up to 100)',
      'Notifications needing review (up to 100)', 'Free-review capacity'].entries()) {
      console.log(`\n${label}`);
      if (data[index].results.length) console.table(data[index].results); else console.log('None.');
    }
    console.log('\nNotification sent = provider accepted, not confirmed inbox delivery.');
    console.log('Pending older than 15 minutes can include pre-activation records; reconcile before resending.');
    console.log('View a request: npm run inbox -- detail MSC-ID');
    // Counts only: no customer fields or identifiers in the local health receipt.
    const receipt = { checkedAt: new Date().toISOString(), counts: data[0].results,
      displayedWorkItems: data[1].results.length, displayedNotificationIssues: data[2].results.length,
      capacity: data[3].results, readOnly: true };
    fs.mkdirSync(path.join(root, '.cloud-setup'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cloud-setup/inbox-last-check.json'), JSON.stringify(receipt, null, 2));
  }
}
