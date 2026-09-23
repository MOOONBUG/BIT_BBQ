// Local operator CLI. No public admin endpoint; mutations preview SQL by default.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), apply = args.includes('--apply');
const [action='list', id, state, week] = args.filter(a => a !== '--apply');
const validateId = () => { if (!/^MSC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || '')) throw Error('A complete MSC enquiry ID is required.'); };
let sql, mutation=false;
if(action==='list') {
 sql = `SELECT c.id,c.enabled,c.weekly_limit,c.intake_limit,(SELECT COUNT(*) FROM free_reviews WHERE campaign_id=c.id AND review_status IN ('received','waitlisted')) AS pending FROM review_campaigns c;
 SELECT f.enquiry_id,e.locale,datetime(e.created_at,'unixepoch','+8 hours') AS received_beijing,f.review_status,f.duplicate_candidate,f.selection_week FROM free_reviews f JOIN enquiries e ON e.id=f.enquiry_id ORDER BY e.created_at LIMIT 100;`;
} else if(action==='detail') {
 validateId();
 sql=`SELECT e.id,e.email,e.page_url,e.market,e.goal,f.review_status,f.policy_version,f.duplicate_candidate FROM enquiries e JOIN free_reviews f ON f.enquiry_id=e.id WHERE e.id='${id}';`;
} else if(['pause','resume'].includes(action)) {
 mutation=true;
 sql=`UPDATE review_campaigns SET enabled=${action==='resume'?1:0} WHERE id='micro-review-v1'; SELECT id,enabled FROM review_campaigns WHERE id='micro-review-v1';`;
} else if(action==='status') {
 validateId();
 if(!['selected','waitlisted','unsuitable','withdrawn','delivered'].includes(state)) throw Error('Unknown review status.');
 if(state==='selected' && (!/^\d{4}-\d{2}-\d{2}$/.test(week || '') || new Date(week+'T00:00:00Z').getUTCDay()!==1 || new Date(week+'T00:00:00Z').toISOString().slice(0,10)!==week)) throw Error('Supply the Monday date of the agreed delivery week, YYYY-MM-DD.');
 mutation=true;
 sql=`UPDATE free_reviews SET review_status='${state}',updated_at=unixepoch()${state==='selected'?`,selection_week='${week}'`:''} WHERE enquiry_id='${id}'; SELECT enquiry_id,review_status,selection_week FROM free_reviews WHERE enquiry_id='${id}';`;
} else throw Error('Use list | detail ID | pause | resume | status ID selected MONDAY | status ID waitlisted/unsuitable/withdrawn/delivered. Add --apply for mutations.');
if(mutation&&!apply){console.log('Preview only. Add --apply to execute against production D1.');console.log(sql);}
else {
 const result=spawnSync(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','mooon-enquiries','--remote','--config','wrangler.api.json','--command',sql],{cwd:root,stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;
 process.exitCode=result.status??1;
}
