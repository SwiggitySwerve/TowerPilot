/* Dashboard (#overview): the pure projections in dashboard-view.js (main row,
   day plan, last battle, attention), the page template, the feed summary, the
   Automation card's focus-safe regions (D2), the refused input switch (D3), the
   retained Start identity (D5, including the global action lock) and the
   Start-picker preview wiring. Offline: real page sections in vm contexts with
   fake DOM nodes and fake transport; no requests leave the test. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {html,section}=require('./helpers.cjs');
const LearningStore=require('../webui/learning-store.js');
const WorkspaceStatus=require('../webui/workspace-status.js');
const LearningView=require('../webui/learning-view.js');
const DashboardView=require('../webui/dashboard-view.js');

const config=(taps=true)=>({active_instance:'main',active_profile:'alice',instances:{main:{account:'alice',serial:'127.0.0.1:16384',allow_taps:taps}}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const BACKTICK=String.fromCharCode(96);
const NOW=1792500000;

/* --------------------------------------------------------------- main row */
/* A status that positively shows nothing holds the emulator: readable contract-1
   harvesting records with no collector or owner, and a process scan whose
   numbers agree with the harvest server clock (H2UI-R5-03). */
const QUIET=(extra={})=>({processes:[],process_refresh:{state:'fresh',age_sec:0.1,last_success_at:NOW-0.1,error:null},
  harvest:{version:1,server_time:NOW,desired:{choice:'off',enabled:false,revision:3},operation:null,owner:null,input_revoked:false,state:'off'},...extra});
test('the main row states what automation is doing; uncertain reads are last known, never a confident idle', () => {
  const fact=args=>DashboardView.automationFact(args);
  assert.deepEqual(fact({status:QUIET()}),{text:'Automation idle',tone:'idle'});
  assert.deepEqual(fact({status:{processes:[{runner:'orchestrator'}]}}),{text:'Automation running',tone:'ok'});
  assert.deepEqual(fact({status:QUIET({processes:[{pid:3,runner:'calibrate'}]})}),{text:'Automation idle · screen learning running',tone:'busy'});
  assert.deepEqual(fact({status:{processes:[{runner:'orchestrator'}],process_refresh:{state:'stale'}}}),{text:'Automation last known running',tone:'warn'});
  assert.deepEqual(fact({status:QUIET(),error:'timed out'}),{text:'Automation last known idle',tone:'warn'});
  // (H2UI-R5-03) idle needs positive evidence: no harvesting records, unreadable or unsupported ones, or scan numbers that disagree are unknown
  for (const [name,status] of [['no harvest',{processes:[]}],['harvest null',QUIET({harvest:null})],['version 2',QUIET({harvest:{...QUIET().harvest,version:2}})],
    ['status_failed',QUIET({harvest:{...QUIET().harvest,desired:null,code:'status_failed'}})],['state_unreadable',QUIET({harvest:{...QUIET().harvest,code:'harvest_state_unreadable'}})],
    ['label-only fresh scan',QUIET({process_refresh:{state:'fresh',age_sec:0,last_success_at:NOW-7}})],['no scan numbers',QUIET({process_refresh:{state:'fresh'}})],
    ['no process_refresh',QUIET({process_refresh:undefined})],['malformed owner',QUIET({harvest:{...QUIET().harvest,owner:{}}})]]) {
    assert.deepEqual(fact({status}),{text:'Automation state unknown',tone:'warn'},name);
    // (a recorded holder, even a malformed one, is the last known state; never idle)
    assert.deepEqual(fact({status,error:'timed out'}),{text:name === 'malformed owner' ? 'Automation last known state unknown' : 'Automation state unknown',tone:'warn'},name+' (failed read)');
  }
  assert.deepEqual(fact({status:{processes:[{pid:3,runner:'calibrate'}]}}),{text:'Automation state unknown · screen learning running',tone:'warn'});
  // a stale scan over otherwise readable records is the server's last known
  assert.deepEqual(fact({status:QUIET({process_refresh:{state:'stale',age_sec:30,last_success_at:NOW-30}})}),{text:'Automation last known idle',tone:'warn'});
  assert.deepEqual(fact({status:{processes:[],process_refresh:{state:'unknown'}}}),{text:'Automation state unknown',tone:'warn'});
  assert.deepEqual(fact({}),{text:'Automation not checked',tone:'warn'});
  assert.deepEqual(fact({error:'offline'}),{text:'Automation state unavailable',tone:'warn'});
  assert.equal(DashboardView.factHTML({text:'A <b>',tone:'ok'}),'<p class="dashboard-fact" data-tone="ok"><span class="dashboard-dot" aria-hidden="true"></span>A &lt;b&gt;</p>');
});

test('runs that still need screens are named once, escaped, with the way to learn them', () => {
  const runs={bp_farm:{label:'Farm'},bp_shard:{label:'Shard <farming>'},combo:{label:'Combo'}};
  const out=DashboardView.needsScreensHTML({runs,readiness:{bp_farm:{ready:true},bp_shard:{ready:false},combo:{ready:false}}});
  assert.match(out,/Needs screens: Shard &lt;farming&gt; <a href="#screens" data-workspace-section="run-preparation">Learn screens<\/a>/);
  assert.doesNotMatch(out,/Combo|Farm,/);
  assert.equal(DashboardView.needsScreensHTML({runs,readiness:{bp_farm:{ready:true}}}),'');
});

