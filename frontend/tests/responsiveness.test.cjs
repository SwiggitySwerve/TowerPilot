const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {section}=require('./helpers.cjs');
const LearningStore=require('../webui/learning-store.js');
const WorkspaceStatus=require('../webui/workspace-status.js');

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const config=()=>({active_instance:'main',active_profile:'one',instances:{main:{account:'one',serial:'device'}}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function page(api){
  const observations=[];
  const ctx=vm.createContext({S:{config:config(),status:{processes:[]}},LearningStore,Date,
    api,learningStatus:()=>api('/api/calibrate/status'),applyGate:()=>observations.push('status'),
    renderBootStatus(){},renderHomeLive(){},renderWorkspaceStatus(){},refreshWorkspaceStatus(){},
    receiveCalibration:value=>{ctx.S.workspace={calibration:value};observations.push('calibration');},
    calibrationUnavailable:error=>{ctx.S.workspaceError=error.message;}});
  vm.runInContext(section('async function loadStatus(){','/* Shared status reads'),ctx);
  vm.runInContext(section('async function pollCalibrate(){','function renderMappingPlan('),ctx);
  return {ctx,observations};
}

test('slow calibration cannot hold status publication or the next status read',async()=>{
  const calibration=deferred();let reads=0;
  const p=page(path=>path==='/api/calibrate/status'?calibration.promise:Promise.resolve({processes:[],revision:++reads}));
  const slow=p.ctx.pollCalibrate();await p.ctx.loadStatus();
  assert.equal(p.ctx.S.status.revision,1);assert.equal(p.ctx.S.statusLoading,false);assert.equal(p.ctx.S.calibrationLoading,true);
  await p.ctx.loadStatus();assert.equal(p.ctx.S.status.revision,2);
  calibration.resolve({running:false});await slow;
  assert.deepEqual(p.observations,['status','status','calibration']);
});

test('slow status cannot hold calibration publication',async()=>{
  const status=deferred();
  const p=page(path=>path==='/api/status'?status.promise:Promise.resolve({running:true}));
  const slow=p.ctx.loadStatus();await p.ctx.pollCalibrate();
  assert.deepEqual(p.observations,['calibration']);assert.equal(p.ctx.S.workspace.calibration.running,true);
  status.resolve({processes:[]});await slow;assert.deepEqual(p.observations,['calibration','status']);
});

for(const change of ['context','epoch'])test(`late status and calibration replies cannot publish after ${change} changes`,async()=>{
  const status=deferred(),calibration=deferred();
  const p=page(path=>path==='/api/status'?status.promise:calibration.promise);
  const jobs=[p.ctx.loadStatus(),p.ctx.pollCalibrate()];
  if(change==='context')p.ctx.S.config.active_profile='other';else p.ctx.S.workspaceEpoch=1;
  status.resolve({processes:[{pid:99}]});calibration.resolve({running:true});await Promise.all(jobs);
  assert.deepEqual(p.observations,[]);assert.equal(p.ctx.S.status.processes.length,0);
  assert.equal(p.ctx.S.statusLoading,false);assert.equal(p.ctx.S.calibrationLoading,false);
});

function transport(fetch){
  const timers=new Map(),events=[];let next=0;
  const ctx=vm.createContext({fetch,AbortController,crypto:{randomUUID:()=> 'read-id'},
    setTimeout:(callback,delay)=>{timers.set(++next,{callback,delay});return next;},clearTimeout:id=>timers.delete(id),
    reportDiagnostic:(...args)=>events.push(args)});
  vm.runInContext(section('async function api(','const post = '),ctx);
  return {ctx,timers,events};
}

for(const phase of ['fetch','body'])test(`a hung GET ${phase} is aborted, bounded, and retryable`,async()=>{
  const hanging=deferred(),calls=[];
  const p=transport(async(path,opts)=>{
    calls.push({path,opts});
    if(calls.length>1)return {ok:true,json:async()=>({revision:2})};
    return phase==='fetch'?hanging.promise:{ok:true,json:()=>hanging.promise};
  });
  const first=p.ctx.api('/api/status');await flush();
  assert.equal(p.timers.size,1);const timer=[...p.timers.values()][0];assert.equal(timer.delay,5000);
  const rejected=assert.rejects(first,{name:'TimeoutError',requestId:'read-id'});timer.callback();await rejected;
  assert.equal(calls[0].opts.signal.aborted,true);assert.equal(p.events.length,1);assert.equal(p.timers.size,0);
  assert.equal((await p.ctx.api('/api/status')).revision,2);assert.equal(calls.length,2);
});

test('an uncertain mutation is never aborted or retried by the read budget',async()=>{
  const gate=deferred();let calls=0;
  const p=transport(()=>{calls++;return gate.promise;});
  const job=p.ctx.api('/api/operations/start',{method:'POST',body:'original identity'});
  assert.equal(p.timers.size,0);assert.equal(calls,1);
  gate.resolve({ok:true,json:async()=>({accepted:true})});assert.equal((await job).accepted,true);assert.equal(calls,1);
});

for(const alreadyCancelled of [true,false])test(`GET preserves caller cancellation ${alreadyCancelled?'before':'during'} the request`,async()=>{
  const caller=new AbortController();let received;
  const reason=Error('caller cancelled');if(alreadyCancelled)caller.abort(reason);
  const p=transport(async(path,opts)=>{
    received=opts.signal;
    if(received.aborted)throw received.reason;
    return new Promise((_,reject)=>received.addEventListener('abort',()=>reject(received.reason),{once:true}));
  });
  const job=p.ctx.api('/api/status',{signal:caller.signal});
  const rejected=assert.rejects(job,{message:'caller cancelled'});
  if(!alreadyCancelled)caller.abort(reason);await rejected;
  assert.equal(received.aborted,true);assert.equal(received.reason,reason);assert.equal(p.timers.size,0);
});

test('a read timeout keeps the last status snapshot and releases single flight',async()=>{
  const p=transport(()=>new Promise(()=>{})),v=page(p.ctx.api);
  const original=v.ctx.S.status,job=v.ctx.loadStatus();
  [...p.timers.values()][0].callback();await job;
  assert.equal(v.ctx.S.status,original);assert.match(v.ctx.S.statusError,/timed out/);assert.equal(v.ctx.S.statusLoading,false);
});

function clockPage(active=true){
  let now=0;const reads={status:[],calibration:[],battle:[]};
  const ctx=vm.createContext({S:{view:'home',tab:'overview',battleActive:active,status:{processes:active?[{pid:1}]:[]}},LearningStore,
    Date:{now:()=>now},document:{hidden:false},loadStatus:()=>reads.status.push(now),pollCalibrate:()=>reads.calibration.push(now),runWorkspace:{poll:()=>reads.battle.push(now)}});
  vm.runInContext(section('function pollDashboard(','/* Shared status reads'),ctx);
  ctx.loadSchedule=()=>{};ctx.loadLastBattle=()=>{};   // the day plan and history reads have their own cadence tests (dashboard.test.cjs)
  return {ctx,reads,tick:time=>{now=time;ctx.pollDashboard();}};
}

test('visible active status and battle reads have 500ms opportunities independent of calibration',()=>{
  const p=clockPage();p.ctx.S.workspace={calibration:{running:true}};
  for(let time=0;time<=2000;time+=250)p.tick(time);
  assert.deepEqual(p.reads.status,[0,500,1000,1500,2000]);assert.deepEqual(p.reads.battle,p.reads.status);assert.deepEqual(p.reads.calibration,p.reads.status);
});

test('idle and hidden pages back off, with no hidden battle polling',()=>{
  const p=clockPage(false);
  for(let time=0;time<=2500;time+=250)p.tick(time);
  assert.deepEqual(p.reads.status,[0,2500]);assert.deepEqual(p.reads.battle,[0,2500]);
  p.ctx.document.hidden=true;
  for(let time=2750;time<=12500;time+=250)p.tick(time);
  assert.deepEqual(p.reads.status,[0,2500,12500]);assert.deepEqual(p.reads.calibration,[0,2500,12500]);assert.deepEqual(p.reads.battle,[0,2500]);
  p.ctx.document.hidden=false;p.ctx.pollDashboard(true);
  assert.deepEqual(p.reads.battle,[0,2500,12500]);
});

test('battle reads stay independent of slow status and calibration',()=>{
  const p=clockPage();p.ctx.loadStatus=()=>new Promise(()=>{});p.ctx.pollCalibrate=()=>new Promise(()=>{});
  for(let time=0;time<=1500;time+=250)p.tick(time);
  assert.deepEqual(p.reads.battle,[0,500,1000,1500]);
});

test('failed status reads back off after failure, allow explicit retry, and reset on recovery',async()=>{
  let now=0,fail=true,reads=0;
  const p=page(async()=>{reads++;if(fail)throw Error('offline');return {processes:[]};});
  p.ctx.Date={now:()=>now};p.ctx.document={hidden:false};p.ctx.runWorkspace={poll(){}};
  await p.ctx.loadStatus();assert.equal(p.ctx.S.statusRetryAt,1000);
  p.ctx.pollDashboard();await flush();assert.equal(reads,2); // independent calibration may still read
  const count=reads;now=500;p.ctx.pollDashboard();await flush();assert.equal(reads,count);
  p.ctx.pollDashboard(true);await flush();assert.equal(p.ctx.S.statusFailures,2);assert.equal(p.ctx.S.statusRetryAt,2500);
  for(let n=0;n<8;n++)await p.ctx.loadStatus();assert.equal(p.ctx.S.statusRetryAt-now,30000);
  fail=false;await p.ctx.loadStatus();assert.equal(p.ctx.S.statusFailures,0);assert.equal(p.ctx.S.statusRetryAt,0);
});

test('a battle reply from another context or epoch cannot change active cadence',async()=>{
  for(const change of ['context','epoch']){
    const gate=deferred();let request;
    const ctx=vm.createContext({S:{config:config(),battleActive:true},LearningStore,Date,api:()=>gate.promise,
      RunWorkspace:{create:options=>{request=options.request;return {};}}});
    vm.runInContext(section('const runWorkspace = ','const diagnosticsView = '),ctx);
    const job=request('/api/battles/active');
    if(change==='context')ctx.S.config.active_profile='other';else ctx.S.workspaceEpoch=1;
    gate.resolve({battle:null});await job;assert.equal(ctx.S.battleActive,true);
  }
});

test('analysis read retry retains the accepted operation and never dispatches a mutation',async()=>{
  const conf=config(),key='screenAnalysis:'+LearningStore.context(conf).id,records=new Map([[key,JSON.stringify({operationId:'accepted',revision:3,idempotencyKey:'intent'})]]);
  const controls={'#analysis-progress':{},'#analysis-result':{innerHTML:'last snapshot'},'#analyze-screen':{},'#analysis-retry':{}};const paths=[];
  const ctx=vm.createContext({S:{config:conf},LearningStore,document:{hidden:false},$:name=>controls[name],clearTimeout(){},setTimeout(){},
    localStorage:{getItem:key=>records.get(key),setItem:(key,value)=>records.set(key,value)},
    api:async path=>{paths.push(path);if(paths.length===1)throw Error('read offline');return {status:'error',message:'Verified worker result',operation:{id:'accepted',revision:4,status:'failed'}};},
    post:()=>assert.fail('read retries must not start another operation')});
  vm.runInContext(section('function screenAnalysisReference(','function scanTimelineHTML('),ctx);
  await ctx.pollScreenAnalysis();
  assert.match(controls['#analysis-progress'].textContent,/unavailable.*stale.*read offline/);assert.equal(controls['#analysis-retry'].hidden,false);
  assert.equal(controls['#analyze-screen'].disabled,true);assert.equal(controls['#analysis-result'].innerHTML,'last snapshot');
  await ctx.pollScreenAnalysis();assert.deepEqual(paths,Array(2).fill('/api/screen-analysis/status?operation_id=accepted'));
  assert.equal(controls['#analysis-retry'].hidden,true);assert.equal(JSON.parse(records.get(key)).revision,4);
});

test('process discovery unknown and stale states cannot appear idle or authorize a start',()=>{
  const status={device_state:'device',processes:[]},conf={active_instance:'main',instances:{main:{allow_taps:true}}};
  assert.match(WorkspaceStatus.contextHTML({status,config:conf}),/<dt>Automation<\/dt><dd>Idle/);
  for(const [state,label] of [['unknown','Unknown'],['stale','Last known idle']]){
    status.process_refresh={state};
    const rendered=WorkspaceStatus.contextHTML({status,config:conf});
    assert.ok(rendered.includes(`<dt>Automation</dt><dd>${label}`));assert.match(rendered,/Retry status/);
    assert.ok(WorkspaceStatus.startBlockers({status,config:conf}).some(reason=>reason.id==='processes'));
  }
});

test('an overdue scheduler hold is visible beside the original revision-bound Stop control',()=>{
  const body={dataset:{},contains:()=>false};
  const ctx=vm.createContext({S:{config:config(),runs:{},status:{processes:[{pid:12,runner:'combo',operation:{id:'schedule',revision:7,step:'boundary_overdue',recovery_action:'Overdue; holding the current driver until a natural boundary.'}}]}},
    LearningStore,WorkspaceStatus,LearningView:require('../webui/learning-view.js'),DashboardView:require('../webui/dashboard-view.js'),$:name=>name==='#runner-body'?body:null,document:{activeElement:null},esc:String,renderRunReady(){},previewStartRun(){}});
  vm.runInContext(section('function renderRunner(){','function renderRunReady('),ctx);ctx.renderRunner();
  assert.match(body.innerHTML,/Overdue; holding the current driver/);
  assert.match(body.innerHTML,/data-operation-id="schedule" data-operation-revision="7" onclick="killPid/);
  assert.match(body.innerHTML,/Stop now/);
});

test('a late analysis read error cannot alter a replacement operation reference',async()=>{
  let reject;const pending=new Promise((_,r)=>{reject=r;});
  let resolveNext;const next=new Promise(resolve=>{resolveNext=resolve;}),paths=[];
  const conf=config(),key='screenAnalysis:'+LearningStore.context(conf).id,records=new Map([[key,JSON.stringify({operationId:'old',revision:2,idempotencyKey:'old-intent'})]]);
  const controls={'#analysis-progress':{},'#analysis-result':{},'#analyze-screen':{},'#analysis-retry':{}};
  const ctx=vm.createContext({S:{config:conf},LearningStore,$:name=>controls[name],clearTimeout(){},
    localStorage:{getItem:key=>records.get(key),setItem:(key,value)=>records.set(key,value)},
    api:path=>{paths.push(path);return paths.length===1?pending:next;}});
  vm.runInContext(section('function screenAnalysisReference(','function scanTimelineHTML('),ctx);
  const job=ctx.pollScreenAnalysis();records.set(key,JSON.stringify({operationId:'new',revision:1,idempotencyKey:'new-intent'}));
  reject(Error('old read failed'));await job;
  assert.equal(controls['#analysis-progress'].textContent,undefined);assert.equal(controls['#analyze-screen'].disabled,undefined);
  assert.equal(JSON.parse(records.get(key)).operationId,'new');
  assert.deepEqual(paths,['/api/screen-analysis/status?operation_id=old','/api/screen-analysis/status?operation_id=new']);
  const followed=ctx.S.analysisFlight;
  resolveNext({status:'error',message:'New operation result',operation:{id:'new',revision:2}});
  await followed;
  assert.equal(controls['#analysis-progress'].textContent,'New operation result');
  assert.equal(JSON.parse(records.get(key)).revision,2);
  assert.equal(paths.length,2);
});
