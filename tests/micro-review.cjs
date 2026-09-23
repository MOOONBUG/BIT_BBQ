const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, brief } = require('./receiver.cjs');
(async () => {
 const {mf,db} = await setup(); let ip=0; const checks=[];
 const send = data => mf.dispatchFetch('http://localhost/api/enquiries',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','CF-Connecting-IP':`192.0.2.${++ip}`},body:JSON.stringify(data)});
 const trial = patch => brief({serviceType:'free_trial',policyVersion:'micro-2026-09-23',...patch});
 const check = async(name,fn)=>{await fn();checks.push(name);console.log('PASS',name)};
 const getConfig=async()=> (await mf.dispatchFetch('http://localhost/api/free-reviews/config')).json();
 try {
 await check('invalid service and stale policy rejected',async()=>{
  assert.equal((await send(trial({serviceType:'admin'}))).status,422);
  assert.equal((await send(trial({policyVersion:'old'}))).status,422);
 });
 let firstId, firstPayload;
 await check('trial reception stores policy and does not trust client selection',async()=>{
  firstPayload=trial({review_status:'selected',selection_week:'2026-09-21'});
  const response=await send(firstPayload);assert.equal(response.status,201); firstId=(await response.json()).id;
  const row=await db.prepare('SELECT * FROM free_reviews WHERE enquiry_id=?').bind(firstId).first();
  assert.equal(row.review_status,'received');assert.equal(row.delivery_language,'en');assert.equal(row.policy_version,'micro-2026-09-23');assert.equal(row.selection_week,null);
  assert.equal((await db.prepare('SELECT service_type FROM enquiries WHERE id=?').bind(firstId).first()).service_type,'free_trial');
 });
 await check('duplicate marker internal only; no existing reference leaks',async()=>{
  const res=await send(trial({email:'OWNER@example.com',pageUrl:'https://example.com/products/cups/?utm_source=test#top'}));assert.equal(res.status,201);
  const data=await res.json();assert.notEqual(data.id,firstId);assert.deepEqual(Object.keys(data).sort(),['id','status']);
  assert.equal((await db.prepare('SELECT duplicate_candidate FROM free_reviews WHERE enquiry_id=?').bind(data.id).first()).duplicate_candidate,1);
 });
 await check('concurrent intake cannot exceed pending cap, no orphan enquiries/outbox',async()=>{
  const results=await Promise.all(Array.from({length:8},(_,i)=>send(trial({email:`new${i}@example.com`}))));
  assert.equal(results.filter(r=>r.status===201).length,3);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM free_reviews').first()).n,5);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM enquiries WHERE service_type='free_trial'").first()).n,5);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM notification_outbox').first()).n,5);
  assert.equal((await getConfig()).enabled,false);
  const retry=await send({...firstPayload,turnstileToken:'invalid-token'});assert.equal(retry.status,200);assert.equal((await retry.json()).id,firstId);
  assert.equal((await send(brief())).status,201);
 });
 await check('weekly selection capacity is enforced atomically and invalid weeks rejected',async()=>{
  const ids=(await db.prepare('SELECT enquiry_id FROM free_reviews').all()).results.map(r=>r.enquiry_id);
  await assert.rejects(()=>db.prepare("UPDATE free_reviews SET review_status='selected' WHERE enquiry_id=?").bind(ids[0]).run());
  await assert.rejects(()=>db.prepare("UPDATE free_reviews SET review_status='selected',selection_week='not-a-date' WHERE enquiry_id=?").bind(ids[0]).run());
  const results=await Promise.allSettled(ids.slice(0,3).map(id=>db.prepare("UPDATE free_reviews SET review_status='selected',selection_week='2026-09-21' WHERE enquiry_id=?").bind(id).run()));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM review_slots').first()).n,2);
  const selected=(await db.prepare("SELECT enquiry_id FROM free_reviews WHERE review_status='selected' LIMIT 1").first()).enquiry_id;
  await db.prepare("UPDATE free_reviews SET review_status='withdrawn' WHERE enquiry_id=?").bind(selected).run();
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM review_slots').first()).n,2);
  assert.equal((await getConfig()).enabled,true);
 });
 await check('manual pause independent of paid reception; retry still recovers',async()=>{
  await db.exec('UPDATE review_campaigns SET enabled=0;');
  assert.equal((await getConfig()).enabled,false);
  const res=await send(trial({email:'paused@example.com'}));assert.equal(res.status,503);assert.equal((await res.json()).error,'paused');
  assert.equal((await send(brief())).status,201);
  assert.equal((await send(firstPayload)).status,200);
 });
 await check('expiry cascades review metadata and slots',async()=>{
  await db.exec('UPDATE enquiries SET expires_at=0;');
  await mf.dispatchFetch('http://localhost/__test/scheduled');
  for(const table of ['enquiries','free_reviews','review_slots','notification_outbox'])assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,0);
 });
 fs.mkdirSync(path.resolve(__dirname,'../review-logs'),{recursive:true});
 fs.writeFileSync(path.resolve(__dirname,'../review-logs/micro-receiver-results.json'),JSON.stringify({passed:true,checks,environment:'Local workerd + D1; mocked Turnstile; no production writes'},null,2));
 } finally {await mf.dispose()}
})().catch(e=>{console.error(e);process.exit(1)});