test('"Now" states the drivers, the tracked battle and that saved settings are not collection', () => {
  const runs={bp_farm:{label:'Farm'}};
  const farm={pid:1,runner:'orchestrator',operation:{context:{selected_run:'bp_farm'}}};
  const now=args=>DashboardView.activity({runs,...args});
  // collection is the Gems row's fact: the main row never says "no gem collection running" (H2UI-R5-03)
  assert.deepEqual(now({status:QUIET(),battleState:'none'}),{text:'Automation idle',tone:'idle',detail:'no tracked battle'});
  assert.deepEqual(now({status:{processes:[]},battleState:'none'}),{text:'Automation state unknown',tone:'warn',detail:"no tracked battle · this server doesn't report its harvesting records"});
  assert.equal(now({status:{processes:[farm]},battleState:'tracked',battle:{status:'active',runtime:{observed_wave:1429}}}).detail,'Farm · battle at wave 1429');
  assert.equal(now({status:{processes:[farm]},battleState:'tracked',battle:{status:'prepared'}}).detail,'Farm · waiting to observe the battle');
  assert.equal(now({status:{processes:[{pid:2,runner:'gem_collector'}]},battleState:'none'}).detail,'Diamond collector · no tracked battle');
  assert.equal(now({status:QUIET({processes:[{pid:3,runner:'calibrate'}]}),battleState:'none',operation:{running:true,label:'Screen learning',current:{label:'Read modules'}}}).detail,
    'no tracked battle · Screen learning: Read modules');
  // an uncertain read claims nothing about collection
  assert.equal(now({status:{processes:[],process_refresh:{state:'stale'}},battleState:'failed'}).detail,"battle status unavailable · this server doesn't report its harvesting records");
  assert.equal(now({error:'HTTP 502'}).detail,'');
});

test('Edit in Runs opens the run the saved preview shows (Runs names it without the bp_ prefix)', () => {
  const ctx=vm.createContext({S:{profile:{blueprints:{coin_default:{},bp_special:{}}}},document:{addEventListener:()=>{}}});
  vm.runInContext(section('function runsBlueprint(','document.addEventListener(\'click\', event => {\n  const link = event.target?.closest'),ctx);
  assert.equal(ctx.runsBlueprint('bp_coin_default'),'coin_default');
  assert.equal(ctx.runsBlueprint('bp_special'),'bp_special');
  assert.equal(ctx.runsBlueprint('bp_missing'),'');
  assert.equal(ctx.runsBlueprint(''),'');
  // every Edit in Runs link goes through openRunsFor, which navigates only to a run it resolved
  // (the profile re-read case is exercised end to end in harvesting.test.cjs, H2UI-R2-03)
  assert.match(html,/closest\?\.\('#live-run-controls \.rw-edit-link, \.dashboard-run-link'\)[\s\S]{0,200}openRunsFor\(link\.dataset\?\.run \|\| S\.previewName\)/);
  assert.match(section('async function openRunsFor(','document.addEventListener(\'click\', event => {\n  const link = event.target?.closest'),
    /if \(!blueprint\) \{[\s\S]*?return;\s*\}\s*location\.hash = '#runs';\s*await selectRunControls\(blueprint\);/);
});

/* --------------------------------------------------------------- day plan */
test('the day plan line restates the recorded decision; the clock boundary is a proposal, not a promised switch', () => {
  const checkedAt=NOW*1000;
  const available={availability:'available',winner:{label:'Farm'},next_clock_boundary:{at:NOW+4320,kind:'clock_proposal',guarantees_handoff:false},server_time:NOW};
  const plan=DashboardView.scheduleSummary({data:available,error:'',checkedAt},NOW+60);
  assert.equal(plan.text,'Farm now');
  assert.match(plan.detail,/^next check .+ \(in 1h 11m\); a switch waits for the run to end$/);
  // the remaining time follows the server clock, not the browser's
  assert.match(DashboardView.scheduleSummary({data:{...available,server_time:NOW-600},error:'',checkedAt},NOW).detail,/in 1h 22m/);
  assert.equal(DashboardView.scheduleSummary({data:{...available,winner:null},error:'',checkedAt},NOW).text,'No block open now');
  assert.deepEqual(DashboardView.scheduleSummary({data:{availability:'unavailable',reason:'scheduler_not_observed'},error:'',checkedAt},NOW),{text:'Not running',tone:'',detail:''});
  assert.equal(DashboardView.scheduleSummary({data:{availability:'unavailable',reason:'scheduler_worker_unavailable'},error:'',checkedAt},NOW).tone,'warn');
  assert.equal(DashboardView.scheduleSummary({data:{availability:'unavailable',error:'Profile <x> unreadable',reason:'plan_unavailable'},error:'',checkedAt},NOW).text,'Plan unavailable: Profile <x> unreadable');
  const stale=DashboardView.scheduleSummary({data:{availability:'stale',observed_winner:{label:'Shard'},observed_at:NOW-300,server_time:NOW},error:'',checkedAt},NOW);
  assert.deepEqual(stale,{text:'Status stale · last known Shard · observed 5m ago',tone:'warn',detail:''});
  assert.deepEqual(DashboardView.scheduleSummary({data:null,error:'HTTP 502',checkedAt},NOW),{text:'Status unavailable: HTTP 502',tone:'warn',detail:''});
  // a failed re-read keeps the last answer, labelled as last known
  assert.equal(DashboardView.scheduleSummary({data:available,error:'HTTP 502',checkedAt},NOW).text,'Last known · Farm now');
  assert.equal(DashboardView.scheduleSummary(null,NOW).text,'Not checked yet');
});

