const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const WorkspaceStatus=require('../webui/workspace-status.js');
const {section}=require('./helpers.cjs');
const {buildFixture}=require('./fixtures/setup-completion-harness.cjs');

const finished=()=>({status:'done',started_at:100,updated_at:160,message:'Capture finished',steps:[
  {id:'home',label:'Home',status:'done'},
  {id:'finish',label:'Verify and save',status:'done',message:'Returned to Home; discoveries saved'}
]});

for(const [outcome,state] of [['failed','error'],['cancelled','stopped'],['interrupted','stopped'],['restoration_required','needs_attention'],['awaiting_apply','needs_attention']]){
  test(`recorded ${outcome} cannot be hidden by successful capture phases`,()=>{
    const model=WorkspaceStatus.operation({record:finished(),attempt:{status:outcome,error:{message:'Exact worker verdict'}}});
    assert.equal(model.state,state);
    const rendered=WorkspaceStatus.operationHTML(model);
    assert.match(rendered,new RegExp(`status-tag status-${state}`));
    if(outcome!=='restoration_required')assert.match(rendered,/Exact worker verdict/);
  });
}

test('completed capture does not claim that profile application is confirmed',()=>{
  const model=WorkspaceStatus.operation({record:finished(),attempt:{status:'awaiting_apply'}});
  assert.match(model.message,/Applying discoveries.*not yet confirmed/);
  assert.equal(model.state,'needs_attention');
  assert.equal(model.applicationText,'Awaiting apply');
});

test('a targeted scan shows its own final Home proof and pending application',()=>{
  const input={record:finished(),mode:'basic',attempt:{id:'cards-op',revision:9,status:'awaiting_apply'},now:200,
    finalScreen:{operation_id:'cards-op',name:'home',verified:true,observed_at:195}};
  const rendered=WorkspaceStatus.operationHTML(WorkspaceStatus.operation(input));
  assert.match(rendered,/Home verified · 5s ago/);
  assert.match(rendered,/Profile:<\/b> Awaiting apply/);
  assert.match(rendered,/<code>cards-op<\/code> · revision 9/);
  assert.match(rendered,/data-workspace-section="game-knowledge"/);
  input.finalScreen.operation_id='older-op';
  assert.equal(WorkspaceStatus.operation(input).returnEvidence,'Final screen unverified');
});

test('incomplete capture retains its specific cause and recovery independent of application',()=>{
  const record={...finished(),status:'needs_attention',message:'Two required controls still need capture.'};
  const attempt={id:'partial-op',status:'failed',error:{code:'capture_incomplete',message:'Not every requested phase completed'}};
  const failed=WorkspaceStatus.operation({record,attempt});
  assert.equal(failed.state,'error');
  assert.match(failed.message,/Not every requested phase completed.*Two required controls/);
  assert.match(failed.guidance,/Applying discoveries does not complete missing image verification/);
  assert.doesNotMatch(WorkspaceStatus.operationHTML(failed),/Review emulator connection/);
  const applied=WorkspaceStatus.operation({record,attempt:{...attempt,result_refs:{apply_status:'succeeded',apply_error:null}}});
  assert.equal(applied.state,'error');
  assert.equal(applied.applicationText,'Discoveries applied');
  assert.match(applied.message,/Two required controls/);
});

test('application failure remains distinct from capture failure and escapes its reason',()=>{
  const model=WorkspaceStatus.operation({record:finished(),attempt:{id:'partial',status:'failed',
    error:{code:'capture_incomplete',message:'Capture remains incomplete'},
    result_refs:{apply_status:'failed',apply_error:{message:'Profile <write> failed'}}}});
  const rendered=WorkspaceStatus.operationHTML(model);
  assert.match(rendered,/Capture remains incomplete/);
  assert.match(rendered,/Profile:<\/b> Application failed — Profile &lt;write&gt; failed/);
});

test('applying a partial capture cannot hide incomplete step evidence',()=>{
  for(const [status,expected] of [['needs_attention','needs_attention'],['error','error'],['stopped','stopped']]){
    const record=finished();record.steps[0].status=status;
    const model=WorkspaceStatus.operation({record,attempt:{id:'partial',status:'succeeded'}});
    assert.equal(model.state,expected);
    assert.equal(model.applicationText,'Discoveries applied');
  }
});

