type Brief = {
  requestKey: string; email: string; pageUrl: string; market: string; goal: string;
  issue: string; preferredTime: string; locale: string; acknowledgementVersion: string;
};
class RequestError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const reply = (status: number, data: object) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(status === 429 ? { 'Retry-After': '600' } : {}) },
});
const hosts = (env: Env) => env.ALLOWED_HOSTS.split(',').map(s => s.trim());
const ready = (env: Env) => env.ENQUIRIES_ENABLED === 'true' && Boolean(env.DB && env.TURNSTILE_SECRET_KEY && env.RATE_LIMIT_SECRET && env.TURNSTILE_SITE_KEY);

async function readBody(request: Request): Promise<unknown> {
  const max = 12 * 1024;
  if (Number(request.headers.get('Content-Length')) > max) throw new RequestError(413, 'too_large');
  if (!request.body) throw new RequestError(422, 'invalid');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new RequestError(413, 'too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(422, 'invalid'); }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function normalize(value: unknown): { brief: Brief; token: string } {
  if (!object(value)) throw new RequestError(422, 'invalid');
  const field = (name: string, max: number, required = true) => {
    const raw = value[name];
    if (typeof raw !== 'string' || raw.length > max) throw new RequestError(422, 'invalid');
    const text = raw.trim();
    if ((required && !text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new RequestError(422, 'invalid');
    return text;
  };
  const brief: Brief = {
    requestKey: field('requestKey', 36), email: field('email', 254), pageUrl: field('pageUrl', 500),
    market: field('market', 160), goal: field('goal', 400), issue: field('issue', 400, false),
    preferredTime: field('preferredTime', 160, false), locale: field('locale', 7),
    acknowledgementVersion: field('acknowledgementVersion', 20),
  };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(brief.requestKey)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(brief.email)
    || !['en', 'ko', 'ja', 'zh-hant', 'ru', 'fr'].includes(brief.locale)
    || brief.acknowledgementVersion !== '2026-09-23') throw new RequestError(422, 'invalid');
  try {
    const url = new URL(brief.pageUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error();
    brief.pageUrl = url.href;
  } catch { throw new RequestError(422, 'invalid'); }
  brief.requestKey = brief.requestKey.toLowerCase();
  return { brief, token: field('turnstileToken', 2048) };
}
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), n => n.toString(16).padStart(2, '0')).join('');
async function rateLimit(request: Request, env: Env, now: number) {
  // Cloudflare overwrites CF-Connecting-IP at the edge. Never persist raw addresses.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) throw new RequestError(503, 'unavailable');
  const window = Math.floor(now / 600);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RATE_LIMIT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bucket = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${window}:${ip}`)));
  const result = await env.DB.prepare(`INSERT INTO rate_limits(bucket, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1 RETURNING hits`).bind(bucket, (window + 2) * 600).first<{ hits: number }>();
  if (!result || result.hits > 10) throw new RequestError(429, 'rate_limited');
}
async function verify(token: string, env: Env, hostname: string) {
  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { throw new RequestError(503, 'unavailable'); }
  if (!response.ok) throw new RequestError(503, 'unavailable');
  const result: unknown = await response.json();
  if (!object(result) || result.success !== true || result.hostname !== hostname || result.action !== 'enquiry') {
    throw new RequestError(403, 'verification');
  }
}
async function receive(request: Request, env: Env, url: URL) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
  if (!ready(env)) throw new RequestError(503, 'unavailable');
  if (!hosts(env).includes(url.hostname) || request.headers.get('Origin') !== url.origin) throw new RequestError(403, 'forbidden');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError(415, 'invalid');
  const now = Math.floor(Date.now() / 1000);
  await rateLimit(request, env, now);
  const { brief, token } = normalize(await readBody(request));
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(brief))));
  // Matching retries can safely recover a lost receipt even if their original Turnstile token expired.
  const lookup = () => env.DB.prepare('SELECT id, payload_hash FROM enquiries WHERE request_key = ?').bind(brief.requestKey).first<{ id: string; payload_hash: string }>();
  const previous = await lookup();
  if (previous) {
    if (previous.payload_hash !== hash) throw new RequestError(409, 'conflict');
    return reply(200, { id: previous.id, status: 'received' });
  }
  await verify(token, env, url.hostname);
  const id = `MSC-${crypto.randomUUID()}`;
  const days = Number(env.RETENTION_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new RequestError(503, 'unavailable');
  // Both rows commit together. Unique request_key handles concurrent submissions.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO enquiries(id, request_key, payload_hash, created_at, expires_at, locale,
      email, page_url, market, goal, issue, preferred_time, acknowledgement_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_key) DO NOTHING`)
      .bind(id, brief.requestKey, hash, now, now + days * 86400, brief.locale, brief.email, brief.pageUrl,
        brief.market, brief.goal, brief.issue, brief.preferredTime, brief.acknowledgementVersion),
    env.DB.prepare(`INSERT INTO notification_outbox(enquiry_id, next_attempt_at)
      SELECT id, ? FROM enquiries WHERE request_key = ? AND payload_hash = ?
      ON CONFLICT(enquiry_id) DO NOTHING`).bind(now, brief.requestKey, hash),
  ]);
  const saved = await lookup();
  if (!saved) throw new RequestError(503, 'unavailable');
  if (saved.payload_hash !== hash) throw new RequestError(409, 'conflict');
  return reply(saved.id === id ? 201 : 200, { id: saved.id, status: 'received' });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/enquiries/config' && request.method === 'GET') {
        const enabled = ready(env) && hosts(env).includes(url.hostname);
        return reply(200, { enabled, siteKey: enabled ? env.TURNSTILE_SITE_KEY : '', retentionDays: Number(env.RETENTION_DAYS) });
      }
      if (url.pathname !== '/api/enquiries') return reply(404, { error: 'not_found' });
      return await receive(request, env, url);
    } catch (error) {
      if (error instanceof RequestError) return reply(error.status, { error: error.code });
      // Never log submitted content, credentials or provider response bodies.
      console.error(JSON.stringify({ event: 'enquiry_receive_failed' }));
      return reply(503, { error: 'unavailable' });
    }
  },
  async scheduled(_event, env) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM enquiries WHERE expires_at <= ?').bind(now),
      env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now),
    ]);
    const pending = await env.DB.prepare("SELECT COUNT(*) AS total FROM notification_outbox WHERE state != 'sent'").first<{ total: number }>();
    console.log(JSON.stringify({ event: 'enquiry_maintenance', pendingNotifications: pending?.total ?? 0 }));
  },
} satisfies ExportedHandler<Env>;