/* ------------------------------------------------------------ last battle */
test('the last battle line shows the newest finished record with time and status and states missing evidence', () => {
  const rows=[{id:'live',status:'active',label:'Farm'},{id:'b2',status:'interrupted',label:'Farm',ended_at:NOW-8*3600,end_reason:'driver_observation_lost',final_wave:null,wave:null,result:'unknown'},
    {id:'b1',status:'ended',label:'Farm',ended_at:NOW-9*3600,end_reason:'observed_results',final_wave:8996,result:'unknown'}];
  assert.equal(DashboardView.lastBattle(rows).id,'b2');
  assert.equal(DashboardView.lastBattle([{status:'prepared'}]),null);
  const interrupted=DashboardView.lastBattleSummary({battle:rows[1],loaded:true,error:''},NOW);
  assert.match(interrupted.text,/^Farm · Interrupted .+ \(8h ago\) · driver observation lost · wave not recorded$/);
  assert.equal(interrupted.tone,'');   // a recorded interruption is a fact, not an alarm; only a failed read is uncertain
  const ended=DashboardView.lastBattleSummary({battle:rows[2],loaded:true,error:''},NOW);
  assert.match(ended.text,/^Farm · Ended .+ \(9h ago\) · wave 8996$/);
  assert.doesNotMatch(ended.text,/gem|result unknown/i);   // gem evidence stays on History, which owns its rule
  assert.match(DashboardView.lastBattleSummary({battle:{status:'ended',label:'Farm',updated_at:NOW-30,wave:5273,result:'victory'},loaded:true,error:''},NOW).text,/last observed wave 5273 · victory$/);
  assert.deepEqual(DashboardView.lastBattleSummary({battle:null,loaded:true,error:''},NOW),{text:'No recorded battle yet',tone:''});
  assert.deepEqual(DashboardView.lastBattleSummary({battle:null,loaded:false,error:'HTTP 500'},NOW),{text:'Unavailable: HTTP 500',tone:'warn'});
  assert.match(DashboardView.lastBattleSummary({battle:rows[2],loaded:true,error:'HTTP 500'},NOW).text,/^Last known · Farm · Ended/);
  const next=DashboardView.nextHTML({schedule:{data:{availability:'unavailable',reason:'scheduler_not_observed'},error:'',checkedAt:0},last:{battle:{...rows[2],label:'<Farm>'},loaded:true,error:''},now:NOW});
  assert.match(next,/<span class="dashboard-next-key">Day plan<\/span><span class="dashboard-next-value">Not running<\/span><a href="#schedule">Schedule<\/a>/);
  assert.match(next,/<span class="dashboard-next-key">Last battle<\/span><span class="dashboard-next-value">&lt;Farm&gt; · Ended[^<]*<\/span><a href="#history">History<\/a>/);
});

