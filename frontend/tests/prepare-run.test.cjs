const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {html,section}=require('./helpers.cjs');
const LearningController=require('../webui/learning-controller.js');
const LearningStore=require('../webui/learning-store.js');
test('complete dashboard script parses before opening setup',()=>{
  new vm.Script(html.split('<script>')[1].split('</script>')[0]);
});
test('screen learning starts full setup and records a context-bound intent',async()=>{
  const requests=[]; const storage=new Map();
  const config={active_instance:'main',active_profile:'default',instances:{main:{account:'alice',serial:'one'}}};
  const flow=LearningController.create({
    config:()=>config,storage:{getItem:key=>storage.get(key) ?? null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    key:()=> 'request-1',now:()=>1234,selectedRun:()=> 'bp_farm',confirm:async()=>true,
    status:async()=>({running:false,state:{phases:{}}}),
    start:async body=>{requests.push(body);return {operation:{id:'op-1',revision:1,status:'accepted',context:{instance:'main',profile:'default',account:'alice',serial:'one'}}};},changed:()=>{},completed:async()=>{}
  });
  assert.equal(await flow.learn(),true);
  assert.deepEqual(requests,[{bootstrap:true,flows:true,phases:'c,m',fresh:true,overwrite:false,allow_navigation:true,expected_context:{instance:'main',account:'alice',serial:'one',rendering:null,profile:'default'},idempotency_key:'request-1',selected_run:'bp_farm'}]);
  const scope=LearningStore.context(config);
  const saved=JSON.parse(storage.get(LearningStore.learningKey(scope)));
  assert.equal(saved.context,scope.id);
  assert.equal(saved.operationId,'op-1');
  assert.equal(saved.revision,1);
  assert.equal(flow.snapshot().phase,'waiting_for_worker');
});

test('applied discoveries from a partial capture do not remain a pending preparation',()=>{
  const config={active_instance:'main',active_profile:'demo',instances:{main:{account:'demo'}}};
  const records=new Map(),storage={getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value)};
  const scope=LearningStore.context(config);
  LearningStore.create(storage).save(scope,'preparation',{outcome:'failed',applied:true});
  const ctx=vm.createContext({LearningStore,S:{config},localStorage:storage});
  vm.runInContext(section('function pendingPreparation(){','async function renderCalibrate(){'),ctx);
  assert.equal(ctx.pendingPreparation(),null);
});
function setup(ready){
  const calls=[]; const storage=new Map(); const config={active_instance:'main',instances:{main:{account:'alice',serial:'one'}}};
  const operation={id:'op-prepare',revision:3,status:'awaiting_apply',context:{instance:'main',account:'alice',serial:'one'}};
  let confirmResult=false; let asked=0; let started=false; const now=1_000_000;
  const flow=LearningController.create({
    config:()=>config,storage:{getItem:key=>storage.get(key) ?? null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    now:()=>now,selectedRun:()=> 'bp_farm',confirm:async()=>{asked++;return confirmResult;},
    status:async()=> started
      ? {operation,running:false,state:{phases:{bootstrap:{kind:'battle',status:'done',started_at:1000}}}}
      : {running:false,state:{player:{card_presets:['farm']}}},
    readiness:async()=> started && ready.ready === false && !ready.next_action ? {ready:true} : ready,
    applySaved:async()=>{calls.push('/api/calibrate/apply');return {};},
    apply:async()=>{calls.push('/api/calibrate/apply');return {operation:{...operation,revision:5,status:'succeeded'}};},
    start:async body=>{calls.push({path:'/api/calibrate/start',body});started=true;return {operation:{...operation,revision:1,status:'accepted'}};},
    wait:async()=>{},
    changed:()=>{},completed:async()=>{}
  });
  return {flow,calls,setConfirm:value=>{confirmResult=value;},getAsked:()=>asked};
}
test('completed observations are applied before readiness; ready run starts no scan',async()=>{
  const {flow,calls}=setup({ready:true});
  await flow.prepare('bp_farm');
  assert.deepEqual(calls,['/api/calibrate/apply']);
  assert.equal(flow.snapshot().busy,false);
  assert.match(flow.snapshot().message,/Ready/);
});
test('declining temporary battle preparation sends no scan or run launch',async()=>{
  const {flow,calls}=setup({ready:false,next_action:'battle_setup'});
  await flow.prepare('bp_farm');
  assert.deepEqual(calls,['/api/calibrate/apply']);
  assert.match(flow.snapshot().message,/has not started/);
});

test('a missing END ROUND Yes crop shows the readiness message, asks no confirmation and starts no scan',async()=>{
  const message='Crop the END ROUND Yes button from the surrender confirmation.';
  const {flow,calls,getAsked}=setup({ready:false,next_action:'crop_image',action_label:'Crop the END ROUND Yes button',message});
  await flow.prepare('bp_farm');
  assert.equal(getAsked(),0);
  assert.deepEqual(calls,['/api/calibrate/apply']);   // the early apply only: no /api/calibrate/start
  assert.equal(flow.snapshot().message,message);
  assert.equal(flow.snapshot().busy,false);
});

test('preparing missing battle controls never requests a fresh inventory scan',async()=>{
  const {flow,calls,setConfirm}=setup({ready:false});
  setConfirm(true);
  await flow.prepare('bp_farm');
  const request=calls.find(r=>r.path==='/api/calibrate/start');
  assert.equal(request.body.battle_only,true);
  assert.equal(request.body.fresh,undefined);
  assert.equal(request.body.overwrite,false);
  assert.match(flow.snapshot().message,/Ready/);
});


test('a ready run cannot launch or prepare again while automation is running',()=>{
  const controls={'#start-preset':{value:'bp_farm'},'#run-ready':{},'#start-run':{}};
  const prepare={};
  const ctx=vm.createContext({LearningStore,S:{status:{processes:[{pid:123}]},runReadiness:{bp_farm:{ready:true}}},
    $:key=>controls[key],document:{querySelectorAll:()=>[prepare]}});
  vm.runInContext(section('function renderRunReady(){','async function killPid('),ctx);
  vm.runInContext('renderRunReady()',ctx);
  assert.equal(controls['#start-run'].disabled,true);
  assert.equal(prepare.disabled,true);
  assert.match(controls['#run-ready'].innerHTML,/Automation is running/);
});
