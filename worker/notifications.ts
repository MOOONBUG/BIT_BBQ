// Operator-only notifications. No customer email or submitted text is sent.
const INTERNAL_TEST = 'MSC-51e08077-c0ac-49a4-aad4-b722de0bdb4f';
const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 120;
const regions: Record<string, { accounts: string; mail: string }> = {
  com: { accounts: 'https://accounts.zoho.com', mail: 'https://mail.zoho.com' },
  cn: { accounts: 'https://accounts.zoho.com.cn', mail: 'https://mail.zoho.com.cn' },
  eu: { accounts: 'https://accounts.zoho.eu', mail: 'https://mail.zoho.eu' },
};
type Job = { enquiry_id: string; attempts: number; lease_until: number };
type Details = { service_type: string; locale: string; created_at: number };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const email = (s: string) => /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s);
const now = () => Math.floor(Date.now() / 1000);

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw Error('empty');
  const reader = response.body.getReader();
  let text = '', length = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 32768) { await reader.cancel(); throw Error('oversize'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

function configuration(env: Env) {
  const region = regions[env.ZOHO_REGION];
  const start = Number(env.NOTIFICATIONS_START_AT);
  if (!region || !/^[1-9]\d*$/.test(env.NOTIFICATIONS_START_AT) || !Number.isSafeInteger(start)
    || !email(env.NOTIFICATION_FROM || '') || !email(env.NOTIFICATION_TO || '')
    || !/^\d+$/.test(env.ZOHO_ACCOUNT_ID || '')
    || !env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN) return null;
  return { ...region, start };
}

export function notificationContent(id: string, details: Details) {
  return {
    subject: `[MooonStoreClinic] New ${details.service_type === 'free_trial' ? 'free review' : 'paid enquiry'} — ${id}`,
    content: `A new website request is ready for review.\n\nReference: ${id}\nType: ${details.service_type === 'free_trial' ? 'Free micro-review application' : 'Paid-service enquiry'}\nPage language: ${details.locale}\nReceived (UTC): ${new Date(details.created_at * 1000).toISOString()}\n\nOpen the internal enquiry workflow to inspect the request. This notification does not mean that the applicant has been selected, contacted or charged.\nNo customer information is included in this email.`,
  };
}

async function finish(env: Env, job: Job, state: string, code: string | null, messageId: string | null, retryAt = 0) {
  // Compare the claimed attempt and lease: a stale worker cannot overwrite a newer state.
  await env.DB.prepare(`UPDATE notification_outbox SET state=?,last_error_code=?,provider_message_id=?,
    next_attempt_at=?,lease_until=NULL WHERE enquiry_id=? AND state='sending' AND attempts=? AND lease_until=?`)
    .bind(state, code, messageId, retryAt, job.enquiry_id, job.attempts, job.lease_until).run();
}

export async function processNotifications(env: Env) {
  if (env.NOTIFICATIONS_ENABLED !== 'true') return;
  const config = configuration(env);
  if (!config) { console.error(JSON.stringify({ event: 'notification_configuration_missing' })); return; }
  const timestamp = now();
  // A crashed request may already have sent mail. Never automatically reclaim it.
  await env.DB.prepare(`UPDATE notification_outbox SET state='failed',last_error_code='delivery_unknown',lease_until=NULL
    WHERE state='sending' AND lease_until<=?`).bind(timestamp).run();
  const due = await env.DB.prepare(`SELECT COUNT(*) AS total FROM notification_outbox o JOIN enquiries e ON e.id=o.enquiry_id
    WHERE o.state='pending' AND o.next_attempt_at<=? AND o.attempts<? AND e.created_at>=? AND e.expires_at>?
    AND e.id!=?`).bind(timestamp, MAX_ATTEMPTS, config.start, timestamp, INTERNAL_TEST).first<{ total: number }>();
  if (!due?.total) { await logHealth(env); return; }
  // Refresh before claiming mail: token errors cannot create ambiguous delivery.
  let accessToken: string;
  try {
    const response = await fetch(`${config.accounts}/oauth/v2/token`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.ZOHO_CLIENT_ID,
        client_secret: env.ZOHO_CLIENT_SECRET, refresh_token: env.ZOHO_REFRESH_TOKEN }),
    });
    const data = await boundedJson(response);
    if (!response.ok || !record(data) || typeof data.access_token !== 'string' || !data.access_token) throw Error('token');
    accessToken = data.access_token;
  } catch { console.error(JSON.stringify({ event: 'notification_auth_failed' })); return; }

  for (let i = 0; i < 3; i++) {
    const at = now();
    // Single SQLite write atomically selects and claims one row across concurrent cron runs.
    const job = await env.DB.prepare(`UPDATE notification_outbox SET state='sending',attempts=attempts+1,lease_until=?
      WHERE enquiry_id=(SELECT o.enquiry_id FROM notification_outbox o JOIN enquiries e ON e.id=o.enquiry_id
        WHERE o.state='pending' AND o.next_attempt_at<=? AND o.attempts<? AND e.created_at>=? AND e.expires_at>?
        AND e.id!=? ORDER BY o.next_attempt_at,o.enquiry_id LIMIT 1) AND state='pending'
      RETURNING enquiry_id,attempts,lease_until`)
      .bind(at + LEASE_SECONDS, at, MAX_ATTEMPTS, config.start, at, INTERNAL_TEST).first<Job>();
    if (!job) break;
    const details = await env.DB.prepare('SELECT service_type,locale,created_at FROM enquiries WHERE id=? AND expires_at>?')
      .bind(job.enquiry_id, now()).first<Details>();
    if (!details) { await finish(env, job, 'failed', 'expired', null); continue; }
    let response: Response;
    try {
      response = await fetch(`${config.mail}/api/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAddress: env.NOTIFICATION_FROM, toAddress: env.NOTIFICATION_TO,
          ...notificationContent(job.enquiry_id, details), mailFormat: 'plaintext', encoding: 'UTF-8', askReceipt: 'no' }),
      });
    } catch { await finish(env, job, 'failed', 'delivery_unknown', null); continue; }
    // Only explicit rejection is retryable. A 5xx, timeout or malformed success could be after acceptance.
    if (response.status === 429 || response.status === 401) {
      const retryAfter = response.headers.get('Retry-After');
      const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter)
        : retryAfter ? Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)) : 0;
      const delay = Math.max(300 * 2 ** (job.attempts - 1), Number.isFinite(seconds) ? seconds : 0);
      await response.body?.cancel();
      await finish(env, job, job.attempts < MAX_ATTEMPTS ? 'pending' : 'failed', `http_${response.status}`, null, now() + Math.min(delay, 86400));
      break; // Avoid consuming the whole queue during a provider/auth outage.
    }
    if (!response.ok) {
      await response.body?.cancel();
      await finish(env, job, 'failed', response.status >= 500 ? 'delivery_unknown' : `http_${response.status}`, null);
      continue;
    }
    let messageId: string | null = null;
    try {
      const data = await boundedJson(response);
      if (record(data) && record(data.status) && data.status.code === 200 && record(data.data)
        && typeof data.data.messageId === 'string' && /^\d+$/.test(data.data.messageId)) messageId = data.data.messageId;
    } catch { /* Never log provider responses or credentials. */ }
    await finish(env, job, messageId ? 'sent' : 'failed', messageId ? null : 'delivery_unknown', messageId);
  }
  await logHealth(env);
}

async function logHealth(env: Env) {
  const counts = await env.DB.prepare(`SELECT
    SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS needsReview FROM notification_outbox`).first();
  console.log(JSON.stringify({ event: 'notification_health', ...counts }));
}