/* ------------------------------------------------------------- attention */
test('attention lists at most three canonical items with their way forward, never the raw event tail', () => {
  const failed=WorkspaceStatus.operation({attempt:{id:'op-1',status:'failed',error:{message:"No fresh matching control for 'open intro sprint dialog'"},updated_at:NOW-60},
    setupBattle:{operation_id:'op-1',status:'unknown',reason:"No fresh matching control for 'open intro sprint dialog'"},
    finalScreen:{operation_id:'op-1',verified:false,name:'unknown'},now:NOW});
  const setupBattle={operation_id:'op-1',status:'unknown',reason:"No fresh matching control for 'open intro sprint dialog'"};
  const guard={blocks_launch:true,code:'setup_battle_unresolved',operation_id:'op-1',message:'long server sentence'};
  const items=DashboardView.attention({status:{processes:[],setup_battle_guard:guard},operation:failed,operationAt:NOW-60,setupBattle},NOW);
  assert.equal(items.length,1);
  assert.equal(items[0].tone,'bad');
  // a human summary of the outcome and its impact leads; the worker's own message is detail
  assert.match(items[0].text,/^Screen learning failed at .+\. Its test battle was never confirmed back on Home, so Start and Collect stay off until a later setup verifies Home\.$/);
  assert.equal(items[0].detail,"Reported: No fresh matching control for 'open intro sprint dialog'");
  assert.deepEqual(JSON.parse(JSON.stringify(items[0].links)),[{href:'#screens',section:'workspace-operation',label:'Setup details'},{href:'#runtime?operation_id=op-1',label:'Events'}]);
  // the same record without a guard citing it states only what was recorded
  assert.match(DashboardView.attention({status:{processes:[]},operation:failed,operationAt:NOW-60,setupBattle},NOW)[0].text,/Its test battle was not confirmed back on Home\.$/);
  const steps=WorkspaceStatus.operation({attempt:{id:'op-5',status:'failed',error:{message:'x'}},record:{status:'error',steps:[{id:'s',label:'Open the run',status:'error'}]},now:NOW});
  assert.match(DashboardView.attention({status:{processes:[]},operation:steps})[0].text,/failed during “Open the run”\. Its final screen was not verified\.$/);
  const html=DashboardView.attentionHTML(items);
  assert.match(html,/<a href="#runtime\?operation_id=op-1">Events<\/a><small class="dashboard-attention-detail">Reported: No fresh matching control/);
  // status read problems lead, each with its retry
  const many=DashboardView.attention({status:{processes:[],process_refresh:{state:'stale'}},statusError:'timed out',operation:{...failed,unavailable:'HTTP 502'},operationAt:NOW},NOW);
  assert.deepEqual(many.map(item=>item.action?.call || item.links?.[0]?.href),['pollDashboard(true)','pollCalibrate()','#screens']);
  assert.equal(DashboardView.attention({status:{processes:[],process_refresh:{state:'unknown'}}})[0].action.call,'loadStatus()');
  // restoration pending is its own item; a running or a successful operation is not attention
  const restore=WorkspaceStatus.operation({attempt:{id:'op-2',status:'restoration_required'},now:NOW});
  assert.match(DashboardView.attention({status:{processes:[]},operation:restore})[0].text,/^Equipment restoration pending: other automation is blocked until the saved equipment is restored\.$/);
  assert.deepEqual(DashboardView.attention({status:{processes:[]},operation:WorkspaceStatus.operation({attempt:{id:'op-3',status:'succeeded'},record:{status:'done',steps:[]}})}),[]);
  assert.deepEqual(DashboardView.attention({status:{processes:[]},operation:WorkspaceStatus.operation({attempt:{id:'op-4',status:'running'},running:true})}),[]);
  const out=DashboardView.attentionHTML([...many,{tone:'warn',text:'fourth <item>'}]);
  assert.equal((out.match(/<li /g) || []).length,3);
  assert.match(out,/Needs attention · 1 more on Runtime/);
  assert.match(out,/<a class="dashboard-attention-runtime" href="#runtime">Runtime events<\/a>/);
  assert.match(out,/<button class="small ghost" onclick="pollDashboard\(true\)">Retry status<\/button>/);
  assert.doesNotMatch(out,/fourth/);
  assert.match(DashboardView.attentionHTML([]),/Nothing needs attention\.[\s\S]*href="#runtime"/);
});

/* ------------------------------------------------------- template, header */
test('the shared header holds the one page title and no decorative branding', () => {
  const header=section('<header class="topbar">','</header>');
  assert.match(header,/<span class="brand">Tower Pilot<\/span>/);
  assert.match(header,/<h1 id="page-title">Dashboard<\/h1>/);
  assert.doesNotMatch(header,/\u{1F5FC}/u);
  assert.equal(html.split('id="page-title"').length-1,1);
  assert.match(section('<header class="page-heading">','</header>'),/^<header class="page-heading"><p id="page-description">/);
});