test('an attempt retains its own mode and selected phases after the worker exits',()=>{
  const ctx=vm.createContext({});
  vm.runInContext(section('function calibrationMode(', 'function calibReport('),ctx);
  const st={running:false,operation:{status:'failed'},selection:{mode:'basic',phases:['c']},state:{phases:{
    cards:{status:'error',started_at:100,finished_at:130,error:'Cards missing'},
    modules:{status:'done',started_at:10,finished_at:30},bootstrap:{status:'done',updated_at:200}
  }}};
  const basic=ctx.basicScanProgress(st),selected=WorkspaceStatus.selectOperation(st,basic);
  assert.equal(selected.mode,'basic');assert.equal(basic.steps.length,1);
  assert.equal(basic.steps[0].id,'cards');assert.equal(basic.started_at,100);
});

test('persisted basic activity supplies the exact action and age without log observations',()=>{
  const ctx=vm.createContext({});
  vm.runInContext(section('function calibrationMode(', 'function calibReport('),ctx);
  const st={running:true,selection:{mode:'basic',phases:['c']},state:{phases:{cards:{status:'running',started_at:100,
    updated_at:140,message:'Cards: reading page 3; 12 cards identified'}}},
    activity:{phase:'cards',t:140,message:'Cards: reading page 3; 12 cards identified'}};
  const basic=ctx.basicScanProgress(st);
  const model=WorkspaceStatus.operation({record:basic,mode:'basic',running:true,now:145});
  assert.equal(model.message,st.activity.message);assert.equal(model.workerAge,'5s ago');
  assert.equal(model.current.label,'Cards and presets');
  delete st.activity;
  const fallback=WorkspaceStatus.operation({record:ctx.basicScanProgress(st),mode:'basic',running:true,now:150});
  assert.equal(fallback.message,st.state.phases.cards.message);assert.equal(fallback.workerAge,'10s ago');
});

test('incomplete mapping is shared by the summary and detail selection without mutating saved data',()=>{
  const original=finished();
  const selected=WorkspaceStatus.selectOperation({state:{phases:{bootstrap:original},screen_map:{cards:{status:'incomplete'}}}},null);
  assert.equal(selected.record.status,'needs_attention');assert.match(selected.record.message,/Incomplete screen maps: cards/);
  assert.equal(original.status,'done');
});

test('battle preparation keeps unrelated saved menu failures out of its outcome',()=>{
  const original={...finished(),kind:'battle',screens:['home']};
  const state={phases:{bootstrap:original},screen_map:{home:{status:'verified'},guild_store:{status:'needs_mapping'}}};
  assert.equal(WorkspaceStatus.selectOperation({state},null).record.status,'done');
  state.screen_map.home.status='needs_mapping';
  const result=WorkspaceStatus.selectOperation({state},null).record;
  assert.equal(result.status,'needs_attention');
  assert.match(result.message,/Incomplete screen maps: home\./);
  assert.doesNotMatch(result.message,/guild_store/);
});

test('selected route capture retains its own result without claiming full screen learning',()=>{
  const original={...finished(),kind:'routes',routes:['route_17','route_18']};
  const state={phases:{bootstrap:original},screen_map:{daily_missions:{status:'verified'},guild_store:{status:'needs_mapping'}}};
  const selected=WorkspaceStatus.selectOperation({state},null);
  assert.equal(selected.record.status,'done');
  assert.equal(state.screen_map.guild_store.status,'needs_mapping');
  const model=WorkspaceStatus.operation({...selected,attempt:{status:'succeeded'}});
  assert.equal(model.state,'done');
  assert.equal(model.headline,'Last selected route capture result');
  original.status='needs_attention';
  original.steps[0].status='needs_attention';
  const incomplete=WorkspaceStatus.operation({...WorkspaceStatus.selectOperation({state},null),attempt:{status:'succeeded'}});
  assert.equal(incomplete.state,'needs_attention');
  assert.equal(incomplete.attention,1);
});

test('the exact attempt target wins over the currently selected account and is escaped',()=>{
  const model=WorkspaceStatus.operation({record:finished(),context:{account:'new'},attempt:{status:'succeeded',
    context:{instance:'emulator-a',account:'<saved-account>',profile:'profile-a',serial:'device-a'}}});
  const html=WorkspaceStatus.operationHTML(model);
  assert.match(html,/Emulator: emulator-a · Account: &lt;saved-account&gt; · Profile: profile-a · Connection: device-a/);
  assert.doesNotMatch(html,/Account: new|<saved-account>/);
});

