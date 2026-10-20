const {test} = require('node:test');
const assert = require('node:assert/strict');
const Controller = require('../webui/learning-controller.js');
const State = require('../webui/learning-state.js');
const Store = require('../webui/learning-store.js');
const View = require('../webui/learning-view.js');

const target={instance:'main',account:'alice',serial:'device',profile:'alice'};
const worker = (start=100, status='done', extra={}) => ({operation:{id:'op-'+start,revision:status === 'running' ? 2 : 3,status:status === 'done' ? 'awaiting_apply' : status === 'error' || status === 'stopped' ? 'failed' : status,context:target},running:status === 'running',
  state:{phases:{bootstrap:{started_at:start,status,kind:'full'}}},...extra});
function fixture(overrides={}) {
  const records=new Map(), calls=[], changes=[];
  let config={active_instance:'main',active_profile:'alice',instances:{main:{account:'alice',serial:'device'}}};
  const storage={getItem:key=>records.get(key) ?? null,setItem:(key,value)=>records.set(key,value),removeItem:key=>records.delete(key)};
  const io={config:()=>config,storage,now:()=>100000,selectedRun:()=> 'bp_farm',
    status:async()=>({running:false,state:{}}),confirm:async()=>true,
    key:()=> 'request-1',start:async body=>{calls.push(['start',body]);return {operation:{...worker().operation,revision:1,status:'accepted'}};},apply:async body=>{calls.push(['apply']);return {operation:{...worker(Number(body.operation_id.split('-')[1])).operation,revision:5,status:'succeeded'}};},
    applySaved:async()=>calls.push(['saved']),readiness:async preset=>{calls.push(['readiness',preset]);return {ready:true};},
    wait:async()=>{},changed:s=>changes.push(s),...overrides};
  const flow=Controller.create(io), context=()=>Store.context(config), store=Store.create(storage);
  return {flow,io,calls,changes,records,context,store,
    switchProfile:()=>{config={...config,active_profile:'bob'};},
    intent:(kind='learning',start=100)=>store.save(context(),kind,{preset:'bp_farm',operationId:'op-'+start,revision:1,outcome:'accepted'})};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('learning consent, launch, observation and completion have legal transitions',async()=>{
  const p=fixture();
  assert.equal(await p.flow.learn(),true);
  assert.equal(p.flow.snapshot().phase,'waiting_for_worker');
  assert.deepEqual(p.calls[0][1],{bootstrap:true,flows:true,phases:'c,m',fresh:true,overwrite:false,allow_navigation:true,expected_context:{instance:'main',account:'alice',serial:'device',rendering:null,profile:'alice'},idempotency_key:'request-1',selected_run:'bp_farm'});
  await p.flow.observe(worker(100,'running'));
  await p.flow.observe(worker());
  assert.equal(p.flow.snapshot().phase,'ready');
  assert.deepEqual(p.flow.snapshot().history.map(h=>h.to),['confirming','checking','starting','waiting_for_worker','running','applying','checking_readiness','ready']);
  assert.equal(p.store.learning(p.context()).outcome,'succeeded');
  await p.flow.observe(worker());
  assert.equal(p.calls.filter(([name])=>name==='apply').length,1);
});

test('declining consent never checks or launches a worker',async()=>{
  const p=fixture({confirm:async()=>false,status:()=>{throw Error('unexpected status');}});
  await p.flow.learn();
  assert.equal(p.flow.snapshot().phase,'cancelled');
  assert.deepEqual(p.calls,[]);
});

test('duplicate commands share no extra consent or start effects',async()=>{
  const gate=deferred();let confirmations=0;
  const p=fixture({confirm:()=>{confirmations++;return gate.promise;}});
  const first=p.flow.learn();
  assert.equal(await p.flow.prepare('bp_other'),false);
  assert.equal(confirmations,1);
  gate.resolve(true);await first;
  assert.equal(p.calls.filter(([name])=>name==='start').length,1);
});

test('readiness without an explicit boolean cannot start battle preparation',async()=>{
  const p=fixture({readiness:async()=>({})});
  await p.flow.prepare('bp_farm');
  assert.equal(p.flow.snapshot().phase,'needs_attention');
  assert.equal(p.flow.snapshot().reason,'readiness_unknown');
  assert.deepEqual(p.calls,[]);
});

test('restoration blocks completion and resumes only when confirmed clear',async()=>{
  const p=fixture();p.intent();
  await p.flow.observe(worker(100,'done',{restore_pending:true}));
  assert.equal(p.flow.snapshot().phase,'restoration_required');
  assert.deepEqual(p.calls,[]);
  await p.flow.observe(worker());
  assert.equal(p.flow.snapshot().phase,'ready');
});

test('unavailable status preserves phase and last confirmed observation time',async()=>{
  const p=fixture();p.intent();
  await p.flow.observe(worker(100,'running'));
  const before=p.flow.snapshot();
  p.flow.unavailable(Error('offline'));
  assert.equal(p.flow.snapshot().phase,'running');
  assert.equal(p.flow.snapshot().freshness,'unavailable');
  assert.equal(p.flow.snapshot().checkedAt,before.checkedAt);
  await p.flow.observe(worker());
  assert.equal(p.flow.snapshot().freshness,'confirmed');
});

test('changing profile during consent prevents a launch',async()=>{
  const gate=deferred(),p=fixture({confirm:()=>gate.promise});
  const job=p.flow.learn();p.switchProfile();gate.resolve(true);await job;
  assert.equal(p.flow.snapshot().phase,'superseded');
  assert.deepEqual(p.calls,[]);
});

test('changing profile during apply prevents readiness and preserves old intent',async()=>{
  const gate=deferred(),p=fixture({apply:()=>gate.promise});p.intent();
  const job=p.flow.observe(worker());p.switchProfile();gate.resolve({operation:{...worker().operation,revision:5,status:'succeeded'}});await job;
  assert.equal(p.flow.snapshot().phase,'superseded');
  assert.deepEqual(p.calls,[]);
  assert.equal(p.records.size,1);
});

test('preparation completion leaves a newer learning request untouched',async()=>{
  const p=fixture();p.intent('preparation',100);p.intent('learning',200);
  const key=Store.learningKey(p.context()),saved=p.records.get(key);
  await p.flow.observe(worker());
  assert.equal(p.flow.snapshot().phase,'ready');
  assert.equal(p.records.get(key),saved);
  assert.equal(p.store.pending(p.context()).outcome,'succeeded');
});

test('a worker replacement during apply prevents old readiness and completion',async()=>{
  const gate=deferred(),p=fixture({apply:()=>gate.promise});p.intent();
  const job=p.flow.observe(worker());
  p.intent('learning',200);
  const replacement=p.flow.observe(worker(200,'running'));
  gate.resolve({operation:{...worker().operation,revision:5,status:'succeeded'}});await job;await replacement;
  assert.equal(p.flow.snapshot().phase,'superseded');
  assert.deepEqual(p.calls,[]);
  assert.equal(p.store.learning(p.context()).operationId,'op-200');
  await p.flow.observe(worker(200,'running'));
  assert.equal(p.flow.snapshot().operationId,'op-200');
  assert.equal(p.flow.snapshot().phase,'running');
});

test('replacing a busy request within five seconds keeps the replacement record',async()=>{
  const busy=Object.assign(Error('Another action is in progress; wait for its result'),{status:409});
  const p=fixture({apply:async()=>{throw busy;}});p.intent('preparation',100);
  await p.flow.observe(worker());
  p.intent('preparation',102);
  await p.flow.observe(worker(102,'running'));
  assert.equal(p.store.pending(p.context()).operationId,'op-102');
  assert.equal(p.flow.snapshot().phase,'running');
});

test('legacy unscoped learning gets an explicit recovery state without applying',async()=>{
  const p=fixture();p.records.set('finishFullSetup','1');
  await p.flow.observe(worker());
  assert.equal(p.flow.snapshot().phase,'idle');
  assert.equal(p.records.get('finishFullSetup'),'1');
  assert.deepEqual(p.calls,[]);
});

test('the state boundary rejects invalid transitions and cross-flow branches',()=>{
  const state=State.create(()=>100);
  state.begin('learning','context');
  assert.throws(()=>state.transition('ready'),/Invalid/);
  assert.throws(()=>state.transition('editing_equipment'),/Only run preparation/);
  assert.equal(state.snapshot().phase,'idle');
  assert.equal(Object.isFrozen(state.snapshot().history),true);
});

test('a preparation status outage keeps its pending worker and resumes from observation',async()=>{
  let reads=0;
  const p=fixture({status:async()=>{if (reads++) throw Error('offline');return {running:false,state:{}};},
    readiness:async()=>({ready:false,message:'Need battle controls'})});
  await p.flow.prepare('bp_farm');
  assert.equal(p.flow.snapshot().phase,'waiting_for_worker');
  assert.equal(p.flow.snapshot().freshness,'unavailable');
  assert.equal(p.store.pending(p.context()).preset,'bp_farm');
  await p.flow.observe(worker(100,'running'));
  assert.equal(p.flow.snapshot().phase,'running');
  assert.equal(p.flow.snapshot().freshness,'confirmed');
});

test('feedback states game requirements per step and keeps unavailable status visible',()=>{
  const base={flow:'learning',message:'Reading screens'};
  assert.match(View.text({...base,phase:'confirming'}),/Game: open at Home, with no battle or tournament/);
  assert.match(View.text({...base,phase:'running',freshness:'unavailable'}),/keep it running.*Status unavailable/);
  assert.match(View.text({...base,phase:'checking_readiness'}),/Game: not required for this data step/);
  assert.match(View.text({...base,flow:'preparation',phase:'capture_required'}),/Run preparation.*open the requested screen/);
  assert.equal(View.text(null),'');
});

test('a late older worker observation cannot replace the tracked operation',async()=>{
  const p=fixture();p.intent('preparation',200);
  await p.flow.observe(worker(200,'running'));
  await p.flow.observe({...worker(100,'running'),state:{phases:{bootstrap:{started_at:100,status:'running',kind:'battle'}}}});
  assert.equal(p.flow.snapshot().operationId,'op-200');
  assert.equal(p.store.pending(p.context()).operationId,'op-200');
});

test('binding a started preparation cannot overwrite another tab’s newer request',async()=>{
  const gate=deferred();let reads=0;
  const p=fixture({status:()=>reads++ ? gate.promise : Promise.resolve({running:false,state:{}}),readiness:async()=>({ready:false})});
  const job=p.flow.prepare('bp_farm');
  while (reads<2) await new Promise(resolve=>setImmediate(resolve));
  p.intent('preparation',200);
  gate.resolve(worker());await job;
  assert.equal(p.store.pending(p.context()).operationId,'op-200');
  assert.equal(p.flow.snapshot().phase,'superseded');
  assert.equal(p.calls.filter(([name])=>name==='apply').length,0);
});

test('a definitive launch refusal cannot authorize a later unrelated completion',async()=>{
  const p=fixture({readiness:async()=>({ready:false}),start:async()=>{throw Object.assign(Error('Busy'),{status:409});}});
  await p.flow.prepare('bp_farm');
  assert.equal(p.store.pending(p.context()),null);
  await p.flow.observe(worker(110));
  assert.equal(p.calls.filter(([name])=>name==='apply').length,0);
});

test('late running state for an already completed worker cannot re-arm completion',async()=>{
  const p=fixture();p.intent('preparation');
  const battle=status=>worker(100,status);
  await p.flow.observe(battle('running'));
  await p.flow.observe(battle('done'));
  await p.flow.observe(battle('running'));
  await p.flow.observe(battle('done'));
  assert.equal(p.flow.snapshot().phase,'ready');
  assert.equal(p.calls.filter(([name])=>name==='apply').length,1);
});

test('a learning launch result cannot overwrite another tab’s newer request',async()=>{
  const gate=deferred(),p=fixture({start:()=>gate.promise});
  const job=p.flow.learn();
  while (p.flow.snapshot().phase !== 'starting') await new Promise(resolve=>setImmediate(resolve));
  p.intent('learning',200);gate.resolve({operation:worker().operation});await job;
  assert.equal(p.store.learning(p.context()).operationId,'op-200');
});

test('explicit review resolves a legacy marker once without starting a worker',async()=>{
  const p=fixture({status:async()=>worker()});p.records.set('finishFullSetup','1');
  await p.flow.observe(worker());
  assert.equal(await p.flow.review(),true);
  assert.equal(p.records.has('finishFullSetup'),false);
  assert.equal(p.flow.snapshot().phase,'ready');
  await p.flow.observe(worker());
  assert.deepEqual(p.calls,[['apply'],['readiness','bp_farm']]);
});

test('manual review applies the displayed operation and scopes success to the selected run',async()=>{
  const reads=[];
  const p=fixture({activeOperation:()=> 'op-200',status:async id=>{reads.push(id);return worker(200,'failed');},
    apply:async()=>({applied:true,operation:{...worker(200,'failed').operation,revision:9,result_refs:{apply_status:'succeeded',apply_error:null}}})});
  assert.equal(await p.flow.review(),true);
  assert.deepEqual(reads,['op-200']);
  assert.equal(p.store.learning(p.context()).operationId,'op-200');
  assert.equal(p.store.learning(p.context()).outcome,'failed');
  assert.equal(p.store.learning(p.context()).applied,true);
  assert.deepEqual(p.calls,[['readiness','bp_farm']]);
  assert.match(p.flow.snapshot().message,/Discoveries saved.*selected run is ready/);
  assert.doesNotMatch(p.flow.snapshot().message,/Screens learned|Setup done/);
  assert.equal(p.calls.filter(([name])=>name==='start').length,0);
});

for(const status of ['failed','interrupted']){
  test('reconnecting to an applied '+status+' capture checks readiness without applying again',async()=>{
    const p=fixture();p.intent('preparation');
    const observed=worker(100,status);
    observed.operation.result_refs={apply_status:'succeeded',apply_error:null};
    await p.flow.observe(observed);
    assert.equal(p.flow.snapshot().phase,'ready');
    assert.equal(p.store.pending(p.context()).outcome,status);
    assert.equal(p.store.pending(p.context()).applied,true);
    await p.flow.observe(observed);
    assert.deepEqual(p.calls,[['readiness','bp_farm']]);
  });
}

test('an explicit failed apply cannot be accepted from the top-level success status',async()=>{
  const p=fixture({status:async()=>worker(),apply:async()=>({operation:{...worker(100,'succeeded').operation,result_refs:{apply_status:'failed'}}})});
  assert.equal(await p.flow.review(),false);
  assert.equal(p.flow.snapshot().phase,'failed');
  assert.deepEqual(p.calls,[]);
});

test('manual review never applies a different operation or target returned by status',async()=>{
  for(const result of [worker(100), {...worker(200),operation:{...worker(200).operation,context:{...target,account:'other'}}}]){
    const p=fixture({activeOperation:()=> 'op-200',status:async()=>result});
    assert.equal(await p.flow.review(),false);
    assert.equal(p.flow.snapshot().phase,'superseded');
    assert.deepEqual(p.calls,[]);
  }
});

test('changing the displayed operation while review is loading prevents apply',async()=>{
  let active='op-200';const gate=deferred();
  const p=fixture({activeOperation:()=>active,status:()=>gate.promise});
  const job=p.flow.review();active='op-300';gate.resolve(worker(200));
  assert.equal(await job,false);
  assert.equal(p.flow.snapshot().phase,'superseded');
  assert.deepEqual(p.calls,[]);
});

test('superseding manual review keeps its legacy marker until a successful review',async()=>{
  const gate=deferred(),p=fixture({status:async()=>worker(),apply:()=>gate.promise});
  p.records.set('finishFullSetup','1');
  const job=p.flow.review();
  while (p.flow.snapshot().phase !== 'applying') await new Promise(resolve=>setImmediate(resolve));
  p.intent('learning',200);
  await p.flow.observe(worker(200,'running'));
  assert.equal(p.records.get('finishFullSetup'),'1');
  gate.resolve({operation:{...worker().operation,revision:5,status:'succeeded'}});await job;
  assert.equal(p.flow.snapshot().phase,'superseded');
  assert.equal(p.records.get('finishFullSetup'),'1');
});

test('manual review waiting on a busy apply clears the legacy marker only after retry succeeds',async()=>{
  let busy=true;
  const p=fixture({status:async()=>worker(),apply:async()=>{if(busy)throw Object.assign(Error('Another action is in progress'),{status:409});return {operation:{...worker().operation,revision:5,status:'succeeded'}};}});
  p.records.set('finishFullSetup','1');
  await p.flow.review();
  assert.equal(p.records.get('finishFullSetup'),'1');
  assert.equal(p.flow.snapshot().phase,'waiting_to_apply');
  busy=false;await p.flow.observe(worker());
  assert.equal(p.records.has('finishFullSetup'),false);
  assert.equal(p.flow.snapshot().phase,'ready');
});

for (const phase of ['running','waiting_for_worker','waiting_to_apply','restoration_required']) {
  test('another tab application advances '+phase+' directly to readiness without reapplying',async()=>{
    let applications=0;
    const p=fixture({apply:async()=>{applications++;throw Object.assign(Error('Another action is in progress'),{status:409});}});
    p.intent('preparation');
    if (phase === 'waiting_to_apply') await p.flow.observe(worker());
    else {
      const status=phase === 'waiting_for_worker' ? 'accepted' : phase;
      await p.flow.observe({...worker(100,'running'),operation:{...worker(100,'running').operation,status}});
    }
    assert.equal(p.flow.snapshot().phase,phase);
    const before=applications;
    await p.flow.observe({running:false,operation:{...worker().operation,status:'succeeded',revision:5}});
    assert.equal(p.flow.snapshot().phase,'ready');
    assert.equal(p.flow.snapshot().revision,5);
    assert.equal(p.flow.snapshot().freshness,'confirmed');
    assert.equal(applications,before);
    assert.deepEqual(p.calls,[['readiness','bp_farm']]);
    assert.equal(p.store.pending(p.context()).outcome,'succeeded');
    assert.deepEqual(p.flow.snapshot().history.slice(-2).map(row=>row.to),['checking_readiness','ready']);
  });
}