test('the Dashboard template is flat: main row and start, one live host, day plan, attention, and a feed with settings on demand', () => {
  const template=section('  $("#panel-overview").innerHTML = ','</div>'+BACKTICK+';');
  assert.doesNotMatch(template,/requirementHTML|game-requirement|class="events|id="events"|Recent activity|id="current-battle-controls"[^>]*hidden/);
  assert.equal((template.match(/<article/g) || []).length,1);   // only the get-started card, shown until setup is done
  assert.match(template,/id="card-runner"[\s\S]*id="runner-body"[\s\S]*id="control-blockers"[\s\S]*id="current-battle-controls" class="dashboard-section" aria-label="Routines and shopping"><div id="live-run-controls"><\/div>[\s\S]*id="dashboard-next"[\s\S]*id="dashboard-attention"/);
  assert.match(template,/id="stream-summary"[\s\S]*id="stream-slot"[\s\S]*id="stream-alert"[\s\S]*<details class="dashboard-stream-settings">[\s\S]*id="stream-fps"[\s\S]*id="stream-reconnect"[\s\S]*id="stream-availability"[\s\S]*id="stream-stats"[\s\S]*<\/details>/);
  // no gather-derived collection summary and no disclosure around the start row
  assert.doesNotMatch(html,/run-collection-summary|Collection for this run|About these actions|<summary>Start automation/);
});

test('the feed readout restates the delivery verdict; only failures and uncertainty raise an alert', () => {
  const ctx=vm.createContext({});
  vm.runInContext(section('function streamSummary(','function renderStreamSummary('),ctx);
  const s=args=>({...ctx.streamSummary({on:true,online:true,session:'s',...args})});
  assert.deepEqual(s({on:false}),{tone:'muted',text:'Preview off',alert:''});
  assert.deepEqual(s({online:false}),{tone:'bad',text:'Emulator offline',alert:''});
  assert.deepEqual(s({online:false,checked:false}),{tone:'warn',text:'Connection not confirmed',alert:''});   // unknown is not offline
  assert.doesNotMatch(WorkspaceStatus.screenPlaceholderHTML(null),/offline/);
  assert.deepEqual(s({recovery:{state:'delivering'},fps:14.83}),{tone:'ok',text:'Live \u00b7 14.8 FPS',alert:''});
  assert.deepEqual(s({recovery:{state:'failed',message:'Preview delivery failed: x'}}),{tone:'bad',text:'Preview failed',alert:'Preview delivery failed: x'});
  assert.deepEqual(s({recovery:{state:'unknown',message:'Preview delivery is unconfirmed.'}}),{tone:'warn',text:'Delivery unknown',alert:'Preview delivery is unconfirmed.'});
  assert.equal(s({recovery:{state:'unconfirmed',message:'waiting'}}).alert,'');
  assert.equal(s({}).text,'Connecting\u2026');
  assert.equal(s({session:null}).text,'Delivery unconfirmed');
});

test('api() carries the server refusal code with the status', async () => {
  const ctx=vm.createContext({globalThis:{crypto:{randomUUID:()=>'r'}},reportDiagnostic:()=>{},AbortController,setTimeout,clearTimeout,
    fetch:async()=>({ok:false,status:409,json:async()=>({ok:false,code:'action_lock',error:'Another action is in progress; wait for its result'})})});
  vm.runInContext(section('async function api(','const post = '),ctx);
  const error=await ctx.api('/api/control',{method:'POST'}).catch(e=>e);
  assert.equal(error.status,409);assert.equal(error.code,'action_lock');assert.equal(error.message,'Another action is in progress; wait for its result');
  ctx.fetch=async()=>({ok:false,status:400,json:async()=>({ok:false,error:'unknown preset'})});
  assert.equal((await ctx.api('/api/control',{method:'POST'}).catch(e=>e)).code,undefined);
});

/* --------------------------------- Start picker preview and run-end reads */
function previewPage(){
  const calls=[],select={value:'bp_farm'};
  const ctx=vm.createContext({S:{config:config(),runs:{bp_farm:{label:'Farm'},combo:{label:'Combo (day plan)'}}},LearningStore,
    $:key=>key==='#start-preset'?select:null,renderRunReady:()=>calls.push(['ready']),renderActivity:()=>calls.push(['activity']),
    RunWorkspace:{create:options=>({preview:(name,opts)=>calls.push(['preview',name,JSON.parse(JSON.stringify(opts))]),options})},
    api:async()=>({}),toast:()=>{}});
  vm.runInContext(section('const runWorkspace = ','const diagnosticsView = '),ctx);
  return {ctx,calls,select};
}
test('the Start picker previews its run once per selection and context; a rebuild forces one re-read; combo clears it', () => {
  const p=previewPage();
  p.ctx.previewStartRun();p.ctx.previewStartRun();
  assert.deepEqual(p.calls,[['preview','bp_farm',{force:false,label:'Farm'}]]);
  p.ctx.S.previewForce=true;p.ctx.previewStartRun();
  assert.deepEqual(p.calls.at(-1),['preview','bp_farm',{force:true,label:'Farm'}]);
  p.ctx.previewStartRun();assert.equal(p.calls.length,2);
  p.ctx.S.config.active_profile='bob';p.ctx.previewStartRun();
  assert.equal(p.calls.length,3);
  p.select.value='combo';p.ctx.previewStartRun();
  assert.deepEqual(p.calls.at(-1).slice(0,2),['preview','']);
  assert.equal(p.calls.at(-1)[2].label,'Combo (day plan)');assert.match(p.calls.at(-1)[2].message,/day plan picks a run/);
});
test('only a ready preview for the selected run in the current context enables Collect; a new selection clears it', () => {
  const p=previewPage(),context=LearningStore.context(p.ctx.S.config).id,snapshot={settings:{routines:{ad_gems:{enabled:true}}}};
  p.ctx.previewStartRun();
  p.ctx.receivePreview(snapshot,{status:'ready',blueprint:'bp_farm',context});
  assert.ok(p.calls.some(call=>call[0]==='ready'));
  vm.runInContext(section('function selectedPreview(','/* Collect diamonds only collects'),p.ctx);
  assert.equal(p.ctx.selectedPreview('bp_farm'),p.ctx.S.startPreview.snapshot);
  p.ctx.receivePreview(null,{status:'loading',blueprint:'bp_farm',context});
  assert.equal(p.ctx.selectedPreview('bp_farm'),null);
  p.ctx.receivePreview(snapshot,{status:'ready',blueprint:'bp_farm',context:'old-context'});
  assert.equal(p.ctx.selectedPreview('bp_farm'),null);
  p.ctx.receivePreview(snapshot,{status:'ready',blueprint:'bp_farm',context});
  p.select.value='bp_shard';p.ctx.previewStartRun();
  assert.equal(p.ctx.S.startPreview,null);           // the previous run's eligibility never carries over
});
test('a tracked battle that ends or is replaced schedules one re-read of the latest record', () => {
  const p=previewPage();
  p.ctx.receiveBattle({id:'b1'});assert.equal(p.ctx.S.lastBattleDue,undefined);assert.equal(p.ctx.S.battleActive,true);
  p.ctx.receiveBattle({id:'b1'});assert.equal(p.ctx.S.lastBattleDue,undefined);
  p.ctx.receiveBattle(null);assert.equal(p.ctx.S.lastBattleDue,true);assert.equal(p.ctx.S.battleActive,false);
});

/* ---------------------------------------------- schedule and history reads */
function clockPage(processes=[]){
  let now=0;const reads={schedule:[],last:[]};
  const ctx=vm.createContext({S:{view:'home',tab:'overview',battleActive:false,config:config(),status:{processes}},LearningStore,
    Date:{now:()=>now},document:{hidden:false},loadStatus(){},pollCalibrate(){},runWorkspace:{poll(){}}});
  vm.runInContext(section('function pollDashboard(','/* Shared status reads'),ctx);
  ctx.loadSchedule=()=>{reads.schedule.push(now);ctx.S.schedule={context:LearningStore.context(ctx.S.config).id,data:ctx.nextSchedule};};
  ctx.loadLastBattle=()=>{reads.last.push(now);ctx.S.lastBattleDue=false;ctx.S.lastBattle={context:LearningStore.context(ctx.S.config).id};};
  return {ctx,reads,tick:time=>{now=time;ctx.pollDashboard();}};
}
test('the day plan is read once per context while idle and every 15 s only while a run driver or plan is reported', () => {
  const p=clockPage();p.ctx.nextSchedule={availability:'unavailable'};
  for(let time=0;time<=60000;time+=250)p.tick(time);
  assert.deepEqual(p.reads.schedule,[0]);
  p.ctx.S.status.processes=[{pid:1,operation:{kind:'run'}}];
  for(let time=60250;time<=90000;time+=250)p.tick(time);
  assert.deepEqual(p.reads.schedule,[0,60250,75250]);
  p.ctx.S.config.active_profile='bob';p.ctx.S.status.processes=[];p.tick(90250);
  assert.deepEqual(p.reads.schedule,[0,60250,75250,90250]);   // a new context reads at once
  p.ctx.document.hidden=true;p.ctx.nextSchedule={availability:'available'};p.ctx.S.schedule.data=p.ctx.nextSchedule;
  for(let time=90500;time<=200000;time+=250)p.tick(time);
  assert.equal(p.reads.schedule.length,4);                     // hidden pages never read it
});
test('the latest battle is read on entry and again only when a tracked battle ended', () => {
  const p=clockPage();
  for(let time=0;time<=30000;time+=250)p.tick(time);
  assert.deepEqual(p.reads.last,[0]);
  p.ctx.S.lastBattleDue=true;p.tick(30250);
  assert.deepEqual(p.reads.last,[0,30250]);
  for(let time=30500;time<=60000;time+=250)p.tick(time);
  assert.equal(p.reads.last.length,2);
});
test('day plan and battle reads are context fenced and keep the last answer, marked, when a re-read fails', async () => {
  let reply;const ctx=vm.createContext({S:{config:config()},LearningStore,DashboardView,Date,renderDashboardSummary:()=>{},
    api:async()=>reply()});
  vm.runInContext(section('async function loadSchedule(','/* Shared status reads'),ctx);
  const context=LearningStore.context(ctx.S.config).id;
  reply=()=>({availability:'available',winner:{label:'Farm'}});await ctx.loadSchedule();
  assert.equal(ctx.S.schedule.context,context);assert.equal(ctx.S.schedule.data.winner.label,'Farm');
  reply=()=>{throw new Error('HTTP 502');};await ctx.loadSchedule();
  assert.equal(ctx.S.schedule.error,'HTTP 502');assert.equal(ctx.S.schedule.data.winner.label,'Farm');
  let release;reply=()=>new Promise(resolve=>{release=resolve;});
  const job=ctx.loadSchedule();ctx.S.config.active_profile='bob';release({availability:'unavailable'});await job;
  assert.equal(ctx.S.schedule.context,context);               // a reply for the previous context is discarded
  reply=()=>({battles:[{id:'live',status:'active'},{id:'b1',status:'ended'}]});await ctx.loadLastBattle();
  assert.equal(ctx.S.lastBattle.battle.id,'b1');assert.equal(ctx.S.lastBattle.loaded,true);
  reply=()=>{throw new Error('HTTP 500');};await ctx.loadLastBattle();
  assert.equal(ctx.S.lastBattle.battle.id,'b1');assert.equal(ctx.S.lastBattle.error,'HTTP 500');
});

test('a failed first status read still draws the main row as unavailable, with Start held and no Stop guessed', () => {
  const p=runnerPage(null);
  p.ctx.S.statusError='HTTP 502';
  p.ctx.renderRunner();
  assert.match(p.body.innerHTML,/data-tone="warn"><span class="dashboard-dot" aria-hidden="true"><\/span>Automation state unavailable<\/p>/);
  // turning game input off stays reachable without a status read; turning it on does not
  assert.match(p.body.innerHTML,/id="automation-access" checked  onchange=/);
  p.ctx.S.config.instances.main.allow_taps=false;p.body.dataset.key='';p.ctx.renderRunner();
  assert.match(p.body.innerHTML,/id="automation-access"  disabled onchange=/);
  assert.doesNotMatch(p.body.innerHTML,/Stop now|killPid/);
  assert.match(p.body.innerHTML,/id="start-run"/);
  const header=WorkspaceStatus.headerHTML({config:config(),error:'HTTP 502'});
  assert.match(header,/<span class="dot warn" aria-hidden="true"><\/span><span class="header-connection">Status unavailable<\/span>/);
});

/* ------------------------------------------- D2: focus-safe Automation card */
function runnerPage(status, cfg=config()){
  const writes=[];
  const startRegion={querySelector:()=>null};
  const select={id:'start-preset',tagName:'SELECT',closest:selector=>selector==='.next-run'?startRegion:null};
  const statusRegion={_html:'',set innerHTML(value){this._html=value;writes.push('status');},get innerHTML(){return this._html;}};
  const body={dataset:{},_html:'',set innerHTML(value){this._html=value;writes.push('body');},get innerHTML(){return this._html;},
    contains:element=>element===select,querySelector:selector=>selector==='[data-runner-status]'?statusRegion:null,querySelectorAll:()=>[]};
  let ready=0,previews=0;
  const ctx=vm.createContext({S:{status,config:cfg,runs:{bp_farm:{label:'Farm'}},runReadiness:{bp_farm:{ready:true}},readinessFresh:true,
      readinessContext:LearningStore.context(cfg).id},LearningStore,WorkspaceStatus,LearningView,DashboardView,document:{activeElement:null},
    $:key=>key==='#runner-body'?body:undefined,esc:String,renderRunReady:()=>{ready++;},previewStartRun:()=>{previews++;},
    // (the Gems row's run picker reads a run's saved settings: GET only, never answered here)
    selectedPreview:()=>null,api:()=>new Promise(()=>{})});
  vm.runInContext(section('function renderRunner(){','function renderRunReady('),ctx);
  return {ctx,body,select,statusRegion,writes,ready:()=>ready,previews:()=>previews};
}

test('D2: with the run picker focused, a process exit still removes Stop now without replacing the picker', () => {
  const p=runnerPage({device_state:'device',processes:[{pid:42,runner:'orchestrator',created:1790000000.25}]});
  p.ctx.renderRunner();
  assert.deepEqual(p.writes,['body']);
  // an untracked runner is stopped by the identity this row was drawn with (pid and created)
  assert.match(p.body.innerHTML,/<button class="small danger" title="Stops this runner process if it is still the one listed here\. The game battle keeps playing\." data-pid="42" data-created="1790000000\.25" onclick="killRunner\(this\)">Stop now<\/button>/);
  assert.match(p.body.innerHTML,/<span class="runner-key">Now<\/span><div class="runner-line"><div id="runner-activity"><p class="dashboard-fact" data-tone="ok"><span class="dashboard-dot" aria-hidden="true"><\/span>Automation running<span class="dashboard-fact-detail"> · orchestrator<\/span><\/p><\/div>/);
  assert.equal(p.previews(),1);                       // a rebuilt picker asks for its run's preview
  p.ctx.document.activeElement=p.select;
  p.ctx.S.status={device_state:'device',...QUIET()};
  p.ctx.renderRunner();
  assert.deepEqual(p.writes,['body','status']);   // the start region (and its select) was not rewritten
  assert.doesNotMatch(p.statusRegion.innerHTML,/Stop now/);
  assert.match(p.statusRegion.innerHTML,/Automation idle/);
  assert.equal(p.ready(),2);
  assert.equal(p.previews(),1);
  p.ctx.renderRunner();                              // nothing changed while still focused: no write
  assert.deepEqual(p.writes,['body','status']);
  p.ctx.document.activeElement=null;                // focus left: the start region catches up once
  p.ctx.renderRunner();p.ctx.renderRunner();
  assert.deepEqual(p.writes,['body','status','body']);
  assert.match(p.body.innerHTML,/<div class="next-run">\s*<div class="runner-row"><label class="runner-key" for="start-preset">Next start<\/label>/);
  assert.doesNotMatch(p.body.innerHTML,/<details class="next-run"|runner-help/);
});

test('D2: an unchanged start region is marked current while focused, so leaving it causes no rewrite', () => {
  const p=runnerPage({device_state:'device',processes:[],stop_flag:false});
  p.ctx.renderRunner();
  p.ctx.document.activeElement=p.select;
  p.ctx.S.config.instances.main.allow_taps=false;   // input switch: a status-region change only
  p.ctx.renderRunner();
  assert.deepEqual(p.writes,['body','status']);
  assert.doesNotMatch(p.statusRegion.innerHTML,/id="automation-access" checked/);
  p.ctx.document.activeElement=null;
  p.ctx.renderRunner();
  assert.deepEqual(p.writes,['body','status','body']); // the start blockers changed too (input disabled), so it catches up
});

/* --------------------------------------------- D3: refused input switch */
test('D3: a refused Allow-automation change redraws the switch from the saved setting and re-enables it', async () => {
  const p=runnerPage({device_state:'device',processes:[]},config(false));
  const toasts=[],posted=[];let loads=0,disabledDuringPost=null;
  const input={disabled:false};
  // the switch writes through observedPost (a status-plane write) over the page's api()
  Object.assign(p.ctx,{toast:message=>toasts.push(message),loadHomeData:async()=>{loads++;},setTimeout:()=>1,clearTimeout:()=>{},refreshWorkspaceStatus:()=>{},
    api:async(path,opts)=>{posted.push([path,JSON.parse(opts.body)]);disabledDuringPost=input.disabled;throw Object.assign(new Error('Stop running automation first.'),{status:409});}});
  vm.runInContext(section('async function setAutomationAccess(','async function checkRun('),p.ctx);
  p.ctx.renderRunner();
  assert.doesNotMatch(p.body.innerHTML,/id="automation-access" checked/);
  const pending=p.ctx.setAutomationAccess(true,input);
  // the turn-on in flight is drawn at once: the switch shows it, still reachable for turning off
  assert.match(p.body.innerHTML,/<input type="checkbox" id="automation-access" checked\s+onchange=/);
  await p.ctx.setAutomationAccess(true,input);       // a second change while one is in flight sends nothing
  await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(posted)),[['/api/automation-access',{enabled:true}]]);
  // a turn-on in flight leaves the switch reachable so it can be turned off at once
  // (harvesting.test.cjs "R3 HIGH B"); a second turn-on is refused by S.accessPending above
  assert.equal(disabledDuringPost,false);
  assert.deepEqual(toasts,['Stop running automation first.']);
  assert.equal(loads,1);                              // the saved setting is re-read even after a refusal
  assert.equal(p.ctx.S.automationAccessBusy,false);
  assert.deepEqual(p.writes,['body','body','body']);  // drawn, drawn pending, redrawn from the saved, unchanged config
  assert.match(p.body.innerHTML,/<input type="checkbox" id="automation-access"\s+onchange=/);
});

