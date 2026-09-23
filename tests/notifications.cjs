const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { build } = require(require.resolve('esbuild', { paths: [path.join(root, 'node_modules/wrangler')] }));
const { Miniflare, convertV4MiniflareOptions } = require(require.resolve('miniflare', { paths: [path.join(root, 'node_modules/wrangler')] }));

(async () => {
  const built = await build({ stdin: { contents: `import worker from './worker/index.ts';
    export default { async fetch(request,bindings,ctx) {
      const env = {...bindings};
      const mode = new URL(request.url).pathname;
      if(mode==='/disabled')env.NOTIFICATIONS_ENABLED='false';
      if(mode==='/missing')env.ZOHO_CLIENT_SECRET='';
      if(mode==='/bad-region')env.ZOHO_REGION='evil.example';
      if(mode==='/bad-recipient')env.NOTIFICATION_TO='a@example.com,b@example.com';
      if(mode==='/bad-start')env.NOTIFICATIONS_START_AT='';
      await worker.scheduled({cron:'*/5 * * * *'},env,ctx); return new Response('ok');
    }};`, resolveDir: root }, bundle: true, format: 'esm', write: false, platform: 'browser' });
  const now = Math.floor(Date.now() / 1000);
  let mode = 'ok', mailCalls = [], tokenCalls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2024-11-01', d1Databases: ['DB'], bindings: {
      NOTIFICATIONS_ENABLED: 'true', NOTIFICATIONS_START_AT: String(now - 100),
      ZOHO_REGION: 'com', ZOHO_ACCOUNT_ID: '123', ZOHO_CLIENT_ID: 'test-client',
      ZOHO_CLIENT_SECRET: 'test-secret', ZOHO_REFRESH_TOKEN: 'test-refresh',
      NOTIFICATION_FROM: 'operator@example.com', NOTIFICATION_TO: 'owner@example.com',
    }, outboundService: async request => {
      if (request.url === 'https://accounts.zoho.com/oauth/v2/token') {
        tokenCalls++;
        assert.equal(new URLSearchParams(await request.text()).get('grant_type'), 'refresh_token');
        return mode === 'auth' ? Response.json({ error: 'invalid_client' }) : Response.json({ access_token: 'test-access' });
      }
      assert.equal(request.url, 'https://mail.zoho.com/api/accounts/123/messages');
      assert.equal(request.headers.get('Authorization'), 'Zoho-oauthtoken test-access');
      mailCalls.push(await request.json());
      if (mode === '429') return new Response('', { status: 429, headers: { 'Retry-After': '900' } });
      if (mode === '401') return new Response('', { status: 401 });
      if (mode === '500') return new Response('', { status: 500 });
      if (mode === '400') return new Response('', { status: 400 });
      if (mode === 'invalid') return new Response('not JSON');
      if (mode === 'oversize') return new Response('x'.repeat(40000));
      if (mode === 'empty-success') return Response.json({ status: { code: 200 } });
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 50));
      return Response.json({ status: { code: 200 }, data: { messageId: '1234567890123456789' } });
    } }));
  const db = await mf.getD1Database('DB');
  const run = (route = '/') => mf.dispatchFetch(`http://localhost${route}`);
  const row = id => db.prepare('SELECT * FROM notification_outbox WHERE enquiry_id=?').bind(id).first();
  const reset = async () => { await db.exec('DELETE FROM enquiries'); mailCalls = []; tokenCalls = 0; mode = 'ok'; };
  const seed = async ({ id = `MSC-${randomUUID()}`, created = now, expires = now + 86400, type = 'paid_enquiry' } = {}) => {
    await db.prepare(`INSERT INTO enquiries(id,request_key,payload_hash,created_at,expires_at,locale,email,page_url,market,goal,acknowledgement_version,service_type)
      VALUES(?,?,?, ?,?,'fr','private-customer@example.com','https://private.example/','private market','private goal','2026-09-23',?)`)
      .bind(id, randomUUID(), 'hash', created, expires, type).run();
    await db.prepare('INSERT INTO notification_outbox(enquiry_id,next_attempt_at) VALUES(?,?)').bind(id, now - 1).run();
    return id;
  };
  const check = async (name, fn) => { await reset(); await fn(); console.log('PASS', name); };
  try {
    for (const file of ['0001_enquiries.sql', '0002_micro_reviews.sql'])
      await db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8').replace(/^--.*$/gm, '').replace(/\s+/g, ' '));
    await check('disabled and incomplete configuration never claim or send', async () => {
      const id = await seed();
      for (const route of ['/disabled', '/missing', '/bad-region', '/bad-recipient', '/bad-start']) await run(route);
      assert.equal(tokenCalls, 0); assert.equal(mailCalls.length, 0); assert.equal((await row(id)).attempts, 0);
    });
    await check('operator-only content and successful receipt recorded once', async () => {
      const id = await seed({ type: 'free_trial' }); await run(); await run();
      assert.equal(mailCalls.length, 1); assert.equal((await row(id)).state, 'sent');
      assert.equal((await row(id)).provider_message_id, '1234567890123456789');
      const payload = mailCalls[0]; assert.equal(payload.toAddress, 'owner@example.com');
      assert.equal(payload.mailFormat, 'plaintext'); assert.match(payload.subject, /free review/);
      assert.match(payload.content, /fr/); assert.doesNotMatch(JSON.stringify(payload), /private|test-secret|test-refresh/);
    });
    await check('historical, expired and internal-test entries excluded', async () => {
      const ids = [await seed({ created: now - 101 }), await seed({ expires: now - 1 }),
        await seed({ id: 'MSC-51e08077-c0ac-49a4-aad4-b722de0bdb4f' })];
      await run(); assert.equal(mailCalls.length, 0); assert.equal(tokenCalls, 0);
      for (const id of ids) assert.equal((await row(id)).attempts, 0);
    });
    await check('token failure preserves pending work', async () => {
      const id = await seed(); mode = 'auth'; await run();
      assert.equal((await row(id)).state, 'pending'); assert.equal((await row(id)).attempts, 0); assert.equal(mailCalls.length, 0);
    });
    for (const rejection of ['429', '401']) await check(`explicit ${rejection} rejection retries with backoff, then stops at limit`, async () => {
      const id = await seed(); mode = rejection; await run();
      let result = await row(id); assert.equal(result.state, 'pending');
      assert.ok(result.next_attempt_at >= now + (rejection === '429' ? 900 : 300));
      await run(); assert.equal(mailCalls.length, 1);
      await db.prepare('UPDATE notification_outbox SET attempts=4,next_attempt_at=0 WHERE enquiry_id=?').bind(id).run();
      await run(); result = await row(id); assert.equal(result.state, 'failed'); assert.equal(result.attempts, 5);
    });
    for (const failure of ['500', 'invalid', 'oversize', 'empty-success', '400']) await check(`${failure} does not blindly resend`, async () => {
      const id = await seed(); mode = failure; await run(); await run();
      assert.equal(mailCalls.length, 1); assert.equal((await row(id)).state, 'failed');
      assert.equal((await row(id)).last_error_code, failure === '400' ? 'http_400' : 'delivery_unknown');
    });
    await check('expired sending lease requires manual reconciliation', async () => {
      const id = await seed();
      await db.prepare("UPDATE notification_outbox SET state='sending',attempts=1,lease_until=? WHERE enquiry_id=?").bind(now - 1, id).run();
      await run(); assert.equal((await row(id)).last_error_code, 'delivery_unknown'); assert.equal(mailCalls.length, 0);
    });
    await check('concurrent cron invocations do not send the same row twice', async () => {
      const id = await seed(); mode = 'slow'; await Promise.all([run(), run(), run()]);
      assert.equal(mailCalls.length, 1); assert.equal((await row(id)).attempts, 1); assert.equal((await row(id)).state, 'sent');
    });
    await check('each cron batch is bounded to three messages', async () => {
      for (let i = 0; i < 5; i++) await seed(); await run(); assert.equal(mailCalls.length, 3);
      await run(); assert.equal(mailCalls.length, 5);
    });
  } finally { await mf.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
