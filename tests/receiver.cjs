const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { build } = require(require.resolve('esbuild', { paths: [path.join(root, 'node_modules/wrangler')] }));
const { Miniflare, convertV4MiniflareOptions } = require(require.resolve('miniflare', { paths: [path.join(root, 'node_modules/wrangler')] }));
async function setup() {
  // Test-only adapter invokes the actual scheduled handler; never included in a deployment build.
  const built = await build({ stdin: { contents: `import worker from './worker/index.ts';
    export default { ...worker, async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/__test/scheduled') { await worker.scheduled(undefined, env, ctx); return new Response('ok'); }
      return worker.fetch(request, env, ctx);
    }};`, resolveDir: root }, bundle: true, format: 'esm', write: false, platform: 'browser' });
  const mock = async request => {
    assert.equal(request.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const token = new URLSearchParams(await request.text()).get('response');
    if (token === 'provider-down') return new Response(null, { status: 503 });
    return Response.json({ success: token !== 'invalid-token', hostname: token === 'wrong-host' ? 'evil.example' : 'localhost', action: token === 'wrong-action' ? 'other' : 'enquiry' });
  };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2024-11-01',
    d1Databases: ['DB'], outboundService: mock, bindings: { ENQUIRIES_ENABLED: 'true', TURNSTILE_SITE_KEY: 'test-only',
      TURNSTILE_SECRET_KEY: 'test-only', RATE_LIMIT_SECRET: 'test-only-long-secret', ALLOWED_HOSTS: 'localhost', RETENTION_DAYS: '90' },
    serviceBindings: { ASSETS: () => new Response('static asset') } }));
  const db = await mf.getD1Database('DB');
  const schema = fs.readFileSync(path.join(root, 'migrations/0001_enquiries.sql'), 'utf8').replace(/^--.*$/gm, '').replace(/\s+/g, ' ');
  await db.exec(schema);
  return { mf, db, mock };
}
const brief = (patch = {}) => ({ requestKey: randomUUID(), email: 'owner@example.com', pageUrl: 'https://example.com/products/cups',
  market: 'US / English', goal: 'Clarify the quantity', issue: '', preferredTime: '', locale: 'en',
  acknowledgementVersion: '2026-09-23', turnstileToken: 'valid-token', ...patch });
async function run() {
  const { mf, db } = await setup(); let ip = 0;
  const send = (payload, options = {}) => mf.dispatchFetch('http://localhost/api/enquiries', { method: 'POST',
    headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${++ip}`, ...options.headers },
    body: JSON.stringify(payload) });
  const checks = [];
  const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS', name); };
  try {
    await check('assets and public configuration', async () => {
      assert.equal(await (await mf.dispatchFetch('http://localhost/')).text(), 'static asset');
      const config = await (await mf.dispatchFetch('http://localhost/api/enquiries/config')).json();
      assert.equal(config.enabled, true); assert.equal('TURNSTILE_SECRET_KEY' in config, false);
      assert.equal((await mf.dispatchFetch('http://localhost/api/enquiries')).status, 405);
      assert.equal((await mf.dispatchFetch('http://localhost/api/unknown')).status, 404);
    });
    await check('durable reception and pending notification', async () => {
      const data = brief(); const response = await send(data); assert.equal(response.status, 201);
      const receipt = await response.json(); assert.equal(receipt.status, 'received');
      const row = await db.prepare('SELECT * FROM enquiries WHERE id = ?').bind(receipt.id).first();
      assert.equal(row.email, data.email); assert.equal(row.expires_at - row.created_at, 90 * 86400);
      assert.equal((await db.prepare('SELECT state FROM notification_outbox WHERE enquiry_id = ?').bind(receipt.id).first()).state, 'pending');
      const retry = await send({ ...data, turnstileToken: 'invalid-token' });
      assert.equal(retry.status, 200); assert.equal((await retry.json()).id, receipt.id);
      assert.equal((await send({ ...data, goal: 'Changed' })).status, 409);
    });
    await check('concurrent retries share one saved record', async () => {
      const data = brief();
      const responses = await Promise.all(Array.from({ length: 4 }, () => send(data)));
      assert.ok(responses.every(r => [200, 201].includes(r.status)));
      const receipts = await Promise.all(responses.map(r => r.json()));
      assert.equal(new Set(receipts.map(r => r.id)).size, 1);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM enquiries WHERE request_key = ?').bind(data.requestKey).first()).n, 1);
    });
    await check('invalid fields and oversized body rejected', async () => {
      for (const patch of [{ email: 'bad' }, { pageUrl: 'javascript:alert(1)' }, { pageUrl: 'https://user:pass@example.com' },
        { market: '  ' }, { goal: 'a'.repeat(401) }, { locale: 'zz' }, { acknowledgementVersion: '' }, { requestKey: 'bad' }]) {
        assert.equal((await send(brief(patch))).status, 422, JSON.stringify(patch));
      }
      assert.equal((await send(brief({ issue: 'x'.repeat(13000) }))).status, 413);
      const res = await mf.dispatchFetch('http://localhost/api/enquiries', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.99' }, body: '{' });
      assert.equal(res.status, 422);
    });
    await check('origin, type, verification hostname and action enforced', async () => {
      assert.equal((await send(brief(), { headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal((await send(brief(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
      for (const token of ['invalid-token', 'wrong-host', 'wrong-action']) assert.equal((await send(brief({ turnstileToken: token }))).status, 403);
      assert.equal((await send(brief({ turnstileToken: 'provider-down' }))).status, 503);
    });
    await check('rate limit is atomic and does not store raw IP', async () => {
      const data = brief(); const opts = { headers: { 'CF-Connecting-IP': '198.51.100.77' } };
      for (let i = 0; i < 10; i++) assert.ok([200, 201].includes((await send(data, opts)).status));
      const limited = await send(data, opts); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '600');
      const rows = await db.prepare('SELECT bucket FROM rate_limits').all();
      assert.ok(rows.results.every(row => /^[0-9a-f]{64}$/.test(row.bucket)));
    });
    await check('transaction failure never produces a success receipt', async () => {
      await db.exec("CREATE TRIGGER break_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT, 'test'); END;");
      const data = brief(); assert.equal((await send(data)).status, 503);
      assert.equal(await db.prepare('SELECT id FROM enquiries WHERE request_key = ?').bind(data.requestKey).first(), null);
      await db.exec('DROP TRIGGER break_outbox;');
    });
    await check('scheduled expiry deletes enquiries, linked notifications and old rate buckets', async () => {
      const data = brief(); const id = (await (await send(data)).json()).id;
      await db.prepare('UPDATE enquiries SET expires_at = 0 WHERE id = ?').bind(id).run();
      await db.prepare('INSERT INTO rate_limits(bucket, hits, expires_at) VALUES (?, 1, 0)').bind('expired-test-bucket').run();
      assert.equal((await mf.dispatchFetch('http://localhost/__test/scheduled')).status, 200);
      assert.equal(await db.prepare('SELECT enquiry_id FROM notification_outbox WHERE enquiry_id = ?').bind(id).first(), null);
      assert.equal(await db.prepare('SELECT bucket FROM rate_limits WHERE bucket = ?').bind('expired-test-bucket').first(), null);
    });
    fs.writeFileSync(path.join(root, '../form-stage1-20260923/receiver-results.json'), JSON.stringify({ passed: true, checks, environment: 'Local workerd + D1 SQLite; Turnstile API mocked; no email sent' }, null, 2));
  } finally { await mf.dispose(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exit(1); });
module.exports = { setup, brief };