test('final screen requires fresh proof bound to this operation, even when every phase finished',()=>{
  const input={record:finished(),attempt:{id:'current',status:'succeeded'},now:200};
  assert.equal(WorkspaceStatus.operation(input).returnEvidence,'Final screen unverified');
  for(const finalScreen of [{operation_id:'other',name:'home',verified:true},
    {operation_id:'current',name:'home',verified:false},{operation_id:'current',name:'unknown',verified:true}]){
    assert.equal(WorkspaceStatus.operation({...input,finalScreen}).returnEvidence,'Final screen unverified');
  }
  assert.equal(WorkspaceStatus.operation({...input,finalScreen:{operation_id:'current',name:'home',verified:true,observed_at:195}}).returnEvidence,'Home verified · 5s ago');
});

test('setup reset reports are shown only for the current operation',()=>{
  const input={record:finished(),attempt:{id:'current'},setupBattle:{operation_id:'other',status:'failed',error:'No Home proof'}};
  assert.equal(WorkspaceStatus.operation(input).resetEvidence,'');
  input.setupBattle.operation_id='current';
  assert.equal(WorkspaceStatus.operation(input).resetEvidence,'Setup test battle return failed: No Home proof');
});

for (const [status,label] of Object.entries({starting:'Starting setup test battle',active:'Setup test battle active',
  ending:'Returning from the setup test battle',finished:'Setup test battle returned to Home',unknown:'Setup test battle state unconfirmed'})) {
  test('setup lifecycle '+status+' has operation-bound feedback',()=>{
    const input={record:finished(),attempt:{id:'current'},setupBattle:{operation_id:'current',status}};
    assert.equal(WorkspaceStatus.operation(input).resetEvidence,label);
    assert.equal(WorkspaceStatus.operation(input).returnEvidence,'Final screen unverified');
    input.setupBattle.operation_id='previous';
    assert.equal(WorkspaceStatus.operation(input).resetEvidence,'');
  });
}

test('running summaries show measured units and failed reads offer only a status retry',()=>{
  const model=WorkspaceStatus.operation({running:true,checkedAt:140,now:180,unavailable:'offline',record:{
    status:'running',started_at:100,updated_at:130,steps:[{id:'route_1',label:'Modules',status:'running',units:{label:'Tiles inspected',completed:12,total:40}}]
  }});
  const html=WorkspaceStatus.operationHTML(model);
  assert.match(html,/Tiles inspected: 12 \/ 40/);assert.equal(model.elapsed,'40s');
  assert.match(html,/onclick="pollCalibrate\(\)"/);assert.doesNotMatch(html,/onclick="(?:start|remap)/);
});

test('a worker failure drives both Recognition status text and its detailed timeline',()=>{
  const slots=new Map();
  const element=()=>({dataset:{},textContent:'',querySelector:()=>null,querySelectorAll:()=>[]});
  for(const name of ['#calib-report','#calib-phase2','#calib-progress','#calib-state'])slots.set(name,element());
  const timelines=[];
  const ctx=vm.createContext({WorkspaceStatus,S:{},Date,esc:String,$:name=>slots.get(name),
    renderWorkspaceStatus(){},calibrationBusy(){},observationFeedback(){},renderCalibrationIntent(){},
    updateWorkspaceRegion(){},assetLibraryHTML(){return '';},calibrationKnowledge(){return '';},
    renderScanTimeline:(selector,record)=>timelines.push({selector,record})});
  vm.runInContext(section('function calibrationMode(', 'function calibrationBusy('),ctx);
  ctx.calibReport({running:false,selection:{mode:'bootstrap'},operation:{status:'failed',error:{message:'Final verification failed'}},state:{phases:{bootstrap:finished()}}});
  assert.equal(slots.get('#calib-state').textContent,'Failed');
  assert.match(slots.get('#calib-progress').textContent,/Failed\. Final verification failed/);
  assert.doesNotMatch(slots.get('#calib-progress').textContent,/Calibration finished/);
  assert.equal(timelines.find(row=>row.selector==='#bootstrap-timeline').record.status,'error');
});

test('the offline Recognition fixture renders production controls without live request paths',async()=>{
  const rendered=await buildFixture('awaiting_apply');
  assert.match(rendered,/Profile:<\/b> Awaiting apply/);
  assert.match(rendered,/Final screen:<\/b> Home verified/);
  assert.match(rendered,/<header class="workspace-heading">[\s\S]*?id="client-remap"[\s\S]*?<\/header>/);
  assert.equal((rendered.match(/id="client-remap"/g)||[]).length,1);
  assert.doesNotMatch(rendered,/\son\w+=|<script|(?:src|href)="\/api\//);
  assert.match(rendered,/default-src 'none'/);
  const partial=await buildFixture('applied_partial');
  assert.match(partial,/Profile:<\/b> Discoveries applied/);
  assert.match(partial,/status-tag status-error/);
  assert.match(partial,/Two required controls still need capture/);
});
