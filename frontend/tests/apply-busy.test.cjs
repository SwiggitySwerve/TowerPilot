const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {section}=require('./helpers.cjs');
const Controller=require('../webui/learning-controller.js');
const Store=require('../webui/learning-store.js');
const config={active_instance:'main',active_profile:'alice',instances:{main:{account:'alice',serial:'device'}}};
const context={instance:'main',profile:'alice',account:'alice',serial:'device',selected_run:'bp_farm'};
const operation=(status='awaiting_apply',revision=3,id='operation-a')=>({id,status,revision,context});
const observed=(status='awaiting_apply',revision=3,id='operation-a',extra={})=>({running:status==='running',operation:operation(status,revision,id),...extra});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function page(overrides={},records=new Map()){
  const calls=[];
  const storage={getItem:k=>records.get(k) ?? null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
  const store=Store.create(storage),scope=Store.context(config);
  if (!records.size) store.save(scope,'preparation',{preset:'bp_farm',operationId:'operation-a',revision:1});
  const io={config:()=>config,storage,status:async()=>observed(),selectedRun:()=> 'bp_farm',
    apply:async body=>{calls.push(['apply',body]);return {operation:operation('succeeded',5)};},
    readiness:async preset=>{calls.push(['readiness',preset]);return {ready:true};},...overrides};
  return {flow:Controller.create(io),calls,store,scope,records};
}
test('an api refusal keeps its HTTP status',async()=>{
  const ctx=vm.createContext({S:{},fetch:async()=>({ok:false,status:409,json:async()=>({error:'busy'})})});
  vm.runInContext(section('async function api(','/* ---- profile patching'),ctx);
  await assert.rejects(ctx.api('/x'),{message:'busy',status:409});
});
test('a busy apply retains operation identity and retries only on another observation',async()=>{
  let busy=true,attempts=0;
  const p=page({apply:async body=>{attempts++;assert.deepEqual(body,{operation_id:'operation-a',expected_revision:3});if(busy)throw Object.assign(Error('Another action is in progress'),{status:409});return {operation:operation('succeeded',5)};}});
  await p.flow.observe(observed());
  assert.equal(p.flow.snapshot().phase,'waiting_to_apply');assert.equal(attempts,1);
  assert.equal(p.store.pending(p.scope).operationId,'operation-a');
  busy=false;await p.flow.observe(observed());
  assert.equal(attempts,2);assert.equal(p.flow.snapshot().phase,'ready');
  assert.equal(p.store.pending(p.scope).outcome,'succeeded');
});
for (const status of ['failed','interrupted','cancelled']) test(status+' never authorizes application',async()=>{
  const p=page();await p.flow.observe(observed(status));
  assert.equal(p.flow.snapshot().phase,'stopped');assert.deepEqual(p.calls,[]);
});
for (const status of ['accepted','running','cancelling','applying']) test(status+' never authorizes application',async()=>{
  const p=page();await p.flow.observe(observed(status));
  assert.deepEqual(p.calls,[]);assert.notEqual(p.flow.snapshot().phase,'ready');
});
for (const error of [Error('offline'),Object.assign(Error('server unavailable'),{status:500}),Object.assign(Error('profile revision changed'),{status:409})]) test('apply failure preserves discoveries: '+error.message,async()=>{
  const p=page({apply:async()=>{throw error;}});await p.flow.observe(observed());
  assert.equal(p.flow.snapshot().phase,'failed');assert.equal(p.store.pending(p.scope).operationId,'operation-a');
  assert.equal(p.calls.length,0);
});
test('readiness failure after confirmed apply retains succeeded outcome for reload without reapplying',async()=>{
  const p=page({readiness:async()=>{throw Error('offline');}});await p.flow.observe(observed());
  assert.equal(p.store.pending(p.scope).outcome,'succeeded');
  const reload=page({},p.records);await reload.flow.observe(observed('succeeded',5));
  assert.equal(reload.flow.snapshot().phase,'ready');assert.deepEqual(reload.calls,[['readiness','bp_farm']]);
});
test('duplicate completion while applying sends one exact operation command',async()=>{
  const gate=deferred();let applies=0;
  const p=page({apply:async()=>{applies++;return gate.promise;}});
  const first=p.flow.observe(observed());await p.flow.observe(observed());
  assert.equal(applies,1);gate.resolve({operation:operation('succeeded',5)});await first;
  await p.flow.observe(observed());assert.equal(applies,1);
});
test('a newer operation written during apply survives old completion without readiness',async()=>{
  const gate=deferred(),p=page({apply:()=>gate.promise});
  const old=p.flow.observe(observed());
  p.store.save(p.scope,'preparation',{preset:'bp_other',operationId:'operation-b',revision:1});
  await p.flow.observe(observed('running',2,'operation-b'));
  gate.resolve({operation:operation('succeeded',5)});await old;
  assert.equal(p.store.pending(p.scope).operationId,'operation-b');assert.deepEqual(p.calls,[]);
  await p.flow.observe(observed('running',2,'operation-b'));assert.equal(p.flow.snapshot().preset,'bp_other');
});
test('reversed observations never publish an older operation revision',async()=>{
  const p=page();await p.flow.observe(observed('running',4));await p.flow.observe(observed('awaiting_apply',3));
  assert.equal(p.flow.snapshot().revision,4);assert.deepEqual(p.calls,[]);
});
test('restoration must finish before a captured operation can apply',async()=>{
  const p=page();await p.flow.observe(observed('restoration_required',3,{},{restore_pending:true}));
  assert.deepEqual(p.calls,[]);
  await p.flow.observe(observed());assert.equal(p.flow.snapshot().phase,'ready');
});
test('another account cannot apply the saved operation',async()=>{
  const p=page();await p.flow.observe({...observed(),operation:{...operation(),context:{...context,account:'bob'}}});
  assert.deepEqual(p.calls,[]);assert.equal(p.flow.snapshot().phase,'idle');
});
test('an unrelated operation cannot adopt a pending operation reference',async()=>{
  const p=page();await p.flow.observe(observed('awaiting_apply',99,'unrelated'));
  assert.deepEqual(p.calls,[]);assert.equal(p.store.pending(p.scope).operationId,'operation-a');
});
test('unconfirmed apply response cannot produce readiness or consume discoveries',async()=>{
  const p=page({apply:async()=>({ok:true})});await p.flow.observe(observed());
  assert.equal(p.flow.snapshot().phase,'failed');assert.deepEqual(p.calls,[]);
  assert.equal(p.store.pending(p.scope).operationId,'operation-a');
});