/* ------------------------------------------- D5: retained Start identity */
function startPage(replies, preset={value:'bp_farm'}){
  let n=0;const bodies=[],toasts=[];let readyRenders=0;
  const ctx=vm.createContext({S:{config:config()},LearningStore,crypto:{randomUUID:()=>'key-'+(++n)},$:()=>preset,renderRunReady:()=>{readyRenders++;},
    api:async()=>({ready:true}),post:async(path,body)=>{bodies.push(body);return replies[bodies.length-1]();},toast:message=>toasts.push(message),loadStatus:()=>{}});
  vm.runInContext(section('async function startGemsOnly(){','async function ctl('),ctx);
  return {ctx,bodies,toasts,preset,readyRenders:()=>readyRenders};
}
test('D5: a Start retried after a lost reply replays the same idempotency key; a definitive answer releases it', async () => {
  const p=startPage([()=>{throw new Error('Failed to fetch');},()=>({operation_id:'op-7aaaaaaa-1'}),()=>{throw Object.assign(new Error('An operation already owns this device'),{status:409});},()=>({operation:{id:'op-8bbbbbbb-2'}})]);
  await p.ctx.startPreset();
  assert.ok(p.ctx.S.startIntent);
  assert.equal(p.ctx.S.startIntent.error,'Failed to fetch');   // shown beside the buttons until answered
  await p.ctx.startPreset();
  assert.equal(p.bodies[1].idempotency_key,p.bodies[0].idempotency_key);
  assert.equal(p.ctx.S.startIntent,null);
  await p.ctx.startPreset();
  assert.equal(p.bodies[2].idempotency_key,'key-2');
  assert.equal(p.ctx.S.startIntent,null);              // a 4xx is definitive: the next Start is a new request
  p.preset.value='bp_shard';
  await p.ctx.startPreset();
  assert.equal(p.bodies[3].idempotency_key,'key-3');
  assert.equal(p.bodies[3].preset,'bp_shard');
  assert.deepEqual(p.toasts,['Failed to fetch','Start accepted · operation op-7aaaa','An operation already owns this device','Start accepted · operation op-8bbbb']);
  assert.equal(p.readyRenders(),8);                 // each Start redraws when its readiness check begins and after its answer
  await flush();
});
test('D5: the global action lock keeps the Start and Collect intents (outcome unknown); the identical retry replays them', async () => {
  const lock=()=>{throw Object.assign(new Error('Another action is in progress; wait for its result'),{status:409,code:'action_lock'});};
  const p=startPage([()=>{throw new Error('Failed to fetch');},lock,()=>({operation_id:'op-9'}),lock,lock,()=>({operation:{id:'c'}})]);
  await p.ctx.startPreset();await p.ctx.startPreset();
  assert.equal(p.bodies[1].idempotency_key,'key-1');
  assert.equal(p.ctx.S.startIntent?.body.idempotency_key,'key-1');     // a lock refusal is not proof the first attempt was not recorded
  assert.equal(p.ctx.S.startIntent.error,'Another action is in progress; wait for its result');
  await p.ctx.startPreset();
  assert.equal(p.bodies[2].idempotency_key,'key-1');assert.equal(p.ctx.S.startIntent,null);
  await p.ctx.startGemsOnly();await p.ctx.startGemsOnly();
  assert.equal(p.bodies[3].idempotency_key,p.bodies[4].idempotency_key);
  assert.equal(p.ctx.S.gemsStartIntent.error,'Another action is in progress; wait for its result');
  await p.ctx.startGemsOnly();
  assert.equal(p.bodies[5].idempotency_key,p.bodies[3].idempotency_key);assert.equal(p.ctx.S.gemsStartIntent,null);
  // a setup-battle admission refusal is definite: the next press is a new request
  p.ctx.post=async(path,body)=>{p.bodies.push(body);throw Object.assign(new Error('Setup test battle unresolved.'),{status:409,code:'setup_battle_unresolved'});};
  await p.ctx.startGemsOnly();assert.equal(p.ctx.S.gemsStartIntent,null);
});
