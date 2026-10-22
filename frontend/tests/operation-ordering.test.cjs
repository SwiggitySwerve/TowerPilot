const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {section}=require('./helpers.cjs');
const LearningStore=require('../webui/learning-store.js');
const WorkspaceStatus=require('../webui/workspace-status.js');
const Controller=require('../webui/learning-controller.js');
const config=()=>({active_instance:'main',active_profile:'alice',instances:{main:{account:'alice',serial:'one',allow_taps:true}}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function readyPage(ready,fresh=true){
  const conf=config(), controls={'#start-preset':{value:'bp_farm'},'#run-ready':{},'#start-run':{},'#start-gems':{}};
  const ctx=vm.createContext({LearningStore,WorkspaceStatus,S:{config:conf,status:{processes:[],device_state:'device'},runReadiness:ready,readinessFresh:fresh,readinessContext:LearningStore.context(conf).id},
    $:key=>controls[key],esc:String,document:{querySelectorAll:()=>[]},outstandingCard:()=>''});
  vm.runInContext(section('function renderRunReady(){','async function killPid('),ctx);
  return {ctx,controls,render:()=>ctx.renderRunReady()};
}
for (const [label,value] of [['absent',undefined],['empty',{}],['failed',{error:'offline'}],['nonboolean',{ready:'yes'}],['negative',{ready:false}]]) test(label+' readiness disables Start',()=>{
  const p=readyPage(value ? {bp_farm:value} : {});p.render();assert.equal(p.controls['#start-run'].disabled,true);
});
test('last confirmed readiness cannot enable Start after a failed refresh',()=>{
  const p=readyPage({bp_farm:{ready:true}},false);p.render();assert.equal(p.controls['#start-run'].disabled,true);
});
test('another profile cannot reuse readiness from the previous profile',()=>{
  const p=readyPage({bp_farm:{ready:true}});p.ctx.S.config.active_profile='bob';p.render();assert.equal(p.controls['#start-run'].disabled,true);
});
test('a status outage cannot enable Start from cached readiness',()=>{
  const p=readyPage({bp_farm:{ready:true}});p.ctx.S.statusError='offline';p.render();assert.equal(p.controls['#start-run'].disabled,true);
  assert.equal(p.controls['#start-gems'].disabled,true);
});
test('operation revisions discard older observations without a timer',()=>{
  const ctx=vm.createContext({S:{workspace:{calibration:{operation:{id:'a',revision:5}}}}});
  vm.runInContext(section('function launchSettled(','/* The controller owns completion'),ctx);
  assert.equal(ctx.launchSettled({operation:{id:'a',revision:4}}),false);
  assert.equal(ctx.launchSettled({}),false);
  assert.equal(ctx.launchSettled({operation:{id:'a',revision:5}}),true);
});
test('acceptance for one operation cannot be cleared by a different result',()=>{
  const ctx=vm.createContext({S:{scanLaunchPending:'b'}});
  vm.runInContext(section('function launchSettled(','/* The controller owns completion'),ctx);
  assert.equal(ctx.launchSettled({operation:{id:'a',revision:50}}),false);
  assert.equal(ctx.S.scanLaunchPending,'b');assert.equal(ctx.launchSettled({operation:{id:'b',revision:1}}),true);
});
test('a delayed status request cannot publish after the selected profile changed',async()=>{
  const gate=deferred(),values=[],conf=config();
  const ctx=vm.createContext({S:{config:conf},LearningStore,api:()=>gate.promise,
    receiveCalibration:v=>values.push(v),calibrationUnavailable:()=>{},applyGate:()=>{},renderBootStatus:()=>{},renderWorkspaceStatus:()=>{}});
  vm.runInContext(section('async function loadStatus(){','/* Shared status reads'),ctx);
  const job=ctx.loadStatus();conf.active_profile='bob';gate.resolve({operation:{id:'a',revision:1}});await job;
  assert.deepEqual(values,[]);assert.equal(ctx.S.status,undefined);
});
test('status requests use single flight',async()=>{
  const gate=deferred();let requests=0;
  const ctx=vm.createContext({S:{config:config()},LearningStore,api:()=>{requests++;return gate.promise;},
    receiveCalibration:()=>{},calibrationUnavailable:()=>{},applyGate:()=>{},renderBootStatus:()=>{},renderWorkspaceStatus:()=>{}});
  vm.runInContext(section('async function loadStatus(){','/* Shared status reads'),ctx);
  const first=ctx.loadStatus();await ctx.loadStatus();assert.equal(requests,1);gate.resolve({});await first;
});
test('overlapping immediate calibration polls share one read',async()=>{
  const gate=deferred(),values=[];let calls=0;
  const ctx=vm.createContext({S:{config:config()},LearningStore,learningStatus:()=>{calls++;return gate.promise;},receiveCalibration:v=>values.push(v),calibrationUnavailable:()=>{},renderWorkspaceStatus:()=>{}});
  vm.runInContext(section('async function pollCalibrate(){','function renderMappingPlan('),ctx);
  const first=ctx.pollCalibrate(),second=ctx.pollCalibrate();assert.equal(calls,1);gate.resolve({revision:2});await Promise.all([first,second]);
  assert.deepEqual(values,[{revision:2}]);
});
test('reload retains the same operation and sends revision-bound apply',async()=>{
  const conf=config(),records=new Map(),storage={getItem:k=>records.get(k) ?? null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
  const scope=LearningStore.context(conf),store=LearningStore.create(storage),calls=[];
  store.save(scope,'preparation',{preset:'bp_farm',operationId:'durable-id',revision:2});
  const flow=Controller.create({config:()=>conf,storage,apply:async body=>{calls.push(body);return {operation:{id:'durable-id',revision:5,status:'succeeded'}};},readiness:async()=>({ready:true})});
  await flow.observe({operation:{id:'durable-id',revision:3,status:'awaiting_apply',context:scope}});
  assert.deepEqual(calls,[{operation_id:'durable-id',expected_revision:3}]);assert.equal(flow.snapshot().phase,'ready');
  flow.unavailable(Error('offline'));assert.equal(flow.snapshot().phase,'ready');assert.equal(flow.snapshot().freshness,'unavailable');
  assert.equal(store.pending(scope).operationId,'durable-id');assert.equal(store.pending(scope).outcome,'succeeded');
});
test('Start rechecks readiness and refuses a nonboolean positive result',async()=>{
  let posts=0;
  const ctx=vm.createContext({S:{config:config()},LearningStore,crypto:{randomUUID:()=> 'start-key'},$:()=>({value:'bp_farm'}),renderRunReady:()=>{},api:async()=>({ready:'true'}),post:async()=>{posts++;},toast:()=>{},loadStatus:()=>{}});
  vm.runInContext(section('async function startPreset(){','async function ctl('),ctx);await ctx.startPreset();assert.equal(posts,0);assert.equal(ctx.S.runStarting,false);
});
test('duplicate Start requests share a readiness check',async()=>{
  const gate=deferred();let checks=0,posts=0;
  const ctx=vm.createContext({S:{config:config()},LearningStore,crypto:{randomUUID:()=> 'start-key'},$:()=>({value:'bp_farm'}),renderRunReady:()=>{},api:()=>{checks++;return gate.promise;},post:async()=>{posts++;return {pid:1};},toast:()=>{},loadStatus:()=>{}});
  vm.runInContext(section('async function startPreset(){','async function ctl('),ctx);
  const first=ctx.startPreset();await ctx.startPreset();assert.equal(checks,1);gate.resolve({ready:true});await first;assert.equal(posts,1);
});

function acceptancePage(post){
  const records=new Map(),ctx=vm.createContext({S:{config:config(),calibrationPreset:'bp_farm'},LearningStore,crypto:{randomUUID:()=> 'request-key'},
    localStorage:{getItem:k=>records.get(k) ?? null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},post,$:()=>null});
  vm.runInContext(section('async function startCalibrationOperation(','async function prepareRun('),ctx);
  return {ctx,records};
}
test('all calibration starts bind browser context and retain a resumable accepted ID',async()=>{
  let request;
  const p=acceptancePage(async(path,body)=>{request={path,body};return {operation:{id:'accepted-id',revision:1}};});
  await p.ctx.startCalibrationOperation('/api/calibrate/observe',{watch:120});
  assert.equal(request.path,'/api/calibrate/observe');assert.equal(request.body.idempotency_key,'request-key');
  assert.equal(request.body.selected_run,'bp_farm');assert.equal(request.body.expected_context.account,'alice');
  assert.equal(JSON.parse([...p.records.values()][0]).operationId,'accepted-id');
});
test('an accepted request whose response was lost retains its idempotency reference',async()=>{
  const p=acceptancePage(async()=>{throw Error('offline');});
  await assert.rejects(p.ctx.startCalibrationOperation('/api/calibrate/start',{}),/offline/);
  assert.equal(JSON.parse([...p.records.values()][0]).idempotencyKey,'request-key');
  assert.equal(p.ctx.S.calibrationStarting,false);
});
test('a definitive acceptance refusal restores the earlier operation reference',async()=>{
  const p=acceptancePage(async()=>{throw Object.assign(Error('busy'),{status:409});});
  const key='calibrationOperation:'+LearningStore.context(p.ctx.S.config).id;
  p.records.set(key,JSON.stringify({operationId:'previous'}));
  await assert.rejects(p.ctx.startCalibrationOperation('/api/calibrate/start',{}),/busy/);
  assert.equal(JSON.parse(p.records.get(key)).operationId,'previous');
});
test('another tab replacing the browser reference cannot be overwritten by a late acceptance',async()=>{
  const gate=deferred(),p=acceptancePage(()=>gate.promise);
  const job=p.ctx.startCalibrationOperation('/api/calibrate/start',{});
  const key=[...p.records.keys()][0];p.records.set(key,JSON.stringify({operationId:'newer'}));
  gate.resolve({operation:{id:'older',revision:1}});await assert.rejects(job,/newer operation/);
  assert.equal(JSON.parse(p.records.get(key)).operationId,'newer');
});
test('Stop names the observed operation and revision without fetching a new target',async()=>{
  const calls=[],ctx=vm.createContext({S:{config:config(),workspace:{calibration:{operation:{id:'old-operation',revision:4}}}},LearningStore,
    post:async(path,body)=>calls.push({path,body}),toast:()=>{}});
  vm.runInContext(section('async function stopCalibrate(){','async function analyzeScreen('),ctx);await ctx.stopCalibrate();
  assert.equal(calls[0].path,'/api/calibrate/stop');assert.equal(calls[0].body.operation_id,'old-operation');assert.equal(calls[0].body.expected_revision,4);
});

function runnerCommands(processes=[]){
  // (the shared stop sender restates each answer per context: it reads the selection and the stop-result reader)
  const calls=[],messages=[],ctx=vm.createContext({S:{config:config(),status:{processes}},confirm:()=>true,post:async(path,body)=>calls.push({path,body}),toast:(message)=>messages.push(message),loadStatus:()=>{},setTimeout:()=>{},renderRunner:()=>{},encodeURIComponent,
    LearningStore,DashboardView:require('../webui/dashboard-view.js'),$:()=>null,renderOwnerRefusal:()=>{}});
  vm.runInContext(section('async function killPid(','async function setAutomationAccess('),ctx);
  vm.runInContext(section('async function ctl(','/* ------------------------------------------------------------- day plan'),ctx);
  return {ctx,calls,messages};
}
test('tracked Stop cancels the rendered operation instead of the currently reused PID',async()=>{
  const p=runnerCommands([{pid:42,operation:{id:'new-run',revision:1}}]);
  await p.ctx.killPid(42,'old-run',7);
  assert.equal(p.calls[0].path,'/api/operations/old-run/cancel');assert.equal(p.calls[0].body.expected_revision,7);
  assert.equal(p.calls.length,1);
});
test('only an untracked legacy worker can use PID cancellation',async()=>{
  // the kill names the exact row the person saw: its PID and start time (created); a PID alone is never sent
  const p=runnerCommands([{pid:42,runner:'orchestrator',created:1790000000.123456}]);await p.ctx.killPid(42);
  assert.deepEqual(p.calls,[]);
  await p.ctx.killRunner({dataset:{pid:'42',created:'1790000000.123456'}});
  assert.equal(p.calls[0].path,'/api/control');assert.deepEqual(JSON.parse(JSON.stringify(p.calls[0].body)),{action:'kill',pid:42,created:1790000000.123456});
});
test('a missing operation reference never falls back to PID cancellation for a tracked worker',async()=>{
  const p=runnerCommands([{pid:42,operation:{id:'tracked',revision:4}}]);await p.ctx.killPid(42);
  assert.deepEqual(p.calls,[]);assert.match(p.messages[0],/tracked operation/);
});
test('tracked Stop requires a concrete operation revision',async()=>{
  const p=runnerCommands();await p.ctx.killPid(42,'tracked',NaN);assert.deepEqual(p.calls,[]);
});
test('clear_flag carries the rendered original operation target',async()=>{
  const action='clear_flag',p=runnerCommands();await p.ctx.ctl(action,'original-run',8);
  assert.equal(p.calls[0].path,'/api/control');assert.equal(p.calls[0].body.operation_id,'original-run');assert.equal(p.calls[0].body.expected_revision,8);
  assert.equal(p.calls[0].body.action,action);
});
test('rendered tracked controls retain operation revision and original instance after selection changes',()=>{
  const body={dataset:{},contains:()=>false},conf=config();conf.active_instance='new-selection';
  const ctx=vm.createContext({S:{config:conf,status:{processes:[{pid:42,runner:'orchestrator',operation:{id:'run-old',revision:6,kind:'run',context:{instance:'original'}}}]},runs:{}},
    LearningStore,WorkspaceStatus,LearningView:require('../webui/learning-view.js'),DashboardView:require('../webui/dashboard-view.js'),$:key=>key === '#runner-body'?body:null,document:{activeElement:null},esc:String,renderRunReady:()=>{},previewStartRun:()=>{}});
  vm.runInContext(section('function renderRunner(){','function renderRunReady('),ctx);ctx.renderRunner();
  assert.match(body.innerHTML,/data-operation-id="run-old" data-operation-revision="6" onclick="killPid/);
  assert.doesNotMatch(body.innerHTML,/ctl\('stop_after_run'/);
  ctx.S.status.processes[0].stop_flag=true;ctx.renderRunner();
  assert.match(body.innerHTML,/ctl\('clear_flag',this.dataset.operationId,Number\(this.dataset.operationRevision\)\)" data-operation-id="run-old" data-operation-revision="6"/);
});

function gemsPage(post){
  const messages=[],ctx=vm.createContext({S:{config:config()},LearningStore,crypto:{randomUUID:(()=>{let n=0;return ()=> 'gems-key-'+(++n);})()},
    $:()=>({value:'bp_farm'}),post,toast:message=>messages.push(message),loadStatus:async()=>{},renderRunReady:()=>{}});
  vm.runInContext(section('async function startGemsOnly(){','async function startPreset('),ctx);
  return {ctx,messages};
}
test('collector carries its original expected target and reports a stale-target server refusal',async()=>{
  const gate=deferred();let body;
  const p=gemsPage(async(path,request)=>{body=request;await gate.promise;throw Object.assign(Error('Selected account, device or profile changed before acceptance'),{status:409});});
  const job=p.ctx.startGemsOnly();p.ctx.S.config.active_profile='bob';gate.resolve();await job;
  assert.equal(body.action,'start_gems');assert.equal(body.preset,'bp_farm');assert.equal(body.expected_context.profile,'alice');
  assert.equal(body.expected_context.instance,'main');assert.equal(body.expected_context.account,'alice');assert.equal(body.expected_context.serial,'one');assert.equal(body.expected_context.rendering,null);
  assert.equal(body.idempotency_key,'gems-key-1');assert.equal(p.ctx.S.gemsStartIntent,null);assert.equal(p.ctx.S.runStarting,false);
  assert.match(p.messages[0],/changed before acceptance/);
});
test('concurrent collector clicks send one accepted request',async()=>{
  const gate=deferred();let requests=0;
  const p=gemsPage(async()=>{requests++;await gate.promise;return {operation:{id:'collector',revision:1}};});
  const job=p.ctx.startGemsOnly();await p.ctx.startGemsOnly();assert.equal(requests,1);gate.resolve();await job;
  assert.equal(p.ctx.S.runStarting,false);assert.equal(p.ctx.S.gemsStartIntent,null);
});
test('collector retry after a lost response preserves the original idempotency key',async()=>{
  const requests=[];
  const p=gemsPage(async(path,body)=>{requests.push(body);if(requests.length === 1)throw Error('offline');return {operation:{id:'same-accepted-collector',revision:2}};});
  await p.ctx.startGemsOnly();assert.equal(p.ctx.S.gemsStartIntent.body.idempotency_key,'gems-key-1');
  await p.ctx.startGemsOnly();assert.equal(requests.length,2);assert.equal(requests[0].idempotency_key,requests[1].idempotency_key);
  assert.equal(p.ctx.S.gemsStartIntent,null);
});
test('a changed collector target creates a new request key instead of retargeting an uncertain command',async()=>{
  const requests=[];
  const p=gemsPage(async(path,body)=>{requests.push(body);throw Error('offline');});
  await p.ctx.startGemsOnly();p.ctx.S.config.instances.main.serial='another-device';await p.ctx.startGemsOnly();
  assert.equal(requests[0].expected_context.serial,'one');assert.equal(requests[1].expected_context.serial,'another-device');
  assert.notEqual(requests[0].idempotency_key,requests[1].idempotency_key);
});
test('collector cannot launch while a normal Start request owns single flight',async()=>{
  let requests=0;const p=gemsPage(async()=>{requests++;});p.ctx.S.runStarting=true;await p.ctx.startGemsOnly();assert.equal(requests,0);
});

function analysisPage(overrides={}){
  const records=new Map(),calls=[],controls={'#analysis-progress':{},'#analysis-result':{},'#analyze-screen':{}};
  const context=LearningStore.context(config());
  const ctx=vm.createContext({S:{config:config()},LearningStore,crypto:{randomUUID:()=> 'analysis-key'},Date,encodeURIComponent,esc:String,
    localStorage:{getItem:k=>records.get(k) ?? null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)},$:key=>controls[key],
    post:async(path,body)=>{calls.push({path,body});return {operation:{id:'analysis-a',revision:1}};},
    api:async path=>{calls.push({path});return {status:'done',operation:{id:'analysis-a',revision:4,status:'succeeded'},screen:{name:'Home'},tested:2,captured_at:1,width:1080,height:2560,matches:[]};},
    clearTimeout:()=>{},setTimeout:()=>{},toast:()=>{},...overrides});
  vm.runInContext(section('function screenAnalysisReference(','function scanTimelineHTML('),ctx);
  return {ctx,records,calls,controls,key:'screenAnalysis:'+context.id};
}
test('analysis acceptance binds expected context and reload polls the accepted operation ID',async()=>{
  const p=analysisPage();await p.ctx.analyzeScreen();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.calls[0].body.expected_context.profile,'alice');assert.equal(p.calls[0].body.idempotency_key,'analysis-key');
  assert.equal(p.calls[1].path,'/api/screen-analysis/status?operation_id=analysis-a');
  assert.match(p.controls['#analysis-result'].innerHTML,/frame.png\?operation_id=analysis-a&amp;revision=4/);
  await p.ctx.pollScreenAnalysis();assert.equal(p.calls.at(-1).path,'/api/screen-analysis/status?operation_id=analysis-a');
});
test('analysis acceptance refuses a stale server target without polling another operation',async()=>{
  const messages=[],p=analysisPage({post:async()=>{throw Object.assign(Error('Selected device changed'),{status:409});},toast:message=>messages.push(message)});
  await p.ctx.analyzeScreen();assert.equal(p.calls.length,0);assert.equal(p.records.size,0);assert.match(messages[0],/changed/);assert.equal(p.ctx.S.analysisStarting,false);
});
test('duplicate Analyze clicks send one command while acceptance is pending',async()=>{
  const gate=deferred();let requests=0;
  const p=analysisPage({post:async()=>{requests++;return gate.promise;}});
  const first=p.ctx.analyzeScreen();await p.ctx.analyzeScreen();assert.equal(requests,1);gate.resolve({operation:{id:'analysis-a',revision:1}});await first;
});
test('analysis polling ignores a response after the selected context changes',async()=>{
  const gate=deferred(),p=analysisPage({api:()=>gate.promise});p.records.set(p.key,JSON.stringify({operationId:'analysis-a',revision:1}));
  const job=p.ctx.pollScreenAnalysis();p.ctx.S.config.active_profile='bob';gate.resolve({status:'error',message:'old profile result',operation:{id:'analysis-a',revision:2}});await job;
  assert.equal(p.controls['#analysis-progress'].textContent,undefined);
});
test('analysis polls share one read and reject a response older than the saved revision',async()=>{
  const gates=[deferred(),deferred()];let n=0;const p=analysisPage({api:()=>gates[n++].promise});p.records.set(p.key,JSON.stringify({operationId:'analysis-a',revision:1}));
  const first=p.ctx.pollScreenAnalysis(),shared=p.ctx.pollScreenAnalysis();assert.equal(n,1);
  gates[0].resolve({status:'error',message:'new observation',operation:{id:'analysis-a',revision:4}});await Promise.all([first,shared]);
  const second=p.ctx.pollScreenAnalysis();gates[1].resolve({status:'error',message:'old observation',operation:{id:'analysis-a',revision:2}});await second;
  assert.equal(p.controls['#analysis-progress'].textContent,'new observation');assert.equal(JSON.parse(p.records.get(p.key)).revision,4);
});
test('analysis identity mismatch never renders a completed frame',async()=>{
  const p=analysisPage({api:async()=>({status:'done',operation:{id:'unrelated',revision:5}})});p.records.set(p.key,JSON.stringify({operationId:'analysis-a',revision:1}));
  await p.ctx.pollScreenAnalysis();assert.match(p.controls['#analysis-progress'].textContent,/requested operation/);assert.equal(p.controls['#analysis-result'].innerHTML,undefined);
});
test('analysis retries an uncertain acceptance with the same idempotency key',async()=>{
  const bodies=[],p=analysisPage({post:async(path,body)=>{bodies.push(body);throw Error('offline');}});
  await p.ctx.analyzeScreen();await p.ctx.analyzeScreen();assert.equal(bodies.length,2);assert.equal(bodies[0].idempotency_key,bodies[1].idempotency_key);assert.equal(JSON.parse(p.records.get(p.key)).idempotencyKey,'analysis-key');
});

for (const replacement of [{idempotencyKey:'new-intent-b'},null]) test('late analysis observation preserves '+(replacement ? 'another tab unbound intent' : 'a removed operation reference'),async()=>{
  const gate=deferred(),followup=deferred();let reads=0;
  const p=analysisPage({api:()=>++reads===1?gate.promise:followup.promise});
  p.records.set(p.key,JSON.stringify({operationId:'analysis-a',revision:1,idempotencyKey:'old-intent-a'}));
  const pending=p.ctx.pollScreenAnalysis();
  if (replacement) p.records.set(p.key,JSON.stringify(replacement)); else p.records.delete(p.key);
  gate.resolve({status:'error',message:'old A result',operation:{id:'analysis-a',revision:4}});await pending;
  assert.equal(p.records.get(p.key),replacement ? JSON.stringify(replacement) : undefined);
  assert.equal(p.controls['#analysis-progress'].textContent,undefined);
  assert.equal(reads,replacement?2:1);
});

test('a newly accepted analysis is observed after an older in-flight read finishes',async()=>{
  const old=deferred(),next=deferred(),paths=[];
  const p=analysisPage({api:path=>{paths.push(path);return paths.length===1?old.promise:next.promise;}});
  p.records.set(p.key,JSON.stringify({operationId:'old-analysis',revision:1,idempotencyKey:'old-intent'}));
  const pending=p.ctx.pollScreenAnalysis();
  await p.ctx.analyzeScreen();
  assert.equal(JSON.parse(p.records.get(p.key)).operationId,'analysis-a');
  old.resolve({status:'error',message:'old result',operation:{id:'old-analysis',revision:3}});
  await pending;
  assert.deepEqual(paths,['/api/screen-analysis/status?operation_id=old-analysis','/api/screen-analysis/status?operation_id=analysis-a']);
  assert.equal(p.controls['#analysis-progress'].textContent,undefined);
  const followed=p.ctx.S.analysisFlight;
  next.resolve({status:'error',message:'new operation observed',operation:{id:'analysis-a',revision:2}});
  await followed;
  assert.equal(p.controls['#analysis-progress'].textContent,'new operation observed');
  assert.equal(JSON.parse(p.records.get(p.key)).revision,2);
  assert.equal(paths.length,2);
  assert.equal(p.ctx.S.analysisLoading,false);
});
