/* Roadmap item 2 (persistent gem harvesting), Dashboard side: the harvest
   status projection (contract version 1), the Gems row controls and their
   frozen requests, the person-only collection handoff, the shared owner
   refusal notice, game-input revocation feedback and the collector-to-run
   handover. Offline: real page sections (including the real api() transport)
   in vm contexts, fake DOM nodes and a fake fetch; nothing leaves the test.
   Every response family of the backend's generated contract fixture
   backend/tests/fixtures/harvest_status_v1.json is replayed through the page:
   the fixture is required (absent or another version fails), never written. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {html,section}=require('./helpers.cjs');
const LearningStore=require('../webui/learning-store.js');
const WorkspaceStatus=require('../webui/workspace-status.js');
const DashboardView=require('../webui/dashboard-view.js');

const NOW=1792500000;
const FIXTURE=path.join(__dirname,'../../backend/tests/fixtures/harvest_status_v1.json');
const fixture=JSON.parse(fs.readFileSync(FIXTURE,'utf8'));   // required: a missing fixture fails every test here
const clone=value=>JSON.parse(JSON.stringify(value));
const config=(taps=true)=>({active_instance:'main',active_profile:'alice',instances:{main:{account:'alice',serial:'127.0.0.1:16384',allow_taps:taps}}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const free={blocks_launch:false,code:null,message:null};
/* A complete fresh process scan, consistent with the harvest server clock NOW. */
const FRESH={state:'fresh',age_sec:0.1,last_success_at:NOW-0.1,error:null};
const esc=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const GEMS='/* ------------------------------------------------------- gem harvesting */';
/* A harvest object in the published v1 shape. */
function harvest(extra={}){
  return {version:1,server_time:NOW,host:{reconciler:'active',last_tick_at:NOW-1,last_error:null},
    identity:{instance:'main',account:'alice',serial:'127.0.0.1:16384',profile:'alice'},
    desired:{choice:'off',enabled:false,revision:3,preset:'bp_farm',label:'Farm',changed_at:NOW-600,changed_by:'person',reason:'paused_by_person',request_key:'k',
      bound:{instance:'main',account:'alice',serial:'127.0.0.1:16384',profile:'alice',policy_revision:'p1'}},
    source:{preset:'bp_farm',label:'Farm',profile:'alice',valid:true,code:null,message:null,policy_revision:'p1',changed_since_enable:false,
      policy:{ad_gems:{enabled:true,interval_sec:720,window_sec:60},floating_gems:{enabled:false,interval_sec:960,window_sec:60,tap_interval_sec:5}},edit:{page:'runs',blueprint:'farm'}},
    state:'off',code:'paused',message:'Harvesting is off.',operation:null,owner:null,overlay:null,
    failures:0,circuit_open:false,attempts:0,next_attempt_at:null,last_outcome:null,transfer:null,input_revoked:false,...extra};
}
const on=extra=>harvest({desired:{...harvest().desired,choice:'on',enabled:true,revision:4,reason:'enabled_by_person'},...extra});
const collector=(battle={})=>({id:'op-c',kind:'gems',status:'running',revision:2,harvest_managed:true,worker_alive:true,
  battle:{id:'b1',status:'active',generation:'g1',observation_status:'observing',published_at:NOW-3,observation_age_sec:3,fresh:true,publication_valid:true,...battle},routines:{}});
const view=(h,extra={})=>DashboardView.harvestView({harvest:h,now:NOW,runs:{bp_farm:{label:'Farm'}},...extra});
const reply=(status,body)=>({status,body});
const lockReply=reply(409,{ok:false,code:'action_lock',error:'Another action is in progress; wait for its result'});

/* A fake fetch for the real api(): scripted answers per "METHOD path" (query
   ignored unless a route names it). An answer is {status, body}, 'drop' (a
   lost connection) or a function returning either, possibly later (held). */
function transport(){
  const log=[],routes={};
  const fetch=async (url,opts={})=>{
    const method=(opts.method || 'GET').toUpperCase(), body=opts.body ? JSON.parse(opts.body) : undefined;
    log.push([method,url,body]);
    const queue=routes[method+' '+url] ?? routes[method+' '+url.split('?')[0]];
    let step=Array.isArray(queue) ? queue.shift() : queue;
    if (typeof step==='function') step=await step(body,url);
    if (!step) throw new Error('fake fetch: unexpected '+method+' '+url);
    if (step==='drop') throw new TypeError('Failed to fetch');
    return {ok:step.status<400,status:step.status,json:async()=>clone(step.body)};
  };
  return {fetch,log,routes,posts:()=>log.filter(entry=>entry[0]==='POST')};
}
/* A held answer the test releases later. */
function held(){let release;const promise=new Promise(resolve=>{release=resolve;});return {step:()=>promise,release};}

/* The Gems row, the shared refusal notice and the game-input switch from the
   real page, with the real api() over a fake fetch and fake timers. */
function page({status={},confirmAnswer=true,picker='bp_farm',realStatus=false,runs}={}){
  const t=transport(),calls=[],timers=[],clicks=[];
  const node=id=>({id,_html:'',writes:0,dataset:{},hidden:false,set innerHTML(v){this._html=v;this.writes++;},get innerHTML(){return this._html;},contains:()=>false});
  const nodes={'#dashboard-harvest':node('dashboard-harvest'),'#owner-refusal':node('owner-refusal'),'#start-preset':{value:picker}};
  let n=0;
  const ctx=vm.createContext({S:{config:config(),runs:runs || {bp_farm:{label:'Farm'},bp_shard:{label:'Shard'},combo:{label:'Combo'}},tab:'overview',
      status:{device_state:'device',processes:[],process_refresh:FRESH,setup_battle_guard:free,collection_guard:free,...status}},
    LearningStore,WorkspaceStatus,DashboardView,$:key=>nodes[key],esc,AbortController,
    document:{activeElement:null,getElementById:()=>null,addEventListener:(type,fn)=>{if(type==='click')clicks.push(fn);}},location:{hash:'#overview'},crypto:{randomUUID:()=>'key-'+(++n)+'-aaaaaaaa'},confirm:()=>{calls.push('confirm');return confirmAnswer;},
    toast:(message,error)=>calls.push(['toast',message,!!error]),loadStatus:()=>calls.push('loadStatus'),renderRunReady:()=>{},renderRunner:()=>calls.push('renderRunner'),
    loadHomeData:async()=>{calls.push('loadHomeData');},refreshWorkspaceStatus:()=>calls.push('refreshWorkspaceStatus'),reportDiagnostic:()=>{},
    applyGate:()=>{},renderBootStatus:()=>{},renderHomeLive:()=>{},renderWorkspaceStatus:()=>{},fetch:t.fetch,
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;}});
  vm.runInContext(section('async function api(','const post = '),ctx);
  vm.runInContext('var post = (p, b) => api(p, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(b || {})});',ctx);
  vm.runInContext(section(GEMS,'/* The control that had focus'),ctx);
  vm.runInContext(section('function selectedPreview(','/* Collect diamonds only collects'),ctx);
  vm.runInContext(section('function definiteRefusal(','async function startPreset('),ctx);
  vm.runInContext(section('async function setAutomationAccess(','async function checkRun('),ctx);
  if (realStatus) vm.runInContext(section('async function loadStatus(){','/* One lightweight clock'),ctx);
  const fire=ms=>{for(const timer of timers) if(!timer.cleared && !timer.fired && timer.ms===ms){timer.fired=true;timer.fn();}};
  const gems=()=>{ctx.renderHarvest();return nodes['#dashboard-harvest'].innerHTML;};
  /* a status read that started after every answer so far: the evidence ownersGone needs */
  const laterRead=status=>{Object.assign(ctx.S.status,status);ctx.S.statusRequest=(ctx.S.statusRequest || 0)+1;ctx.S.statusSeq=ctx.S.statusRequest;};
  return {ctx,calls,nodes,gems,t,fire,laterRead,clicks,posts:t.posts,box:nodes['#owner-refusal']};
}
/* ------------------------------------------------------------ projection */
test('the projection states the choice and the observed state as separate facts', () => {
  assert.deepEqual([view(null).supported,view(null).headline],[false,'This server does not report harvesting']);
  assert.equal(view(null,{statusError:'HTTP 502'}).headline,'Harvesting status unavailable');
  assert.match(view({...harvest(),version:2}).headline,/version 2 is not supported/);
  const unset=view(harvest({desired:{choice:'unset',enabled:null,revision:0,preset:null},source:null,code:'never_enabled'}));
  assert.deepEqual([unset.supported,unset.choice,unset.headline,unset.source],[true,'unset','Not turned on for this emulator',null]);
  const off=view(harvest());
  assert.equal(off.headline,'Off');assert.match(off.detail,/^paused /);assert.equal(off.tone,'idle');
  const collecting=view(on({state:'collecting',code:'collecting',operation:collector()}));
  assert.deepEqual([collecting.headline,collecting.detail,collecting.tone],['On \u00b7 Collecting gems in the battle on screen','battle observed 3s ago','ok']);
  assert.equal(view(on({state:'waiting_for_battle',operation:collector({id:null})})).headline,'On \u00b7 Collector running, waiting for a battle on screen');
  assert.equal(view(on({state:'live_paused',operation:collector()})).tone,'warn');
  assert.match(view(on({state:'stopping',message:'x'})).headline,/input is not confirmed stopped yet/);
  assert.equal(view(on({state:'backing_off',next_attempt_at:NOW+120})).detail,'next attempt in 2m');
  assert.equal(view(on({state:'backing_off',next_attempt_at:NOW+30,last_outcome:{kind:'exited',status:'failed',ran_sec:5}})).detail,
    'next attempt in 30s \u00b7 the last collector exited (failed) after 5s');
  const blocked=view(on({state:'blocked',code:'taps_disabled',message:'Game input is disabled for this emulator.'}));
  assert.deepEqual([blocked.headline,blocked.detail],['On \u00b7 Blocked','Game input is disabled for this emulator.']);
  assert.equal(view(harvest({state:'collecting',operation:{...collector(),harvest_managed:false}})).headline,
    'Off \u00b7 Collecting gems in the battle on screen (started with Collect diamonds only)');
  // records the server could not read prove nothing: the choice is unknown, never "not turned on"
  for(const code of ['status_failed','harvest_state_unreadable']){
    const failed=view(harvest({desired:code==='status_failed'?null:{choice:'unset',revision:0},source:null,state:'unavailable',code,message:'Could not be read (OSError).'}));
    assert.deepEqual([failed.readable,failed.choice,failed.headline,failed.tone,failed.revision,failed.source],
      [false,'unknown','Choice unknown \u00b7 Collector state unknown','warn',null,null],code);
  }
  // a state the server reports as Off without a readable choice is not a confident Off
  assert.equal(view(harvest({desired:null,state:'off'})).tone,'warn');
  assert.equal(view(harvest({input_revoked:true})).inputRevoked,true);
  const stale=view(on({state:'collecting',operation:collector()}),{statusError:'timed out'});
  assert.match(stale.headline,/^Last known \u00b7 On/);assert.equal(stale.tone,'warn');
});

test('a run owning the emulator never reads as collecting; what it publishes about gems is stated with its basis', () => {
  const owned=owner=>view(on({state:'owned_by_driver',code:'operation_owns_device',owner}));
  const run={kind:'operation',operation_id:'op-r',operation_kind:'run',status:'running',foreign:false};
  const published=owned({...run,gathers:true,gems:{ad_gems:true,floating_gems:false,basis:'published_routines'}});
  assert.equal(published.headline,'On \u00b7 The running automation handles gems itself: Ad gems on, floating gems off');
  assert.equal(published.tone,'ok');
  assert.equal(owned({...run,gathers:false,gems:{ad_gems:false,floating_gems:false,basis:'published_routines'}}).tone,'warn');
  assert.match(owned({...run,gathers:null,gems:{basis:'not_reported'}}).headline,/does not report gem routines/);
  assert.match(owned({...run,gathers:null,gems:{ad_gems:true,floating_gems:true,basis:'stale'}}).headline,/last gem report is stale/);
  assert.match(owned({kind:'process',pid:42,script:'orchestrator.py',foreign:true}).headline,/orchestrator\.py \(PID 42\) from another installation owns the emulator; harvesting waits/);
  assert.match(owned({...run,operation_kind:'calibrate'}).headline,/A calibrate operation is using the emulator; harvesting waits/);
  assert.match(owned({...run,operation_kind:'gems'}).headline,/The diamond collector is using the emulator; harvesting waits/);
});

test('source, overlay and reconciler host are stated without implying the source timing reached a running automation', () => {
  const owner={kind:'operation',operation_kind:'run',gathers:true,gems:{ad_gems:true,floating_gems:false,basis:'published_routines'}};
  const v=view(on({state:'owned_by_driver',owner,overlay:{battle_id:'b1',generation:'g1',choice_revision:4,request_key:'harvest-overlay-b1-g1-4',command_id:'c1',state:'applied',
    paths:['routines.ad_gems.enabled'],targets:{ad_gems:true,floating_gems:false},skipped:{ad_gems:null,floating_gems:'live_choice'},cadence_source:'current_battle'}}));
  assert.deepEqual(clone(v.source),{preset:'bp_farm',label:'Farm',valid:true,problem:'',settings:'Ad gems on every 12m, floating gems off',changed:false,edit:'farm'});
  assert.equal(v.overlay.text,"This battle: harvesting choice (Ad gems on, Floating gems off) applied \u00b7 Floating gems kept as set for this battle \u00b7 timing stays the battle's own");
  assert.equal(v.overlay.tone,'ok');
  // an applied choice the driver has not published yet is not presented as its routines
  const unreported=view(on({state:'owned_by_driver',owner:{...owner,gems:{ad_gems:false,floating_gems:false,basis:'published_routines'}},
    overlay:{state:'applied',targets:{ad_gems:true,floating_gems:false},skipped:{},cadence_source:'current_battle'}})).overlay;
  assert.deepEqual([unreported.text,unreported.tone],["This battle: harvesting choice (Ad gems on, Floating gems off) applied \u00b7 the driver has not reported it yet \u00b7 timing stays the battle's own",'warn']);
  // "already in effect" judged from a stale report says so
  assert.match(view(on({state:'owned_by_driver',owner:{...owner,gems:{basis:'stale'}},overlay:{state:'not_needed',skipped:{}}})).overlay.text,/already in effect \u00b7 judged from a stale gem report/);
  assert.equal(view(on({overlay:{state:'rejected',skipped:{}}})).overlay.tone,'warn');
  const planned=view(on({overlay:{state:'pending',targets:{ad_gems:true,floating_gems:false},skipped:{floating_gems:'unchanged'},cadence_source:'current_battle'}})).overlay;
  assert.equal(planned.text,"This battle: harvesting choice (Ad gems on, Floating gems off) waiting for the driver \u00b7 Floating gems already as chosen \u00b7 timing stays the battle's own");
  assert.deepEqual(['blocked','unsupported','live_choice','not_requested','waiting_for_battle'].map(state=>view(on({overlay:{state,skipped:{}}})).overlay.tone),['warn','warn','idle','busy','busy']);
  const invalid=view(on({state:'blocked',source:{...harvest().source,valid:false,code:'policy_deleted',message:'Run Farm no longer exists.'}}));
  assert.deepEqual([invalid.source.valid,invalid.source.problem],[false,'Run Farm no longer exists.']);
  assert.match(view(on({host:{reconciler:'inactive',last_tick_at:null,last_error:'boom'}})).host,/not running the harvesting reconciler[\s\S]*Last error: boom/);
  // the server clears last_error on a good pass, so a recorded one is the latest pass
  assert.equal(view(on({state:'starting',host:{reconciler:'active',last_tick_at:NOW,last_error:{type:'OSError',message:'adb server vanished',at:NOW-3}}})).host,
    "The harvesting reconciler's latest pass failed: OSError: adb server vanished (3s ago).");
  // due to start but nothing in this process starts it: never "Collector starting"
  const idle=view(on({state:'starting',code:'launch_due',host:{reconciler:'inactive',last_tick_at:null,last_error:null}}));
  assert.deepEqual([idle.headline,idle.tone,idle.host],['On \u00b7 Collector not started: this dashboard process does not run harvesting','warn','']);
  assert.equal(view(on()).host,'');
});

/* ------------------------------------------- backend generated fixture v1 */
/* What the Gems row's fact says for every published status sample. */
const STATUS_EXPECT={
  backing_off:['On \u00b7 Waiting before starting the collector again',/^next attempt in 29s \u00b7 the last collector exited \(failed\) after 5s$/],
  circuit_open:['On \u00b7 Blocked',/failed 5 times in a row/],
  collecting:['On \u00b7 Collecting gems in the battle on screen',/^battle observed 1s ago$/],
  context_changed:['On \u00b7 Blocked',/another account, profile or emulator/],
  emulator_offline:['On \u00b7 Blocked',/not online/],
  foreign_process:['On \u00b7 orchestrator (PID 4242) from another installation owns the emulator; harvesting waits',/^$/],
  input_revoked:['On \u00b7 Blocked',/input was revoked/],
  live_paused:['On \u00b7 Collector running; both gem routines are paused for this battle',/nothing is collected/],
  manual_collector:['Not turned on for this emulator \u00b7 Collecting gems in the battle on screen (started with Collect diamonds only)',/^battle observed 1s ago$/],
  off:['Off',/^paused /],
  overlay_applied:['On \u00b7 The running automation handles gems itself: Ad gems off, floating gems off',/^$/],
  overlay_live_choice:['On \u00b7 The running automation handles gems itself: Ad gems on, floating gems off',/^$/],
  overlay_off_pending:['Off \u00b7 The running automation handles gems itself: Ad gems on, floating gems off',/^$/],
  overlay_requested:['On \u00b7 The running automation handles gems itself: Ad gems off, floating gems off',/^$/],
  overlay_unsupported:['On \u00b7 The running automation handles gems itself: Ad gems off, floating gems off',/^$/],
  overlay_waiting:['On \u00b7 The running automation handles gems itself: Ad gems off, floating gems off',/^$/],
  owned_by_run_gathers:['On \u00b7 The running automation handles gems itself: Ad gems on, floating gems off',/^$/],
  owned_by_run_not_gathering:['On \u00b7 The running automation handles gems itself: Ad gems off, floating gems off',/^$/],
  owned_by_run_not_reported:['On \u00b7 The running automation owns the emulator and does not report gem routines',/^$/],
  owned_by_run_stale:['On \u00b7 The running automation owns the emulator; its last gem report is stale (Ad gems not reported, floating gems not reported)',/^$/],
  policy_invalid:['On \u00b7 Blocked',/Enable Ad Gems or timed orbit clicks/],
  reconciler_failing:['On \u00b7 Collector starting',/^$/],
  reconciler_inactive:['On \u00b7 Collector not started: this dashboard process does not run harvesting',/^$/],
  run_settings_refused:['On \u00b7 Blocked',/wave digits/],
  setup_guard_block:['On \u00b7 Blocked',/never verified back on Home/],
  source_changed:['On \u00b7 Collector starting',/^$/],
  stale_collector:['On \u00b7 Collector state unknown',/120 s ago/],
  starting_collector:['On \u00b7 Collector starting',/^$/],
  starting_due:['On \u00b7 Collector starting',/^$/],
  state_unreadable:['Choice unknown \u00b7 Collector state unknown',/could not be read/],
  status_failed:['Choice unknown \u00b7 Collector state unknown',/could not be read/],
  stopping:['On \u00b7 Collector stopping; its input is not confirmed stopped yet',/battle is not ended/],
  taps_disabled:['On \u00b7 Blocked',/Game input is disabled/],
  transferring:['On \u00b7 Handing the emulator to the run you started',/harvesting resumes after it exits/],
  unset:['Not turned on for this emulator',/^$/],
  waiting_for_battle:['On \u00b7 Collector running, waiting for a battle on screen',/^$/],
  worker_not_running:['On \u00b7 Collector state unknown',/not running/],
  // a collector whose worker cannot be checked is not collecting and still holds the emulator
  worker_unverified:['On \u00b7 Collector state unknown',/^The collector process cannot be checked from here, so it is treated as still holding the emulator\.$/],
};
test('the generated fixture is version 1 and every status sample projects to its exact fact, never a false collecting', () => {
  assert.equal(fixture.version,1);
  for (const family of ['status','post_harvest','refusals','automation_access','start_transfer'])
    assert.ok(fixture[family] && Object.keys(fixture[family]).length,family+' is published');
  assert.deepEqual(Object.keys(fixture.status).sort(),Object.keys(STATUS_EXPECT).sort(),'every published status sample has an expectation here');
  for(const [name,h] of Object.entries(fixture.status)){
    const v=DashboardView.harvestView({harvest:h,now:h.server_time,runs:{}});
    const [headline,detail]=STATUS_EXPECT[name];
    assert.equal(v.supported,true,name);
    assert.equal(v.headline,headline,name);
    assert.match(v.detail,detail,name+': '+v.detail);
    assert.equal(/Collecting/.test(v.headline),h.state==='collecting',name);
    assert.equal(v.readable,!['status_failed','state_unreadable'].includes(name),name);
    assert.equal(v.choice,v.readable ? h.desired.choice : 'unknown',name);
    assert.ok(!/undefined|null|NaN|\[object/.test(v.headline+v.detail+v.host+(v.overlay?.text || '')),name);
    // every overlay keeps the current battle's own timing
    if (h.overlay) assert.match(v.overlay.text,/timing stays the battle's own$/,name);
  }
  const f=fixture.status;
  assert.equal(DashboardView.harvestView({harvest:f.overlay_applied,now:NOW}).overlay.text,
    "This battle: harvesting choice (Ad gems on, Floating gems off) applied \u00b7 the driver has not reported it yet \u00b7 timing stays the battle's own");
  assert.match(DashboardView.harvestView({harvest:f.owned_by_run_stale,now:NOW}).overlay.text,/judged from a stale gem report/);
  assert.match(DashboardView.harvestView({harvest:f.reconciler_failing,now:f.reconciler_failing.server_time}).host,/^The harvesting reconciler's latest pass failed: OSError: adb server vanished \(3s ago\)\.$/);
  assert.match(DashboardView.harvestView({harvest:f.status_failed,now:NOW}).host,/not running the harvesting reconciler/);
});
/* ------------------------------------------------- Gems row and requests */
test('rendering the Gems row never posts; Turn on is offered with its run, settings and exact Edit target, or disabled with a reason', () => {
  const p=page({status:{harvest:harvest()}});
  for(let i=0;i<5;i++)p.gems();
  assert.deepEqual(p.posts(),[]);
  const out=p.gems();
  assert.match(out,/<span class="dashboard-dot" aria-hidden="true"><\/span>Off<span class="dashboard-fact-detail"> \u00b7 paused /);
  assert.match(out,/<select id="harvest-source" onchange="pickHarvestSource\(this.value\)" onblur="setTimeout\(renderHarvest\)" ><option value="bp_farm" selected>Farm<\/option><option value="bp_shard" >Shard<\/option><\/select>/);
  assert.doesNotMatch(out,/value="combo"/);
  assert.match(out,/<button class="small" id="harvest-on" onclick="setHarvest\(true\)"  title=/);
  // the stored source describes Farm: its server-resolved flags and the server's exact edit target
  assert.match(out,/Turn on uses Farm's saved gem settings: Ad gems on every 12m, floating gems off<\/span> <a class="dashboard-run-link" data-run="farm" href="#runs">Edit in Runs<\/a>/);
  // the collection guard (not the run guard) holds Turn on, with its reason
  p.ctx.S.status.collection_guard={blocks_launch:true,code:'setup_battle_unresolved',message:'Setup battle <unresolved>.'};
  assert.match(p.gems(),/id="harvest-on" onclick="setHarvest\(true\)" disabled[\s\S]*Turn on: Setup battle &lt;unresolved&gt;\./);
  p.ctx.S.status.collection_guard=free;p.ctx.S.status.setup_battle_guard={blocks_launch:true,code:'x',message:'run only'};
  assert.match(p.gems(),/id="harvest-on" onclick="setHarvest\(true\)"  title=/);
  delete p.ctx.S.status.collection_guard;
  assert.match(p.gems(),/Turn on: This server does not report collection_guard/);
  // a failed read is not a current Off: Pause (a revocation) replaces Turn on until a read succeeds
  p.ctx.S.status.collection_guard=free;p.ctx.S.statusError='timed out';
  const lastKnown=p.gems();
  assert.match(lastKnown,/Last known \u00b7 Off/);
  assert.match(lastKnown,/id="harvest-pause" onclick="setHarvest\(false\)"  title="No current status confirms that harvesting is off/);
  assert.doesNotMatch(lastKnown,/id="harvest-on"|Turn on uses|Turn on:/);
  p.ctx.S.statusError='';p.ctx.S.status.harvest=harvest({source:{...harvest().source,valid:false,message:'Both gem routines are off.'}});
  assert.match(p.gems(),/disabled[\s\S]*Turn on: Both gem routines are off\./);
  p.ctx.S.status.harvest=on({state:'blocked',circuit_open:true,message:'The collector failed 5 times in a row.'});
  const running=p.gems();
  assert.match(running,/id="harvest-pause" onclick="setHarvest\(false\)"  title=/);
  assert.match(running,/id="harvest-retry" onclick="setHarvest\(true\)"  title=/);
  assert.match(running,/Uses Farm's saved gem settings: Ad gems on every 12m, floating gems off<\/span> <a class="dashboard-run-link" data-run="farm" href="#runs">/);
  assert.match(page({status:{}}).gems(),/This server does not report harvesting/);
  // an unreadable choice still offers Pause (revocation), never Turn on
  p.ctx.S.status.harvest=harvest({desired:null,state:'unavailable',code:'status_failed',message:'x'});
  const unknown=p.gems();
  assert.match(unknown,/id="harvest-pause"/);assert.doesNotMatch(unknown,/id="harvest-on"/);
  assert.doesNotMatch(unknown,/Turn on uses|dashboard-run-link/);                    // an unreadable choice names no source
  p.ctx.setHarvest(true);assert.deepEqual(p.posts(),[]);
  p.ctx.S.status.harvest=harvest({input_revoked:true});
  assert.match(p.gems(),/Game input is off for this emulator, so no collector input runs until you allow it again\./);
  assert.deepEqual(p.posts(),[]);
});

test('a picked run other than the source is described by its own saved settings, read once per run and context (GET only)', async () => {
  const p=page({status:{harvest:harvest()}});
  p.t.routes['GET /api/run-controls?blueprint=bp_shard']=[reply(200,{ok:true,blueprint:'shard_run',settings:{routines:{ad_gems:{enabled:false},floating_gems:{enabled:true,interval_sec:960}}}})];
  p.ctx.pickHarvestSource('bp_shard');
  assert.match(p.gems(),/Turn on uses Shard's saved gem settings \(reading…\)<\/span> <a class="dashboard-run-link" data-run="bp_shard"/);
  await flush();await flush();
  const out=p.gems();
  assert.match(out,/Turn on uses Shard's saved gem settings: Ad gems off, floating gems on every 16m<\/span> <a class="dashboard-run-link" data-run="shard_run" href="#runs">/);
  assert.match(out,/<option value="bp_shard" selected>Shard/);
  for(let i=0;i<3;i++)p.gems();
  assert.deepEqual(p.t.log.map(([method,url])=>[method,url]),[['GET','/api/run-controls?blueprint=bp_shard']]);
  // both routines off in the picked run's saved settings: Turn on says so
  p.ctx.S.harvestPickRead.snapshot.settings.routines.floating_gems.enabled=false;
  assert.match(p.gems(),/id="harvest-on" onclick="setHarvest\(true\)" disabled[\s\S]*Turn on: Ad gems and Floating gems are both off/);
  // another context reads again; the old answer is not used there
  p.ctx.S.config.instances.main.serial='other';
  p.t.routes['GET /api/run-controls?blueprint=bp_shard']=[reply(500,{ok:false,error:'profile unreadable'})];
  assert.match(p.gems(),/\(reading…\)/);
  await flush();await flush();
  assert.match(p.gems(),/Turn on uses Shard's saved gem settings \(not readable here: profile unreadable\)/);
  assert.deepEqual(p.posts(),[]);
});

/* A minimal live DOM for #dashboard-harvest: its four part regions, and the run
   picker (<select>) and Turn on as objects replaced whenever their part is
   rewritten, so a test can hold focus on the picker as a person does and see
   which nodes a render replaced. */
function liveRow(p){
  const root=p.nodes['#dashboard-harvest'], els={select:null,on:null,regions:{}}, writes={root:0,fact:0,actions:0,picker:0,rest:0};
  const MARKS=[['fact','<div data-harvest-part="fact">','</div><span data-harvest-part="actions">'],['actions','<span data-harvest-part="actions">','</span><span data-harvest-part="picker">'],
    ['picker','<span data-harvest-part="picker">','</span></div><div data-harvest-part="rest">'],['rest','<div data-harvest-part="rest">',null]];
  const controls=html=>{
    const sel=/<select id="harvest-source"([^>]*)>([\s\S]*?)<\/select>/.exec(html);
    els.select=sel?{id:'harvest-source',tagName:'SELECT',disabled:/\bdisabled\b/.test(sel[1]),focus(){},
      options:[...sel[2].matchAll(/<option value="([^"]*)" (selected)?>([^<]*)<\/option>/g)].map(m=>({value:m[1],textContent:m[3],selected:!!m[2]}))}:null;
    if(els.select)els.select.value=(els.select.options.find(o=>o.selected)||els.select.options[0]||{}).value;
    const on=/id="harvest-on" onclick="setHarvest\(true\)" (disabled)?/.exec(html);
    els.on=on?{id:'harvest-on',tagName:'BUTTON',disabled:!!on[1],hidden:false,focus(){}}:null;
  };
  const region=(name,html)=>({_h:html,set innerHTML(v){this._h=v;writes[name]++;if(name==='picker')controls(v);},get innerHTML(){return this._h;}});
  Object.defineProperty(root,'innerHTML',{configurable:true,get(){return MARKS.map(([name])=>els.regions[name]?._h ?? '').join('');},
    set(v){writes.root++;for(const [name,start,end] of MARKS){const from=v.indexOf(start)+start.length,to=end?v.indexOf(end,from):v.lastIndexOf('</div>');els.regions[name]=region(name,v.slice(from,to));}
      controls(els.regions.picker._h);}});
  root.contains=el=>!!el && (el===els.select || el===els.on);
  root.querySelector=selector=>selector==='#harvest-on'?els.on:els.regions[/data-harvest-part="(\w+)"/.exec(selector)?.[1]] || null;
  p.ctx.document.getElementById=id=>id==='harvest-source'?els.select:id==='harvest-on'?els.on:null;
  return {els,writes,text:name=>els.regions[name]._h};
}
test('H2UI-04/R2-02: a focused run picker is kept; the fact, Pause, Turn on and the source follow every status change around it', () => {
  const p=page({status:{harvest:clone(fixture.status.off)},runs:{bp_farm:{label:'Farm'},bp_shard:{label:'Shard'}}});
  p.t.routes['GET /api/run-controls?blueprint=bp_shard']=[()=>new Promise(()=>{})];
  const row=liveRow(p);p.ctx.renderHarvest();
  const select=row.els.select;
  assert.ok(select && row.els.on);assert.equal(row.writes.root,1);
  p.ctx.document.activeElement=select;                                             // the person is in the picker
  select.value='bp_shard';p.ctx.pickHarvestSource('bp_shard');
  assert.equal(row.els.select,select,'the focused picker is not replaced');
  assert.equal(row.writes.root,1);
  assert.match(row.text('rest'),/Turn on uses Shard's saved gem settings \(reading…\)<\/span> <a class="dashboard-run-link" data-run="bp_shard" href="#runs">/);
  assert.doesNotMatch(row.text('rest'),/Farm/);
  assert.equal(row.els.on.disabled,false);
  // the collection guard holds Turn on: it follows in place
  const on=row.els.on;
  p.ctx.S.status.collection_guard={blocks_launch:true,code:'x',message:'Held.'};p.ctx.renderHarvest();
  assert.equal(row.els.on,on);assert.equal(on.disabled,true);assert.match(row.text('rest'),/Turn on: Held\./);
  p.ctx.S.status.collection_guard=free;p.ctx.renderHarvest();assert.equal(on.disabled,false);
  // H2UI-R2-02: the published starting_due status arrives while the picker keeps focus
  p.ctx.S.status.harvest=clone(fixture.status.starting_due);p.ctx.renderHarvest();
  assert.match(row.text('fact'),/>On · Collector starting</);
  assert.match(row.text('actions'),/<button class="small" id="harvest-pause" onclick="setHarvest\(false\)"  title=/);
  assert.equal(row.els.select,select);
  assert.deepEqual([on.hidden,on.disabled],[true,true],'no Turn on is offered while harvesting is On');
  // ... and status_failed: unknown choice, Pause, no Turn on
  p.ctx.S.status.harvest=clone(fixture.status.status_failed);p.ctx.renderHarvest();
  assert.match(row.text('fact'),/>Choice unknown · Collector state unknown</);
  assert.match(row.text('actions'),/id="harvest-pause"/);
  assert.doesNotMatch(row.text('rest'),/Turn on uses|dashboard-run-link/);
  assert.deepEqual([on.hidden,on.disabled],[true,true]);
  // back to Off with the same runs and pick: Turn on returns in place, the picker untouched
  p.ctx.S.status.harvest=clone(fixture.status.off);p.ctx.renderHarvest();
  assert.equal(row.text('actions'),'');
  assert.deepEqual([row.els.select,row.els.on,on.hidden,on.disabled],[select,on,false,false]);
  const pickerWrites=row.writes.picker;
  // leaving a picker that is in sync rewrites nothing under the next click
  p.ctx.document.activeElement=null;p.ctx.renderHarvest();
  assert.deepEqual([row.writes.picker,row.els.on],[pickerWrites,on]);
  // the runs change while the picker has focus: Turn on is held until it is left, then the picker is rebuilt
  p.ctx.document.activeElement=select;p.ctx.S.runs.bp_new={label:'New'};p.ctx.renderHarvest();
  assert.deepEqual([row.els.select,on.disabled,on.hidden],[select,true,false]);
  p.ctx.document.activeElement=null;p.ctx.renderHarvest();
  assert.notEqual(row.els.select,select);
  assert.deepEqual(row.els.select.options.map(o=>o.value),['bp_farm','bp_shard','bp_new']);
  assert.equal(row.els.select.value,'bp_shard');
  assert.equal(row.writes.root,1);
  assert.deepEqual(p.posts(),[]);
});

test('Turn on sends a compare-and-set request bound to the context; a definite refusal is shown and releases it', async () => {
  const p=page({status:{harvest:harvest()}});
  p.t.routes['POST /api/harvest']=[reply(200,{ok:true,replayed:false,desired:{revision:4},stop:null,overlay:null}),
    reply(409,{ok:false,code:'harvest_revision_changed',error:'Harvesting settings changed; refresh before changing them again'})];
  await p.ctx.setHarvest(true);
  assert.deepEqual(p.posts()[0],['POST','/api/harvest',{enabled:true,preset:'bp_farm',expected_revision:3,
    expected_context:{instance:'main',serial:'127.0.0.1:16384',account:'alice',profile:'alice'},idempotency_key:'key-1-aaaaaaaa'}]);
  assert.equal(p.ctx.S.harvestIntent,null);
  assert.match(p.gems(),/data-tone="ok">Turned on with Farm\./);
  assert.ok(p.calls.includes('loadStatus'));
  // a later choice (a higher revision) retires that feedback
  p.ctx.S.status.harvest=harvest({desired:{...harvest().desired,revision:5}});
  assert.doesNotMatch(p.gems(),/Turned on with Farm/);
  p.ctx.S.status.harvest=harvest();
  await p.ctx.setHarvest(true);
  assert.equal(p.ctx.S.harvestIntent,null);
  assert.match(p.gems(),/data-tone="bad">Turn on refused: Harvesting was changed elsewhere; review its state before trying again\. Harvesting settings changed/);
  assert.deepEqual(p.ctx.S.workspaceMutations,undefined,'a harvesting write never holds status reads back');
});

test('H2UI-01: Pause stays reachable over a lost Turn on and supersedes it with its own Off; only Resend replays the frozen request', async () => {
  const p=page({status:{harvest:harvest()}});
  p.t.routes['POST /api/harvest']=['drop',lockReply];
  await p.ctx.setHarvest(true);
  assert.equal(p.ctx.S.harvestIntent.state,'unknown');
  let out=p.gems();
  assert.match(out,/Turn on harvesting with Farm: not confirmed \(Failed to fetch\)\. Nothing is resent automatically\.[\s\S]*onclick="resendHarvest\(\)">Resend the same request/);
  // the status still reads Off, but that Turn on may be recorded: Pause, not a second Turn on
  assert.match(out,/<button class="small" id="harvest-pause" onclick="setHarvest\(false\)"  title="Pauses harvesting whatever the unconfirmed Turn on did/);
  assert.doesNotMatch(out,/id="harvest-on"/);
  // the row names the run that pending Turn on was sent with, even if the pick changes
  p.ctx.S.harvestPick='bp_shard';
  assert.match(p.gems(),/The pending Turn on uses Farm's saved gem settings: Ad gems on every 12m, floating gems off<\/span> <a class="dashboard-run-link" data-run="farm"/);
  await p.ctx.setHarvest(true);assert.equal(p.posts().length,1);
  await flush();assert.equal(p.posts().length,1);                                    // nothing resends by itself
  await p.ctx.resendHarvest();
  assert.deepEqual(p.posts()[1][2],p.posts()[0][2]);                                  // identical body and key
  assert.match(p.gems(),/not confirmed \(Another action is in progress/);            // the lock is never a success
  // Pause: an unconditional Off of its own, never the On's key or revision
  p.t.routes['POST /api/harvest']=['drop',reply(200,{ok:true,replayed:true,desired:{revision:4},stop:{requested:true,stopped:[],stopping:[],errors:[]}})];
  await p.ctx.setHarvest(false);
  const {idempotency_key:offKey,...offBody}=p.posts()[2][2];
  assert.deepEqual(offBody,{enabled:false,expected_context:{instance:'main',serial:'127.0.0.1:16384',account:'alice',profile:'alice'}});
  assert.match(offKey,/^key-\d+-aaaaaaaa$/);assert.notEqual(offKey,p.posts()[0][2].idempotency_key);
  out=p.gems();
  assert.equal(p.ctx.S.harvestIntent.enabled,false);
  assert.match(out,/Pause harvesting: not confirmed \(Failed to fetch\)/);
  assert.doesNotMatch(out,/Turn on harvesting/);                                     // the superseded Turn on cannot be resent
  await p.ctx.setHarvest(false);                                                      // Pause again resends that same Off
  assert.deepEqual(p.posts()[3][2],p.posts()[2][2]);
  assert.equal(p.ctx.S.harvestIntent,null);
  assert.match(p.gems(),/Paused; no collector was running\. The server had already recorded this exact request\./);
  // a context change never resends an unconfirmed request, and its row does not offer it
  const q=page({status:{harvest:on()}});
  q.t.routes['POST /api/harvest']=['drop'];
  await q.ctx.setHarvest(false);q.ctx.S.config.instances.main.serial='other';
  assert.match(q.gems(),/An unconfirmed harvesting request for another emulator, account or profile is not resent here/);
  await q.ctx.resendHarvest();
  assert.equal(q.posts().length,1);assert.equal(q.ctx.S.harvestIntent,null);
  assert.match(q.gems(),/was not resent/);
});

test('H2UI-01/05: Pause is enabled while a Turn on is held, supersedes it, and the late Turn on answer changes nothing', async () => {
  for (const status of [harvest(), on({state:'blocked',code:'collector_failing',circuit_open:true,message:'failed'})]) {
    const p=page({status:{harvest:status}});
    const hold=held();
    p.t.routes['POST /api/harvest']=[hold.step,reply(200,{ok:true,replayed:false,desired:{revision:6},stop:{requested:true,stopped:[],stopping:[],errors:[]}})];
    const pending=p.ctx.setHarvest(true);
    assert.equal(p.ctx.S.harvestIntent.state,'sending');
    assert.match(p.gems(),/<button class="small" id="harvest-pause" onclick="setHarvest\(false\)"  title=/);   // enabled
    await p.ctx.setHarvest(false);
    assert.equal(p.posts().length,2);
    assert.equal(p.posts()[1][2].enabled,false);
    assert.equal(p.ctx.S.harvestIntent,null);
    assert.match(p.gems(),/Paused; no collector was running\./);
    hold.release(reply(200,{ok:true,replayed:false,desired:{revision:5},stop:null}));
    await pending;await flush();
    const out=p.gems();
    assert.doesNotMatch(out,/Turned on/);
    assert.match(out,/Paused; no collector was running\./);
    assert.equal(p.ctx.S.harvestFeedback.enabled,false);
    assert.equal(p.posts().length,2);
  }
  // while a Pause itself is sending, the button shows it in flight
  const p=page({status:{harvest:on()}});
  const hold=held();p.t.routes['POST /api/harvest']=[hold.step];
  const pause=p.ctx.setHarvest(false);
  assert.match(p.gems(),/id="harvest-pause" onclick="setHarvest\(false\)" disabled[\s\S]*Pause harvesting: sending…/);
  await p.ctx.setHarvest(false);assert.equal(p.posts().length,1);
  hold.release(reply(200,{ok:true,desired:{revision:5},stop:{requested:true,stopped:[],stopping:[],errors:[]}}));await pause;
});

test('H2UI-01: a write that never answers becomes unconfirmed after the observation window and is not resent; a late answer settles only a still-current request', async () => {
  const p=page({status:{harvest:harvest()}});
  const first=held();p.t.routes['POST /api/harvest']=[first.step];
  const sent=p.ctx.setHarvest(true);
  p.fire(p.ctx.WRITE_OBSERVE_MS ?? 15000);
  await sent;
  assert.equal(p.ctx.S.harvestIntent.state,'unknown');
  assert.match(p.gems(),/not confirmed \(No answer within 15 s; the outcome is unknown\)/);
  assert.equal(p.posts().length,1);
  first.release(reply(200,{ok:true,replayed:false,desired:{revision:4},stop:null}));await flush();await flush();
  assert.equal(p.ctx.S.harvestIntent,null);
  assert.match(p.gems(),/Turned on with Farm\./);
  // superseded before its late answer: the answer is ignored
  const q=page({status:{harvest:harvest()}});
  const late=held();q.t.routes['POST /api/harvest']=[late.step,reply(200,{ok:true,desired:{revision:5},stop:{requested:true,stopped:[],stopping:[],errors:[]}})];
  const on=q.ctx.setHarvest(true);q.fire(15000);await on;
  await q.ctx.setHarvest(false);
  late.release(reply(200,{ok:true,desired:{revision:4},stop:null}));await flush();await flush();
  assert.doesNotMatch(q.gems(),/Turned on/);
  assert.equal(q.posts().length,2);
});

test('H2UI-01: status reads are accepted while a harvesting write is held, so the row follows the server meanwhile', async () => {
  const p=page({status:{harvest:harvest()},realStatus:true});
  const hold=held();p.t.routes['POST /api/harvest']=[hold.step];
  p.t.routes['GET /api/status']=[reply(200,{device_state:'device',processes:[],process_refresh:{state:'fresh'},setup_battle_guard:free,collection_guard:free,harvest:on({state:'starting'})})];
  const sending=p.ctx.setHarvest(true);
  await p.ctx.loadStatus();
  assert.equal(p.ctx.S.status.harvest.desired.choice,'on');
  assert.equal(p.ctx.S.statusSeq,p.ctx.S.statusRequest);
  assert.match(p.gems(),/On \u00b7 Collector starting[\s\S]*id="harvest-pause"[\s\S]*Turn on harvesting with Farm: sending…/);
  hold.release(reply(200,{ok:true,desired:{revision:4},stop:null}));await sending;
});
test('H2UI-03: a pause whose collector was still stopping is confirmed only by a later, fresh, readable status that no longer names it', async () => {
  const procs=[{pid:7,runner:'gem_collector',operation:{id:'op-c',kind:'gems'}}];
  const start=()=>{
    const p=page({status:{harvest:on({state:'collecting',operation:collector()}),processes:procs}});
    p.t.routes['POST /api/harvest']=[reply(200,{ok:true,replayed:false,desired:{revision:5},stop:{requested:true,stopped:[],stopping:['op-c'],errors:[]},overlay:null})];
    return p;
  };
  const STILL=/data-tone="warn">Paused; collector input is still stopping and not confirmed stopped yet\./, DONE=/data-tone="ok">Paused; collector input stopped\./;
  const offNow=harvest({state:'off',desired:{...harvest().desired,revision:5}});
  const cases=[
    ['still listed', {processes:procs}],
    ['no harvest object, stale scan', {processes:[],harvest:null,process_refresh:{state:'stale',age_sec:180}}],
    ['harvest status_failed', {processes:[],harvest:harvest({desired:null,source:null,state:'unavailable',code:'status_failed'})}],
    ['records unreadable', {processes:[],harvest:harvest({desired:{choice:'unset',revision:0},state:'unavailable',code:'harvest_state_unreadable'})}],
    ['owner still names it', {processes:[],harvest:{...offNow,state:'owned_by_driver',owner:{kind:'operation',operation_id:'op-c',operation_kind:'gems'}}}],
    ['collector still in harvest', {processes:[],harvest:{...offNow,state:'stopping',operation:collector()}}],
    ['scan not fresh', {processes:[],harvest:offNow,process_refresh:{state:'stale'}}],
    ['scan state missing', {processes:[],harvest:offNow,process_refresh:undefined}],
    ['choice not off', {processes:[],harvest:on({desired:{...on().desired,revision:5}})}],
    // H2UI-R2-01: absent or malformed ownership fields are unknown, never gone
    ['processes absent', {processes:undefined,harvest:offNow}],
    ['processes null', {processes:null,harvest:offNow}],
    ['a process record malformed', {processes:[null],harvest:offNow}],
    ['harvest.operation absent', {processes:[],harvest:(({operation,...rest})=>rest)(offNow)}],
    ['harvest.owner absent', {processes:[],harvest:(({owner,...rest})=>rest)(offNow)}],
    // H2UI-R2-04: a fresh label alone is not freshness
    ['fresh label, scan in the future', {processes:[],harvest:offNow,process_refresh:{...FRESH,age_sec:-3600,last_success_at:NOW+3600}}],
    ['fresh label, scan after the server clock', {processes:[],harvest:offNow,process_refresh:{...FRESH,age_sec:0.1,last_success_at:NOW+30}}],
    ['fresh label, old scan', {processes:[],harvest:offNow,process_refresh:{...FRESH,age_sec:180,last_success_at:NOW-180}}],
    ['fresh label, no times', {processes:[],harvest:offNow,process_refresh:{state:'fresh'}}],
    ['fresh label, NaN age', {processes:[],harvest:offNow,process_refresh:{...FRESH,age_sec:NaN}}],
    ['fresh label, infinite time', {processes:[],harvest:offNow,process_refresh:{...FRESH,last_success_at:Infinity}}],
    ['fresh label with an error', {processes:[],harvest:offNow,process_refresh:{...FRESH,error:'scan failed'}}],
    ['no harvest server clock', {processes:[],harvest:{...offNow,server_time:undefined}}],
  ];
  for (const [name,status] of cases) {
    const p=start();await p.ctx.setHarvest(false);
    assert.match(p.gems(),STILL,'right after the answer');
    p.laterRead(status);
    assert.match(p.gems(),STILL,name);
  }
  // an affirmative read that started before the answer arrived is not evidence
  const early=start();await early.ctx.setHarvest(false);
  Object.assign(early.ctx.S.status,{processes:[],harvest:offNow});
  assert.match(early.gems(),STILL,'a read that started before the answer');
  early.ctx.S.statusError='timed out';early.laterRead({});
  assert.match(early.gems(),STILL,'a failed read');
  // the positive control: fresh, readable, Off, nothing names op-c, read after the answer
  const p=start();await p.ctx.setHarvest(false);
  p.laterRead({processes:[],harvest:offNow,process_refresh:FRESH});
  assert.match(p.gems(),DONE);
  // a stop the server reports as errors is never stopped
  p.ctx.S.harvestFeedback={...p.ctx.S.harvestFeedback,stop:{requested:true,stopped:[],stopping:[],errors:[{message:'cancel refused'}]}};
  assert.match(p.gems(),/data-tone="warn">Paused, but stopping the collector reported: cancel refused\./);
});

test('every fixture harvesting answer renders its definite outcome; a lock or an unknown outcome is never a success', async () => {
  const ON=['enable_ok','enable_replayed','harvest_revision_changed','policy_invalid'];
  const OFF=['off_during_action_lock','off_ok_replayed','off_ok_stopped','off_ok_stopping'];
  const expect={
    enable_ok:/data-tone="ok">Turned on with Farm\./, enable_replayed:/Turned on with Farm\. The server had already recorded this exact request\./,
    harvest_revision_changed:/data-tone="bad">Turn on refused: Harvesting was changed elsewhere/, policy_invalid:/data-tone="bad">Turn on refused: The run's saved gem settings are not usable\./,
    off_during_action_lock:/data-tone="ok">Paused; no collector was running\./, off_ok_replayed:/Paused; no collector was running\. The server had already recorded/,
    off_ok_stopped:/data-tone="ok">Paused; collector input stopped\./, off_ok_stopping:/data-tone="warn">Paused; collector input is still stopping and not confirmed stopped yet/,
    action_lock:/not confirmed \(Another action is in progress; wait for its result\)[\s\S]*Resend the same request/,
    outcome_unknown:/not confirmed \(The request may have been recorded[\s\S]*Resend the same request/,
    context_changed:/refused: The emulator, account or profile changed/, idempotency_key_reused:/refused: The request identity was reused/,
    invalid_request:/refused: The request was not valid\./};
  assert.deepEqual(Object.keys(fixture.post_harvest).sort(),Object.keys(expect).sort());
  for (const [name,answer] of Object.entries(fixture.post_harvest)) {
    for (const enabled of ON.includes(name) ? [true] : OFF.includes(name) ? [false] : [true,false]) {
      // the choice the person saw is revision 0: every fixture answer records a later one
      const seen=enabled ? harvest({desired:{...harvest().desired,revision:0}}) : on({desired:{...on().desired,revision:0}});
      const p=page({status:{harvest:seen}});
      p.t.routes['POST /api/harvest']=[reply(answer.status,answer.body)];
      await p.ctx.setHarvest(enabled);
      const out=p.gems();
      assert.match(out,expect[name],name+(enabled?' (on)':' (off)'));
      if (answer.status>=500 || answer.body.code==='action_lock') assert.equal(p.ctx.S.harvestIntent.state,'unknown',name);
      else assert.equal(p.ctx.S.harvestIntent,null,name);
      assert.equal(p.posts().length,1,name);
    }
  }
});

test('the collection-only handoff is a person\'s confirmed statement for the exact record, never sent by a render', async () => {
  const blocked={blocks_launch:true,code:'setup_battle_unresolved',operation_id:'92c1a558-5057',setup_battle_id:'cb63',evidence_revision:'sha-1',message:'held'};
  const p=page({status:{harvest:harvest(),setup_battle_guard:{...blocked,scope:'run'},collection_guard:{...blocked,scope:'collection'}},confirmAnswer:false});
  p.t.routes['POST /api/setup-battle/collection-handoff']=['drop',reply(200,{ok:true,created:true})];
  for(let i=0;i<3;i++)p.gems();
  assert.deepEqual(p.posts(),[]);
  assert.match(p.gems(),/setup test battle from operation 92c1a558[\s\S]*onclick="confirmCollectionHandoff\(\)"/);
  await p.ctx.confirmCollectionHandoff();
  assert.deepEqual([p.calls.filter(c=>c==='confirm').length,p.posts().length],[1,0]);   // declined: nothing sent
  p.ctx.confirm=()=>true;
  await p.ctx.confirmCollectionHandoff();
  assert.deepEqual(p.posts()[0],['POST','/api/setup-battle/collection-handoff',{operation_id:'92c1a558-5057',setup_battle_id:'cb63',evidence_revision:'sha-1',
    expected_context:{instance:'main',account:'alice',serial:'127.0.0.1:16384'},attestation:'new_manual_battle'}]);
  assert.match(p.gems(),/Collection-only confirmation: not confirmed \(Failed to fetch\)/);
  p.ctx.confirm=()=>{throw new Error('a resend must not ask again');};
  await p.ctx.confirmCollectionHandoff();
  assert.deepEqual(p.posts()[1][2],p.posts()[0][2]);
  assert.match(p.gems(),/Collection-only confirmation recorded\. Start playing stays blocked/);
  p.ctx.S.status.collection_guard={...free,evidence:'collection_handoff'};
  assert.doesNotMatch(p.gems(),/confirmCollectionHandoff/);
});

/* ------------------------------------------------- shared owner refusal */
const refuse=(p,url,answer)=>p.ctx.noteOwnerRefusal(url,Object.assign(new Error(answer.body.error),{status:answer.status,code:answer.body.code,body:clone(answer.body)}));
test('H2UI-06: the shared refusal names the exact owner and recovery and says the emulator is free only on later affirmative evidence', async () => {
  const p=page({status:{harvest:on({state:'collecting',operation:collector()}),processes:[{pid:7,runner:'gem_collector',operation:{id:'op-c',kind:'gems'}}]}});
  const body={ok:false,code:'device_owned',error:'A gem collector owns the emulator.',owner:{kind:'operation',operation_id:'op-c',operation_kind:'gems',harvest_managed:true},
    recovery:{action:'pause_harvesting',operation_id:'op-c',expected_revision:2},retry:'after_confirmed_stop'};
  refuse(p,'/api/wizard/reconnect',{status:409,body});
  assert.equal(p.box.hidden,false);
  assert.match(p.box.innerHTML,/<b>Reconnect was refused:<\/b> A gem collector owns the emulator\. <button class="small" onclick="setHarvest\(false\)" >Pause harvesting<\/button> then try it again once the collector has stopped\./);
  const FREE=/The emulator is free now/;
  // unreadable harvesting with a fresh empty scan: unknown choice is not paused, the owner is not proven gone
  p.laterRead({processes:[],harvest:harvest({desired:null,source:null,state:'unavailable',code:'status_failed'})});p.ctx.renderOwnerRefusal();
  assert.doesNotMatch(p.box.innerHTML,FREE);
  assert.match(p.box.innerHTML,/<button class="small" onclick="setHarvest\(false\)" >Pause harvesting<\/button>/);
  // paused but the collector still recorded (H2UI-R5-04): its own Stop, with the revision the status shows
  p.laterRead({processes:[],harvest:harvest({state:'stopping',operation:collector()})});p.ctx.renderOwnerRefusal();
  assert.match(p.box.innerHTML,/Harvesting is paused, but the collector is still recorded\. <button class="small danger" data-operation-id="op-c" data-operation-revision="2" data-operation-name="The diamond collector" onclick="stopOwnerOperation\(this\.dataset\.operationId,Number\(this\.dataset\.operationRevision\),this\.dataset\.operationName\)">Stop the diamond collector<\/button> then try it again once it has stopped\./);
  // paused and nothing recorded with a revision: no button to guess with
  p.laterRead({processes:[{pid:7,runner:'gem_collector',operation:{id:'op-c',kind:'gems'}}],harvest:harvest()});p.ctx.renderOwnerRefusal();
  assert.match(p.box.innerHTML,/Harvesting is paused; try it again once the collector has stopped\./);
  // stale scan, or a read started before the refusal: still not free
  p.laterRead({processes:[],harvest:harvest(),process_refresh:{state:'stale'}});p.ctx.renderOwnerRefusal();
  assert.doesNotMatch(p.box.innerHTML,FREE);
  p.ctx.S.status.process_refresh=FRESH;p.ctx.S.ownerRefusal.after=p.ctx.S.statusSeq;p.ctx.renderOwnerRefusal();
  assert.doesNotMatch(p.box.innerHTML,FREE);
  p.laterRead({});p.ctx.renderOwnerRefusal();
  assert.match(p.box.innerHTML,/data-tone="ok"><b>Reconnect was refused:[\s\S]*The emulator is free now; you can try it again\./);
  assert.deepEqual(p.posts(),[]);                                                     // nothing retried
  p.ctx.S.config.active_profile='bob';p.ctx.renderOwnerRefusal();
  assert.equal(p.box.hidden,true);                                                    // another context never shows it
  assert.match(html,/<div id="owner-refusal" class="owner-refusal" role="status" aria-live="polite" hidden><\/div>/);
  assert.match(section('async function api(','const post = '),/if \(!read && typeof noteOwnerRefusal === 'function'\) noteOwnerRefusal\(path, error\);/);
});

test('H2UI-R2-01/04/06: "free" needs a complete fresh read with no owner of any kind; the exact owner is matched by operation and PID', () => {
  const FREE=/The emulator is free now/;
  const A={kind:'operation',operation_id:'op-a',operation_kind:'gems',harvest_managed:true,pid:4343};
  const runB={pid:4242,runner:'orchestrator',operation:{id:'op-b',kind:'run',revision:6,status:'running',context:{selected_run:'bp_farm'}}};
  const ownerB={kind:'operation',operation_id:'op-b',operation_kind:'run',status:'running',pid:4242,selected_run:'bp_farm',
    recovery:{action:'stop_operation',operation_id:'op-b',expected_revision:6}};
  const notice=(owner,recovery,status)=>{
    const p=page({status:{harvest:on({state:'collecting',operation:{...collector(),id:'op-a'}}),processes:[{pid:4343,runner:'gem_collector',operation:{id:'op-a',kind:'gems'}}]}});
    refuse(p,'/api/wizard/reconnect',{status:409,body:{ok:false,code:'device_owned',error:'Owned.',owner,recovery,retry:'after_confirmed_stop'}});
    p.laterRead({processes:[],harvest:harvest(),process_refresh:FRESH,...status});p.ctx.renderOwnerRefusal();
    return p.box.innerHTML;
  };
  const pause={action:'pause_harvesting',operation_id:'op-a',expected_revision:2};
  // positive control: complete, fresh, Off, nothing holds the emulator
  assert.match(notice(A,pause,{}),/data-tone="ok"[\s\S]*The emulator is free now; you can try it again\./);
  // R2-01: absent or malformed fields are unknown
  for (const status of [{processes:undefined},{processes:null},{processes:[undefined]},{harvest:(({operation,...rest})=>rest)(harvest())},{harvest:(({owner,...rest})=>rest)(harvest())}])
    assert.doesNotMatch(notice(A,pause,status),FREE,JSON.stringify(status));
  // R2-04: the fresh label alone is not freshness
  for (const scan of [{...FRESH,age_sec:-1,last_success_at:NOW+1},{...FRESH,age_sec:180,last_success_at:NOW-180},{state:'fresh'},{...FRESH,last_success_at:NOW+60}])
    assert.doesNotMatch(notice(A,pause,{process_refresh:scan}),FREE,JSON.stringify(scan));
  // the exact owner's PID still held by an untracked process, or as a string: not gone
  assert.doesNotMatch(notice(A,pause,{processes:[{pid:4343,runner:'gem_collector'}]}),FREE);
  assert.doesNotMatch(notice({kind:'process',pid:4343,script:'orchestrator'},null,{processes:[{pid:'4343',runner:'orchestrator'}]}),FREE);
  // R2-06: A is gone but B holds the emulator: name B and offer B's recovery, never "free"
  const replaced=notice(A,pause,{processes:[runB],harvest:harvest({state:'owned_by_driver',owner:ownerB})});
  assert.doesNotMatch(replaced,FREE);
  assert.match(replaced,/data-tone="warn"[\s\S]*The diamond collector has stopped, but Farm now holds the emulator\. <button class="small danger" data-operation-id="op-b" data-operation-revision="6"[^>]*>Stop Farm<\/button> then try it again once it has stopped\./);
  // ... B visible only as a process, or as a new standalone collector
  assert.match(notice(A,pause,{processes:[runB]}),/has stopped, but Farm now holds the emulator\.[\s\S]*data-operation-id="op-b"/);
  assert.match(notice(A,null,{processes:[],harvest:harvest({operation:{...collector(),id:'op-c2',revision:4}})}),/has stopped, but the diamond collector now holds the emulator\.[\s\S]*data-operation-id="op-c2" data-operation-revision="4"/);
  // the same PID now positively another operation: A is gone, and that operation is named
  assert.match(notice(A,pause,{processes:[{...runB,pid:4343}]}),/has stopped, but Farm now holds the emulator/);
  // pause_harvesting recovery while the choice is still On: not free
  assert.doesNotMatch(notice(A,pause,{harvest:on()}),FREE);
});

test('every fixture refusal reaches the shared notice through the real api(), with the server-named recovery', async () => {
  const R=fixture.refusals, id=name=>R[name].body.recovery?.operation_id, rev=name=>R[name].body.recovery?.expected_revision;
  const escape=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const stop=(name,label)=>new RegExp(`data-operation-id="${escape(id(name))}" data-operation-revision="${rev(name)}"[^>]*>Stop ${escape(label)}</button>`);
  const expect={
    collector_running:[/<b>Collect diamonds only was refused:<\/b>[\s\S]*onclick="setHarvest\(false\)" >Pause harvesting/],
    collector_running_manual:[/<b>Collect diamonds only was refused:<\/b>/,stop('collector_running_manual','the diamond collector you started')],
    collector_stopping:[/<b>Starting automation was refused:<\/b> The diamond collector is still stopping[\s\S]*Pause harvesting/],
    device_owned_collector:[/<b>Reconnect was refused:<\/b> Stop automation before changing accounts\.[\s\S]*Pause harvesting/],
    device_owned_pre_spawn:[/<b>Reconnect was refused:<\/b> Stop automation before changing accounts\. /,stop('device_owned_pre_spawn','the run that is starting')],
    device_owned_process:[/<b>Reconnect was refused:<\/b> runners alive - stop them first orchestrator \(PID 4242\) belongs to another installation; stop it there, then try it again\./],
    device_owned_run:[/<b>Reconnect was refused:<\/b>/,stop('device_owned_run','the running automation')],
    // known only by the emulator lease: no PID or script to name, no recovery; it is never proven gone
    device_owned_lease:[/<b>Reconnect was refused:<\/b> Stop automation before changing accounts\. An unidentified automation process belongs to another installation; stop it there, then try it again\./],
    device_owner_unreadable:[new RegExp(`<b>Reconnect was refused:</b> ${escape(R.device_owner_unreadable.body.error)} Who holds the emulator is not known here, so there is nothing to stop; try the action again\\.\\s*<button class="small ghost" onclick="S.ownerRefusal=null;renderOwnerRefusal\\(\\)">Dismiss</button></p>$`)],
    action_lock:null, reserved_fields:null, setup_battle_unresolved:null};
  // every published refusal has an expectation here: a new sample fails until it is handled
  assert.deepEqual(Object.keys(R).sort(),Object.keys(expect).sort());
  for (const [name,answer] of Object.entries(R)) {
    const p=page({status:{harvest:on()}});
    const url=name==='collector_stopping' || name.startsWith('collector_running') ? '/api/control' : '/api/wizard/reconnect';
    p.t.routes['POST '+url]=[reply(answer.status,answer.body)];
    await assert.rejects(p.ctx.post(url,{}));
    if (!expect[name]) { assert.equal(p.ctx.S.ownerRefusal,undefined,name); continue; }
    for (const pattern of expect[name]) assert.match(p.box.innerHTML,pattern,name);
    assert.doesNotMatch(p.box.innerHTML,/free now/,name);
    // nothing holds the emulator in a later complete read: free only where an owner was named
    p.laterRead({processes:[],harvest:harvest(),process_refresh:FRESH});p.ctx.renderOwnerRefusal();
    if (name==='device_owner_unreadable') assert.doesNotMatch(p.box.innerHTML,/free now|Pause harvesting|>Stop /,name);
    // an owner with no operation id and no PID cannot be proven gone by a read that never listed it
    if (name==='device_owned_lease') assert.doesNotMatch(p.box.innerHTML,/free now|Pause harvesting|>Stop /,name);
    if (name==='device_owned_pre_spawn') assert.match(p.box.innerHTML,/The emulator is free now/,name);
    assert.deepEqual(p.posts().map(([, path])=>path),[url],name);                   // nothing retried
  }
  // scan promotion is one of the owner routes
  const p=page({status:{harvest:on()}});
  refuse(p,'/api/profile-promote',R.device_owned_run);
  assert.match(p.box.innerHTML,/<b>Promoting the scan draft was refused:/);
});

/* ------------------------------------------ game input revocation (H2-05) */
function runnerPage(status, taps=true){
  const body={dataset:{},_html:'',set innerHTML(v){this._html=v;},get innerHTML(){return this._html;},contains:()=>false,querySelector:()=>null,querySelectorAll:()=>[]};
  const ctx=vm.createContext({S:{status,config:config(taps),runs:{bp_farm:{label:'Farm'}},runReadiness:{bp_farm:{ready:true}},readinessFresh:true,readinessContext:LearningStore.context(config(taps)).id},
    LearningStore,WorkspaceStatus,DashboardView,LearningView:require('../webui/learning-view.js'),document:{activeElement:null,getElementById:()=>null},
    $:key=>key==='#runner-body'?body:undefined,esc:String,renderRunReady:()=>{},previewStartRun:()=>{}});
  vm.runInContext(section('function renderRunner(){','function renderRunReady('),ctx);
  return {ctx,body,html:()=>{body.dataset.key='';ctx.renderRunner();return body.innerHTML;}};
}
test('turning game input off stays reachable while automation runs', () => {
  const procs=[{pid:7,runner:'gem_collector',operation:{id:'op-c',kind:'gems'}}];
  const p=runnerPage({device_state:'device',processes:procs,setup_battle_guard:free,collection_guard:free});
  assert.match(p.html(),/id="automation-access" checked  onchange=/);
  assert.match(runnerPage({device_state:'device',processes:procs},false).html(),/id="automation-access"  disabled onchange=/);   // turning on still waits
});
test('H2UI-02: every fixture game-input answer is restated without promotion; setting saved and input stopped are separate facts', async () => {
  const A=fixture.automation_access, OK='data-tone="ok"', WARN='data-tone="warn"', BAD='data-tone="bad"';
  const escape=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const expect={
    disable_driver_input_refused:[OK,/^Game input is off and automation input stopped\. The running automation keeps running without input; Stop now ends it\. The setting is saved\.$/],
    disable_during_action_lock:[OK,/^Game input is off; nothing was running\. The setting is saved\.$/],
    disable_input_stopped:[OK,/^Game input is off and automation input stopped\. The setting is saved\. Harvesting is paused\.$/],
    disable_not_enforced:[WARN,/^Game input off was not enforced on the running automation, so it may still tap\. Use Stop now on it to end its input; the battle keeps playing\. The setting is saved\.$/],
    disable_nothing_running:[OK,/^Game input is off; nothing was running\. The setting is saved\.$/],
    disable_stopping:[WARN,/^Game input off: collector input is still stopping and not confirmed stopped yet\. The setting is saved\. Harvesting is paused\.$/],
    // HTTP 500: the server's own message, then what its revocation says it did; never "input stopped"
    disable_marker_write_failed:[BAD,new RegExp('^Turning game input off failed: '+escape(A.disable_marker_write_failed?.body.error)
      +' Running automation input is not revoked\\. The setting is saved\\. Harvesting is paused\\. One collector was stopped\\. Failed steps: revoke input: PermissionError: \\[Errno 13\\] denied\\.$')],
    // the server could not read who holds the emulator lease: input is not confirmed stopped, and the step is named
    disable_lease_scan_failed:[WARN,/^Game input off is not confirmed\. Failed steps: lease state: OSError: probe cannot inspect lease\. The setting is saved\.$/],
    enable_ok:null, enable_during_action_lock:null, enable_refused_owner:null};
  // every published answer has an expectation here: a new sample fails until it is handled
  assert.deepEqual(Object.keys(A).sort(),Object.keys(expect).sort());
  const note=p=>{const out=p.ctx.accessFeedbackHTML();return [/data-tone="\w+"/.exec(out)?.[0],/>([^<]*)</.exec(out)?.[1].trim(),out];};
  for (const [name,answer] of Object.entries(A)) {
    const p=page({status:{harvest:on(),processes:[]}});
    p.t.routes['POST /api/automation-access']=[reply(answer.status,answer.body)];
    const enabled=name.startsWith('enable_');
    await p.ctx.setAutomationAccess(enabled,{});
    assert.deepEqual(p.posts()[0][2],{enabled},name);
    assert.equal(p.ctx.S.automationAccessBusy,false,name);
    if (enabled) {
      assert.equal(p.ctx.S.accessFeedback,null,name);
      if (answer.status===409) assert.ok(p.calls.some(c=>c[0]==='toast' && c[2]),name);
      if (answer.body.code==='device_owned')
        assert.match(p.box.innerHTML,new RegExp(`<b>Turning game input on was refused:</b>[\\s\\S]*data-operation-id="${escape(answer.body.recovery.operation_id)}"`),name);
      continue;
    }
    const [tone,text,out]=note(p);
    assert.equal(tone,expect[name][0],name);assert.match(text,expect[name][1],name);
    if (answer.status!==200) assert.match(out,/onclick="setAutomationAccess\(false\)">Try again/,name);
    assert.doesNotMatch(text,tone===OK?/not confirmed|failed/:/automation input stopped\.|collector has stopped/,name);
  }
  // disable_stopping: absent or unreadable evidence never confirms; a later complete fresh read does
  const stopping=A.disable_stopping, id=stopping.body.revocation.stopping[0];
  const p=page({status:{harvest:on({state:'stopping',operation:{...collector(),id}}),processes:[]}});
  p.t.routes['POST /api/automation-access']=[reply(200,stopping.body)];
  await p.ctx.setAutomationAccess(false,{});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="warn">Game input off: collector input is still stopping/);   // empty processes prove nothing
  for (const status of [{harvest:harvest({desired:null,source:null,state:'unavailable',code:'status_failed'})},{harvest:harvest({state:'stopping',operation:{...collector(),id}})},
    {harvest:harvest(),processes:undefined},{harvest:harvest(),process_refresh:{...FRESH,age_sec:-5,last_success_at:NOW+5}}]) {
    p.laterRead({processes:[],process_refresh:FRESH,...status});
    assert.match(p.ctx.accessFeedbackHTML(),/data-tone="warn"/,JSON.stringify(status).slice(0,80));
  }
  // (a turn-off the server applied publishes the revocation marker: the later status reports input revoked)
  p.laterRead({harvest:harvest({desired:{...harvest().desired,revision:2},input_revoked:true}),processes:[],process_refresh:FRESH});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off and the collector has stopped\. The setting is saved\. Harvesting is paused\./);
});

test('H2UI-R2-05: "Harvesting is paused" belongs to the choice revision the answer recorded; a newer or contradicting choice retires it', async () => {
  const stopping=fixture.automation_access.disable_stopping, id=stopping.body.revocation.stopping[0], paused=stopping.body.revocation.harvest.revision;
  const start=async()=>{const p=page({status:{harvest:on({state:'collecting',operation:{...collector(),id}}),processes:[{pid:4242,runner:'gem_collector',operation:{id,kind:'gems'}}]}});
    p.t.routes['POST /api/automation-access']=[reply(200,stopping.body)];await p.ctx.setAutomationAccess(false,{});return p;};
  // Astra's case: the stopped collector is gone, but the later read reports the published starting_due (choice On)
  let p=await start();
  p.laterRead({processes:[],harvest:clone(fixture.status.starting_due),process_refresh:FRESH});
  let out=p.ctx.accessFeedbackHTML();
  assert.doesNotMatch(out,/data-tone="ok"|Harvesting is paused\./);
  assert.match(out,/This answer paused harvesting, but the latest status reads it as On\./);
  // a newer choice than the one this answer recorded: the pause is history
  p=await start();
  p.laterRead({processes:[],harvest:on({state:'starting',desired:{...on().desired,revision:paused+1}}),process_refresh:FRESH});
  out=p.ctx.accessFeedbackHTML();
  assert.match(out,/Harvesting was paused by this answer; a newer choice \(On\) has been made since\./);
  assert.doesNotMatch(out,/data-tone="ok"/);
  // unknown choice: not confirmed either
  p=await start();
  p.laterRead({processes:[],harvest:harvest({desired:{...harvest().desired,choice:'unknown'}}),process_refresh:FRESH});
  assert.doesNotMatch(p.ctx.accessFeedbackHTML(),/data-tone="ok"/);
  // control: the same disappearance with the choice Off at that revision (input revoked, as the server publishes it)
  p=await start();
  p.laterRead({processes:[],harvest:harvest({desired:{...harvest().desired,revision:paused},input_revoked:true}),process_refresh:FRESH});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off and the collector has stopped\. The setting is saved\. Harvesting is paused\./);
});

test('H2UI-02: an unfenced owner, a failed fence, an unlatched gate, a scan failure and a revocation failure are never shown as stopped input', async () => {
  const run={kind:'operation',operation_id:'op-r',operation_kind:'run',status:'running',input:'unfenced'};
  const rev=extra=>({state:'stopping',fenced:true,latched:true,config_persisted:true,revoked_at:NOW,harvest:{paused:true,revision:5},stopped:[],stopping:[],errors:[],still_owned:[],...extra});
  const show=(revocation,status={},failed)=>{const p=page({status:{harvest:on(),processes:[],...status}});
    p.ctx.S.accessFeedback={context:LearningStore.context(config()).id,revocation,after:0,...(failed?{failed}:{})};p.laterRead({});return p.ctx.accessFeedbackHTML();};
  // the reviewer's r1 case: stopping, not fenced, nothing listed as stopping, a full run unfenced
  assert.match(show(rev({fenced:false,still_owned:[run]})),/data-tone="warn">Game input off was not enforced on the running automation, so it may still tap\./);
  assert.match(show(rev({still_owned:[{...run,selected_run:'bp_farm'}]})),/not enforced on Farm, so it may still tap\. Stop it to end its input;/);
  assert.match(show(rev({still_owned:[{...run,recovery:{action:'stop_operation',operation_id:'op-r',expected_revision:2}}]})),/Use Stop now on it to end its input; the battle keeps playing\./);
  assert.match(show(rev({still_owned:[{kind:'process',pid:42,script:'orchestrator',foreign:true,input:'unfenced',recovery:null}]})),
    /not enforced on orchestrator \(PID 42\), so it may still tap\. It belongs to another installation; stop it there to end its input;/);
  // the stopping collector visible only as harvest.operation
  assert.match(show(rev({stopping:['op-c']}),{harvest:on({state:'stopping',operation:collector()})}),/data-tone="warn">Game input off: collector input is still stopping/);
  assert.match(show(rev({fenced:false})),/data-tone="warn">The server did not confirm that running input was fenced\.[\s\S]*Try again/);
  assert.match(show(rev({state:'input_stopped',fenced:false})),/data-tone="warn">The server did not confirm that running input was fenced/);
  assert.match(show(rev({state:'nothing_running',latched:false})),/data-tone="warn">The server did not confirm that game input off is latched\./);
  // a scan of who still holds the emulator failed: stopping with errors is unconfirmed
  assert.match(show(rev({errors:[{step:'owners',message:'OSError: busy'}]})),/data-tone="warn">Game input off is not confirmed\. Failed steps: owners: OSError: busy\./);
  assert.match(show(rev({state:'input_stopped',errors:['lease busy']})),/data-tone="warn">Game input off is not confirmed\. Failed steps: lease busy\./);
  assert.match(show(rev({state:'input_stopped',still_owned:[run]})),/data-tone="warn">[\s\S]*not enforced/);
  // the setting and the input are separate facts
  assert.match(show(rev({state:'input_stopped',config_persisted:false})),/data-tone="warn">Game input is off and automation input stopped\. The setting was not saved, so automation started later could still tap\./);
  // state failed without an HTTP error (any route): never green, never "stopped"
  assert.match(show(rev({state:'failed',fenced:false,latched:false,errors:[{step:'revoke_input',message:'denied'}]})),
    /data-tone="bad">Game input was not revoked, so a running automation may still send input\. Failed steps: revoke input: denied\./);
  assert.match(show(rev({state:'owned_by_automation'})),/data-tone="warn">The server reported (&quot;|")owned_by_automation(&quot;|") for game input off\./);
  assert.match(show(null),/data-tone="warn">Game input off was accepted, but the server did not say what stopped\./);
});

test('H2UI-02/05: a lost or unanswered turn-off is never stopped; it unlocks the switch and supersedes a waiting Turn on', async () => {
  const p=page({status:{harvest:harvest(),processes:[]}});
  p.t.routes['POST /api/automation-access']=['drop'];
  await p.ctx.setAutomationAccess(false,{});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="bad">Turning game input off was not confirmed: Failed to fetch <button class="small ghost" onclick="setAutomationAccess\(false\)">Try again/);
  // no answer within the window: unconfirmed and unlocked; a late answer replaces only that outcome
  const q=page({status:{harvest:harvest(),processes:[]}});
  const hold=held();q.t.routes['POST /api/automation-access']=[hold.step];
  const off=q.ctx.setAutomationAccess(false,{});
  assert.match(q.ctx.accessFeedbackHTML(),/data-tone="busy">Turning game input off…/);
  q.fire(15000);await off;
  assert.equal(q.ctx.S.automationAccessBusy,false);
  assert.match(q.ctx.accessFeedbackHTML(),/not confirmed: No answer within 15 s/);
  hold.release(reply(200,fixture.automation_access.disable_nothing_running.body));await flush();await flush();
  assert.match(q.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off; nothing was running\. The setting is saved\./);
  // the reviewer's race: Turn on held, game input turned off, then the old Turn on answers
  const r=page({status:{harvest:harvest(),processes:[]}});
  const turnOn=held();
  r.t.routes['POST /api/harvest']=[turnOn.step];
  r.t.routes['POST /api/automation-access']=[reply(200,fixture.automation_access.disable_input_stopped.body)];
  const sending=r.ctx.setHarvest(true);
  await r.ctx.setAutomationAccess(false,{});
  r.ctx.S.status.harvest=harvest({desired:{...harvest().desired,revision:6}});
  turnOn.release(reply(200,{ok:true,replayed:false,desired:{revision:5},stop:null}));await sending;await flush();
  const out=r.gems();
  assert.doesNotMatch(out,/Turned on/);
  assert.match(out,/Turning game input off replaced the unconfirmed Turn on; it is not resent\./);
  assert.doesNotMatch(out,/Resend the same request/);
  assert.match(r.ctx.accessFeedbackHTML(),/automation input stopped\. The setting is saved\. Harvesting is paused\./);
});

/* ------------------------------------------ Edit in Runs (H2UI-R2-03) */
/* The real game-input switch, loadHomeData, and the Edit in Runs wrapper over a
   fake fetch whose profile read the test holds. */
function editPage(){
  const p=page({status:{harvest:harvest(),processes:[]}});
  const selected={name:'coin_default'},opened=[];
  Object.assign(p.ctx,{deep:value=>clone(value),applyLocal:()=>{},syncSaveBar:()=>{},runWorkspace:{selected:()=>selected.name},
    selectRunControls:async name=>{opened.push(name);selected.name=name;}});
  p.ctx.S.pending=new Map();p.ctx.S.profile={blueprints:{coin_default:{},shard_run:{}}};
  vm.runInContext(section('function runsBlueprint(','async function loadHomeData(){'),p.ctx);
  vm.runInContext(section('async function loadHomeData(){','/* ------------------------------------------------------------------ gate */'),p.ctx);
  const R=p.t.routes;
  R['GET /api/vocab']=()=>reply(200,{vocab:{}});R['GET /api/flows']=()=>reply(200,{flows:{}});R['GET /api/config']=()=>reply(200,config());
  R['GET /api/profiles']=()=>reply(200,{profiles:[{name:'alice'}]});R['GET /api/run-templates']=()=>reply(200,{templates:[]});
  const click=run=>p.clicks[0]({target:{closest:()=>({dataset:{run}})},preventDefault(){}});
  const toasts=()=>p.calls.filter(c=>c[0]==='toast'&&c[2]).map(c=>c[1]);
  return {...p,selected,opened,click,toasts};
}
const PROFILE={ok:true,profile:{blueprints:{coin_default:{},shard_run:{}}},revision:'r2'};
test('H2UI-R2-03: Edit in Runs keeps its exact target across the profile re-read that turning game input off starts', async () => {
  const p=editPage();
  const read=held();p.t.routes['GET /api/profile-src/alice']=[read.step];
  p.t.routes['POST /api/automation-access']=[reply(200,fixture.automation_access.disable_input_stopped.body)];
  const toggle=p.ctx.setAutomationAccess(false,{});                                 // the real switch handler starts loadHomeData
  // the observable state Astra reproduced: the profile is null while its read is held
  for(let i=0;i<20 && p.ctx.S.profile!==null;i++)await flush();
  assert.equal(p.ctx.S.profile,null,'the profile is being re-read');
  p.click('shard_run');
  await flush();
  assert.deepEqual([p.ctx.location.hash,p.opened],['#overview',[]],'nothing opens against a missing profile');
  read.release(reply(200,PROFILE));await toggle;await flush();await flush();
  assert.deepEqual([p.ctx.location.hash,p.opened,p.selected.name],['#runs',['shard_run'],'shard_run']);
  assert.deepEqual(p.toasts(),[]);
  // control: with the profile loaded the link opens at once
  p.ctx.location.hash='#overview';p.click('bp_coin_default');await flush();
  assert.deepEqual(p.opened,['shard_run','coin_default']);
});
test('H2UI-R2-03: a run the profile lacks, a failed profile read or a read that never ends opens nothing and says so; a later click wins', async () => {
  let p=editPage();
  p.click('bp_missing');await flush();
  assert.deepEqual([p.ctx.location.hash,p.opened],['#overview',[]]);
  assert.match(p.toasts()[0],/bp_missing is not a run in the active profile, so Runs was not opened\./);
  // the profile read fails while the click waits
  p=editPage();const failing=held();p.t.routes['GET /api/profile-src/alice']=[failing.step];
  const reading=p.ctx.loadHomeData();for(let i=0;i<20 && p.ctx.S.profile!==null;i++)await flush();
  assert.equal(p.ctx.S.profile,null);
  p.click('shard_run');failing.release(reply(500,{ok:false,error:'locked'}));await reading;await flush();await flush();
  assert.deepEqual([p.ctx.location.hash,p.opened],['#overview',[]]);
  assert.ok(p.toasts().some(text=>/The active profile is not loaded, so shard_run was not opened in Runs; try again\./.test(text)),p.toasts().join(' | '));
  // a read that never ends: the wait is bounded
  p=editPage();p.t.routes['GET /api/profile-src/alice']=[()=>new Promise(()=>{})];
  p.ctx.loadHomeData();for(let i=0;i<20 && p.ctx.S.profile!==null;i++)await flush();
  p.click('shard_run');await flush();
  p.fire(10000);await flush();await flush();
  assert.deepEqual([p.ctx.location.hash,p.opened],['#overview',[]]);
  assert.ok(p.toasts().some(text=>/not loaded/.test(text)));
  // two clicks while waiting: only the later one opens
  p=editPage();const read=held();p.t.routes['GET /api/profile-src/alice']=[read.step];
  const loading=p.ctx.loadHomeData();for(let i=0;i<20 && p.ctx.S.profile!==null;i++)await flush();
  p.click('shard_run');p.click('coin_default');
  read.release(reply(200,PROFILE));await loading;await flush();await flush();
  assert.deepEqual(p.opened,['coin_default']);
  assert.deepEqual(p.posts(),[]);
});

/* ------------------------------------- collection is said only with evidence */
test('"Collecting" is said only with a live worker and a fresh observation; an operation still reading running is not proof', () => {
  const c=clone(fixture.status.collecting);
  assert.equal(DashboardView.harvestView({harvest:c,now:c.server_time}).headline,'On \u00b7 Collecting gems in the battle on screen');
  // a dead worker the refresher has not retired yet (about 2 s), or an observation the server did not call fresh
  for (const change of [h=>{h.operation.worker_alive=false;},h=>{h.operation.worker_alive=null;},h=>{h.operation.battle.fresh=false;},
    h=>{h.operation.battle.observation_status='lost';},h=>{h.operation.battle.observation_age_sec=-3;},h=>{h.operation.battle=null;}]) {
    const h=clone(c);change(h);
    const v=DashboardView.harvestView({harvest:h,now:h.server_time});
    assert.deepEqual([v.headline,v.tone,v.detail],['On \u00b7 Collector state unknown','warn',"the collector's report does not confirm collection"]);
  }
});

test('H2UI-R3-02: turning game input off overrides a turn-on still in flight; the late turn-on answer changes nothing', async () => {
  const p=page({status:{harvest:harvest(),processes:[]}});
  p.ctx.S.config.instances.main.allow_taps=false;
  const enable=held();
  p.t.routes['POST /api/automation-access']=[enable.step,reply(200,fixture.automation_access.disable_nothing_running.body)];
  const enabling=p.ctx.setAutomationAccess(true,{});
  assert.deepEqual([p.ctx.S.accessPending?.enabled,p.ctx.S.automationAccessBusy],[true,true]);
  await p.ctx.setAutomationAccess(true,{});assert.equal(p.posts().length,1,'one turn-on at a time');
  const input={disabled:false};
  const disabling=p.ctx.setAutomationAccess(false,input);
  assert.equal(p.posts().length,2,'the turn-off is sent at once');
  assert.deepEqual(p.posts().map(([, , body])=>body),[{enabled:true},{enabled:false}]);
  assert.equal(input.disabled,true);
  await disabling;
  // (H2UI-R5-01) the turn-on sent before it has no answer yet: it can still allow taps, so never green
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="warn">Game input off was applied, but an earlier turn-on has no answer and may still reach the server and allow taps again, so input off is not fully confirmed\./);
  assert.equal(p.ctx.S.automationAccessBusy,false);
  // the turn-on answers late (success): no toast, no pending state, no flip of the switch; it was applied while the
  // turn-off was on its way, so input off stays unconfirmed until a settings read after it
  enable.release(reply(200,{ok:true,enabled:true}));await enabling;await flush();
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="warn">Game input off was applied, but an earlier turn-on was applied while this turn-off was on its way and may have allowed taps again/);
  assert.deepEqual([p.ctx.S.accessPending,p.ctx.S.automationAccessBusy],[null,false]);
  assert.deepEqual(p.calls.filter(c=>c[0]==='toast'),[]);
  // a settings read after it decides: taps off again (the turn-on landed first) is confirmed; taps on is history (R3-06)
  p.ctx.S.configReadStarted=(p.ctx.S.configReadStarted || 0)+1;p.ctx.S.configSeq=p.ctx.S.configReadStarted;
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off; nothing was running\./);
  p.ctx.S.config.instances.main.allow_taps=true;
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="warn">Game input is allowed now/);
  const q=page({status:{harvest:harvest(),processes:[]}});
  const refused=held();q.t.routes['POST /api/automation-access']=[refused.step,reply(200,fixture.automation_access.disable_nothing_running.body)];
  const qEnable=q.ctx.setAutomationAccess(true,{});await q.ctx.setAutomationAccess(false,{});
  refused.release(reply(409,{ok:false,code:'action_lock',error:'Another action is in progress'}));await qEnable;await flush();
  assert.deepEqual(q.calls.filter(c=>c[0]==='toast'),[]);
  assert.match(q.ctx.accessFeedbackHTML(),/Game input is off; nothing was running\./);
  // a turn-off in flight blocks a new turn-on (never the other way round)
  const r=page({status:{harvest:harvest(),processes:[]}});const off=held();r.t.routes['POST /api/automation-access']=[off.step];
  const rOff=r.ctx.setAutomationAccess(false,{});await r.ctx.setAutomationAccess(true,{});
  assert.equal(r.posts().length,1);off.release(reply(200,fixture.automation_access.disable_nothing_running.body));await rOff;
});

test('H2UI-R3-02: the switch shows the request in flight and stays reachable for turning off while a turn-on is sent', () => {
  const sw=(pending,taps,processes=[])=>{const p=runnerPage({device_state:'device',processes,setup_battle_guard:free,collection_guard:free},taps);
    p.ctx.S.accessPending=pending;p.ctx.S.automationAccessBusy=!!pending;return /<input type="checkbox" id="automation-access"([^>]*)>/.exec(p.html())[1];};
  assert.match(sw({enabled:true},false),/^ checked  onchange=/,'turn-on in flight: checked and enabled');
  assert.match(sw({enabled:false},true),/^  disabled onchange=/,'turn-off in flight: unchecked, held');
  assert.match(sw(null,true,[{pid:7,runner:'gem_collector'}]),/^ checked  onchange=/,'turning off always reachable');
  assert.match(sw(null,false,[{pid:7,runner:'gem_collector'}]),/^  disabled onchange=/,'turning on waits while automation runs');
});

test('H2UI-R3-06: once the saved setting allows taps again, the whole tap-off outcome is history, never green', async () => {
  for (const [name,body] of [['input stopped',fixture.automation_access.disable_input_stopped.body],['nothing running',fixture.automation_access.disable_nothing_running.body]]) {
    const p=editPage();
    p.t.routes['GET /api/config']=()=>reply(200,config(true));                   // the setting read after the answer allows taps
    p.t.routes['GET /api/profile-src/alice']=()=>reply(200,PROFILE);
    p.t.routes['POST /api/automation-access']=[reply(200,body)];
    await p.ctx.setAutomationAccess(false,{});
    const out=p.ctx.accessFeedbackHTML();
    assert.doesNotMatch(out,/data-tone="ok"|automation input stopped|nothing was running/,name);
    assert.match(out,/data-tone="warn">Game input is allowed now: the saved setting allows taps again, so this earlier turn-off is no longer in effect\./,name);
    // control: the saved setting read after the answer still has taps off
    const q=editPage();
    q.t.routes['GET /api/config']=()=>reply(200,config(false));
    q.t.routes['GET /api/profile-src/alice']=()=>reply(200,PROFILE);
    q.t.routes['POST /api/automation-access']=[reply(200,body)];
    await q.ctx.setAutomationAccess(false,{});
    assert.match(q.ctx.accessFeedbackHTML(),/data-tone="ok"/,name+' control');
  }
  // a config read that started before the answer says nothing about it
  const p=page({status:{harvest:harvest(),processes:[]}});
  p.t.routes['POST /api/automation-access']=[reply(200,fixture.automation_access.disable_nothing_running.body)];
  await p.ctx.setAutomationAccess(false,{});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok"/);
});

test('H2UI-R3-04: a waiting Edit in Runs is cancelled when the person opens another page; the pre-profile reads are waited for too', async () => {
  for (const tab of ['#equipment','#profiles']) {
    const p=editPage();const read=held();p.t.routes['GET /api/profile-src/alice']=[read.step];
    const loading=p.ctx.loadHomeData();for(let i=0;i<20 && p.ctx.S.profile!==null;i++)await flush();
    p.click('shard_run');await flush();
    p.ctx.location.hash=tab;p.ctx.S.routeRequest=(p.ctx.S.routeRequest || 0)+1;      // what route() does on the person's navigation
    read.release(reply(200,PROFILE));await loading;await flush();await flush();
    assert.deepEqual([p.ctx.location.hash,p.opened],[tab,[]],tab);
    assert.deepEqual(p.toasts(),[],tab);
  }
  // route() bumps the request it is cancelled by
  assert.match(section('async function route(){','for (const id of ["editor"'),/S\.routeRequest = request;/);
  // first load: the config/profile list reads run before the profile read; a click then waits instead of refusing
  const p=editPage();p.ctx.S.profile=null;
  const cfg=held();p.t.routes['GET /api/config']=[cfg.step];p.t.routes['GET /api/profile-src/alice']=[reply(200,PROFILE)];
  const loading=p.ctx.loadHomeData();
  p.click('shard_run');await flush();
  assert.deepEqual([p.ctx.location.hash,p.opened],['#overview',[]]);
  cfg.release(reply(200,config()));await loading;await flush();await flush();
  assert.deepEqual([p.ctx.location.hash,p.opened],['#runs',['shard_run']]);
  assert.deepEqual(p.toasts(),[]);
});
/* --------------------------------------------- collector-to-run handover */
function readyPage(processes,choice='on',harvestValue){
  const controls={'#start-preset':{value:'bp_farm'},'#run-ready':{},'#start-run':{},'#start-gems':{}};
  const cfg=config();
  const ctx=vm.createContext({LearningStore,WorkspaceStatus,S:{config:cfg,status:{device_state:'device',processes,setup_battle_guard:free,collection_guard:free,
      harvest:harvestValue ?? (choice==='on'?on():harvest())},runReadiness:{bp_farm:{ready:true}},readinessFresh:true,readinessContext:LearningStore.context(cfg).id},
    $:key=>controls[key],esc:String,document:{querySelectorAll:()=>[]},outstandingCard:()=>''});
  vm.runInContext(section('function renderRunReady(){','async function killPid('),ctx);
  ctx.renderRunReady();
  return controls;
}
test('with only a gem collector running, Start hands the emulator over and Collect waits; any other driver holds both', () => {
  const collector=[{pid:7,runner:'gem_collector',operation:{id:'op-c',kind:'gems'}}];
  let c=readyPage(collector);
  assert.equal(c['#start-run'].disabled,false);assert.equal(c['#start-gems'].disabled,true);
  assert.match(c['#run-ready'].innerHTML,/A gem collector is running\. Start playing hands the emulator over: the collector stops first and the battle keeps playing; harvesting stays on and resumes after the run ends\./);
  assert.match(c['#run-ready'].innerHTML,/Collect diamonds only: a collector is already running\./);
  assert.doesNotMatch(readyPage(collector,'off')['#run-ready'].innerHTML,/harvesting stays on/);
  c=readyPage([...collector,{pid:9,runner:'orchestrator',operation:{id:'op-r',kind:'run'}}]);
  assert.deepEqual([c['#start-run'].disabled,c['#start-gems'].disabled],[true,true]);
  assert.match(c['#run-ready'].innerHTML,/Automation is running; Start and Collect wait until it stops\./);
});
test('the fixture start transfer is reported as the collector stopping first; the start request carries no private harvesting field', async () => {
  const cfg=config(),scope=LearningStore.context(cfg);
  const t=transport(),toasts=[];
  t.routes['GET /api/readiness']=[reply(200,{ok:true,ready:true,context:{instance:scope.instance,account:scope.account,serial:scope.serial,rendering:scope.rendering ?? null,profile:scope.profile}})];
  const answer=fixture.start_transfer.run_takes_over_collector;
  t.routes['POST /api/control']=[reply(answer.status,answer.body)];
  const ctx=vm.createContext({S:{config:cfg,runs:{bp_farm:{label:'Farm'}},status:{harvest:on()}},LearningStore,WorkspaceStatus,DashboardView,AbortController,fetch:t.fetch,
    $:key=>key==='#start-preset'?{value:'bp_farm'}:null,crypto:{randomUUID:()=>'start-key-0001'},reportDiagnostic:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
    toast:(message,error)=>toasts.push([message,!!error]),loadStatus:()=>{},renderRunReady:()=>{},refreshWorkspaceStatus:()=>{},esc:String});
  vm.runInContext(section('async function api(','const post = '),ctx);
  vm.runInContext('var post = (p, b) => api(p, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(b || {})});',ctx);
  vm.runInContext(section('function definiteRefusal(','async function ctl('),ctx);
  vm.runInContext(section(GEMS,'/* The control that had focus'),ctx);
  await ctx.startPreset();
  const sent=t.posts()[0][2];
  assert.deepEqual(Object.keys(sent).sort(),['action','expected_context','idempotency_key','preset']);
  assert.ok(!('harvest' in sent) && !('desire_revision' in sent));
  assert.deepEqual(toasts,[['Start accepted \u00b7 operation '+String(answer.body.operation_id).slice(0,8)+' \u00b7 the gem collector stopped first (0 s)',false]]);
});
test('H2UI-R3-08 (same family): a start handover whose lists are missing, malformed or contradictory never says the collector stopped', async () => {
  const cfg=config(),scope=LearningStore.context(cfg);
  const answer=fixture.start_transfer.run_takes_over_collector, id=answer.body.transfer.stopped[0];
  const toastFor=async transfer=>{
    const t=transport(),toasts=[];
    t.routes['GET /api/readiness']=[reply(200,{ok:true,ready:true,context:{instance:scope.instance,account:scope.account,serial:scope.serial,rendering:scope.rendering ?? null,profile:scope.profile}})];
    const body=clone(answer.body);if(transfer===undefined)delete body.transfer;else body.transfer=transfer;
    t.routes['POST /api/control']=[reply(200,body)];
    const ctx=vm.createContext({S:{config:cfg,runs:{bp_farm:{label:'Farm'}},status:{harvest:on()}},LearningStore,WorkspaceStatus,DashboardView,AbortController,fetch:t.fetch,
      $:key=>key==='#start-preset'?{value:'bp_farm'}:null,crypto:{randomUUID:()=>'start-key-0001'},reportDiagnostic:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
      toast:(message,error)=>toasts.push([message,!!error]),loadStatus:()=>{},renderRunReady:()=>{},refreshWorkspaceStatus:()=>{},esc:String});
    vm.runInContext(section('async function api(','const post = '),ctx);
    vm.runInContext('var post = (p, b) => api(p, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(b || {})});',ctx);
    vm.runInContext(section('function definiteRefusal(','async function ctl('),ctx);
    vm.runInContext(section(GEMS,'/* The control that had focus'),ctx);
    await ctx.startPreset();
    assert.equal(toasts.length,1);
    return toasts[0][0];
  };
  for (const transfer of [{},[],'stopped',{stopped:[id]},{stopping:[]},{stopped:null,stopping:[]},{stopped:[id],stopping:null},{stopped:[42],stopping:[]},
    {stopped:[''],stopping:[]},{stopped:[id],stopping:[id]},{stopped:[id,id],stopping:[]},{stopped:[],stopping:[]}]) {
    const text=await toastFor(transfer);
    assert.doesNotMatch(text,/stopped first/,JSON.stringify(transfer));
    assert.match(text,/the answer did not say whether the gem collector stopped$/,JSON.stringify(transfer));
  }
  // H2UI-R4-06: an accepted start means the collector released the emulator; the stopping list is what the handover saw
  const pending=await toastFor({stopped:[],stopping:[id],waited_sec:10});
  assert.match(pending,/ · the gem collector was still stopping at handover; the server waited 10 s for it to release the emulator$/);
  assert.doesNotMatch(pending,/is still stopping/);
  assert.match(await toastFor({stopped:[],stopping:[id]}),/the gem collector was still stopping at handover; the server waited for it to release the emulator$/);
  assert.match(await toastFor({stopped:[id],stopping:[],waited_sec:2.4}),/the gem collector stopped first \(2 s\)$/);
  assert.doesNotMatch(await toastFor(undefined),/collector/,'no handover: nothing is said about a collector');
  assert.doesNotMatch(await toastFor(null),/collector/);
});
test('stopping a tracked runner says harvesting is paused too when it is on', () => {
  const asked=[];
  const ctx=vm.createContext({S:{status:{harvest:on(),processes:[]}},confirm:m=>{asked.push(m);return false;}});
  vm.runInContext(section('async function killPid(','async function setAutomationAccess('),ctx);
  ctx.killPid(7,'op-c',2);ctx.S.status.harvest=harvest();ctx.killPid(7,'op-c',2);
  assert.match(asked[0],/Harvesting is paused too, so the collector is not started again\./);
  assert.doesNotMatch(asked[1],/Harvesting/);
});
/* ------------------------------------------------ round 3 (Astra r3) */
/* Status bodies after a Pause that named collector op-c (pid 4343): one
   well-formed complete Off read, and the same read with each malformed shape. */
/* A complete, fresh, explicitly empty read after a pause or turn-off (input revoked, as the server publishes it). */
const COMPLETE=()=>({processes:[],harvest:harvest({desired:{...harvest().desired,revision:5},input_revoked:true}),process_refresh:FRESH});
const SHAPES=[
  ['process {}',s=>{s.processes=[{}];}], ['process []',s=>{s.processes=[[]];}], ['process null',s=>{s.processes=[null];}],
  ['process pid as a numeric string',s=>{s.processes=[{pid:'9009',runner:'x'}];}], ['process pid 0',s=>{s.processes=[{pid:0}];}],
  ['process pid 1.5',s=>{s.processes=[{pid:1.5}];}], ['process operation as a string',s=>{s.processes=[{pid:9009,operation:'op-x'}];}],
  ['process operation {}',s=>{s.processes=[{pid:9009,operation:{}}];}], ['process operation id as a number',s=>{s.processes=[{pid:9009,operation:{id:42}}];}],
  ['process operation id empty',s=>{s.processes=[{pid:9009,operation:{id:''}}];}],
  ['processes as an object',s=>{s.processes={};}], ['processes absent',s=>{delete s.processes;}],
  ['harvest.operation {}',s=>{s.harvest.operation={};}], ['harvest.operation []',s=>{s.harvest.operation=[];}],
  ['harvest.operation a string',s=>{s.harvest.operation='op-c';}], ['harvest.operation id as a number',s=>{s.harvest.operation={id:42};}],
  ['harvest.operation absent',s=>{delete s.harvest.operation;}],
  ['harvest.owner {}',s=>{s.harvest.owner={};}], ['harvest.owner []',s=>{s.harvest.owner=[];}],
  ['harvest.owner without kind',s=>{s.harvest.owner={operation_id:'op-z'};}], ['harvest.owner operation without id',s=>{s.harvest.owner={kind:'operation'};}],
  ['harvest.owner operation id as a number',s=>{s.harvest.owner={kind:'operation',operation_id:5};}],
  ['harvest.owner process pid as a string',s=>{s.harvest.owner={kind:'process',pid:'9009'};}], ['harvest.owner unknown kind',s=>{s.harvest.owner={kind:'robot',pid:9009};}],
  ['harvest.owner absent',s=>{delete s.harvest.owner;}],
];
test('H2UI-R3-01: malformed ownership records are unknown in all three claims (Off stopped, tap-off stopped, recovery free)', async () => {
  const procs=[{pid:4343,runner:'gem_collector',operation:{id:'op-c',kind:'gems'}}];
  const offPage=async()=>{const p=page({status:{harvest:on({state:'collecting',operation:collector()}),processes:procs}});
    p.t.routes['POST /api/harvest']=[reply(200,{ok:true,replayed:false,desired:{revision:5},stop:{requested:true,stopped:[],stopping:['op-c'],errors:[]}})];
    await p.ctx.setHarvest(false);return p;};
  const accessPage=async()=>{const p=page({status:{harvest:on({state:'collecting',operation:collector()}),processes:procs}});
    p.t.routes['POST /api/automation-access']=[reply(200,{ok:true,enabled:false,revocation:{state:'stopping',fenced:true,latched:true,config_persisted:true,revoked_at:NOW,
      harvest:{paused:true,revision:5},stopped:[],stopping:['op-c'],errors:[],still_owned:[]}})];
    await p.ctx.setAutomationAccess(false,{});return p;};
  const recoveryPage=()=>{const p=page({status:{harvest:on({state:'collecting',operation:collector()}),processes:procs}});
    refuse(p,'/api/wizard/reconnect',{status:409,body:{ok:false,code:'device_owned',error:'Owned.',owner:{kind:'operation',operation_id:'op-c',operation_kind:'gems',pid:4343},
      recovery:{action:'pause_harvesting',operation_id:'op-c',expected_revision:2},retry:'after_confirmed_stop'}});return p;};
  const claims={
    pause:async status=>{const p=await offPage();p.laterRead(status);return /data-tone="ok">Paused; collector input stopped\./.test(p.gems());},
    access:async status=>{const p=await accessPage();p.laterRead(status);return /data-tone="ok"/.test(p.ctx.accessFeedbackHTML());},
    recovery:async status=>{const p=recoveryPage();p.laterRead(status);p.ctx.renderOwnerRefusal();return /The emulator is free now/.test(p.box.innerHTML);}};
  for (const [claim,check] of Object.entries(claims)) {
    assert.equal(await check(COMPLETE()),true,claim+': the complete explicit-empty read confirms');
    for (const [name,mutate] of SHAPES) { const s=COMPLETE();mutate(s);assert.equal(await check(s),false,claim+': '+name); }
    // controls: the same id still present in any representation keeps it unconfirmed
    for (const s of [{...COMPLETE(),processes:procs},{...COMPLETE(),harvest:harvest({desired:{...harvest().desired,revision:5},operation:{...collector(),id:'op-c'}})}])
      assert.equal(await check(s),false,claim+': same id present');
    // a well-formed numeric-string operation id is an id, compared exactly
    assert.equal(await check({...COMPLETE(),processes:[{pid:9009,operation:{id:'42',kind:'run'}}]}),claim==='pause' || claim==='access',claim+': unrelated id "42"');
  }
  // an untracked process is the stopped collector unless its PID is known to differ
  assert.equal(await claims.pause({...COMPLETE(),processes:[{pid:4343,runner:'gem_collector'}]}),false,'same PID without its operation link');
  assert.equal(await claims.pause({...COMPLETE(),processes:[{pid:9009,runner:'gem_collector'}]}),true,'a different PID (the collector\'s PID was known)');
  const unknownPid=page({status:{harvest:on({state:'collecting',operation:collector()}),processes:[]}});
  unknownPid.t.routes['POST /api/harvest']=[reply(200,{ok:true,desired:{revision:5},stop:{requested:true,stopped:[],stopping:['op-c'],errors:[]}})];
  await unknownPid.ctx.setHarvest(false);unknownPid.laterRead({...COMPLETE(),processes:[{pid:9009,runner:'gem_collector'}]});
  assert.doesNotMatch(unknownPid.gems(),/data-tone="ok">Paused; collector input stopped/,'collector PID unknown: an untracked process may be it');
});

test('H2UI-R3-01 (page-wide): a missing or malformed process list reads as an unknown scan in every row; drawing it never throws', async () => {
  const read=async processes=>{
    const body={harvest:harvest(),process_refresh:FRESH,setup_battle_guard:free,collection_guard:free};
    if (processes!==undefined) body.processes=processes;
    const ctx=vm.createContext({S:{config:config(),status:null},LearningStore,Date,api:async()=>clone(body),
      applyGate(){},renderBootStatus(){},renderHomeLive(){},renderWorkspaceStatus(){},refreshWorkspaceStatus(){}});
    vm.runInContext(section('async function loadStatus(){','/* Shared status reads'),ctx);
    await ctx.loadStatus();
    return ctx.S;
  };
  for (const [name,processes] of [['absent',undefined],['null',null],['object',{}],['string','none'],['null entry',[null]],['array entry',[[]]],
    ['number entry',[7]],['mixed',[{pid:4242,runner:'orchestrator'},null]],['empty record',[{}]],['no pid',[{runner:'orchestrator'}]],
    ['string pid',[{pid:'4242',runner:'orchestrator'}]],['zero pid',[{pid:0,runner:'orchestrator'}]],['fractional pid',[{pid:42.5,runner:'orchestrator'}]]]) {
    const S=await read(processes);
    assert.equal(S.statusError,'',name);
    assert.equal(S.status.process_refresh.state,'unknown',name);
    assert.match(S.status.process_refresh.error,/^The process list in this status was (missing|malformed)\.$/,name);
    assert.ok(Array.isArray(S.status.processes) && S.status.processes.every(p=>p && typeof p==='object' && !Array.isArray(p) && Number.isSafeInteger(p.pid) && p.pid>0),name);
    // every Dashboard consumer draws it as unknown, never as idle or free
    assert.deepEqual(DashboardView.automationFact({status:S.status}),{text:'Automation state unknown',tone:'warn'},name);
    assert.doesNotThrow(()=>DashboardView.activity({status:S.status,battleState:'none',runs:{}}),name);
    assert.ok(WorkspaceStatus.startBlockers({status:S.status,config:config()}).some(b=>b.id==='processes'),name);
    assert.equal(DashboardView.processScanFresh(S.status.process_refresh,S.status.harvest.server_time),false,name);
  }
  // a well-formed list is kept exactly as the server sent it
  const S=await read([{pid:4242,runner:'orchestrator'}]);
  assert.deepEqual([S.status.process_refresh,S.status.processes],[FRESH,[{pid:4242,runner:'orchestrator'}]]);
  assert.deepEqual(DashboardView.automationFact({status:S.status}),{text:'Automation running',tone:'ok'});
  assert.equal((await read([])).status.process_refresh.state,'fresh');
});

test('H2UI-R4-01: after an acknowledged Turn on, Pause stays offered and works for every status that does not currently read a newer Off', async () => {
  const PAUSE=/<button class="small" id="harvest-pause" onclick="setHarvest\(false\)"  title=/;
  const acked=async()=>{
    const p=page({status:{harvest:harvest()}});
    p.t.routes['POST /api/harvest']=[reply(200,{ok:true,replayed:false,desired:{...harvest().desired,choice:'on',enabled:true,revision:5},stop:{requested:false,stopped:[],stopping:[],errors:[]},overlay:null}),
      reply(200,{ok:true,replayed:false,desired:{...harvest().desired,revision:6},stop:{requested:true,stopped:[],stopping:[],errors:[]}})];
    await p.ctx.setHarvest(true);
    assert.match(p.gems(),/Turned on with Farm\./);
    return p;
  };
  const variants={
    'harvest null':p=>p.laterRead({harvest:null}),
    'harvest missing':p=>{p.laterRead({});delete p.ctx.S.status.harvest;},
    'version 2':p=>p.laterRead({harvest:{...harvest(),version:2}}),
    'status_failed':p=>p.laterRead({harvest:clone(fixture.status.status_failed)}),
    'state_unreadable':p=>p.laterRead({harvest:clone(fixture.status.state_unreadable)}),
    'desired null':p=>p.laterRead({harvest:harvest({desired:null})}),
    'read failed (last known Off)':p=>{p.ctx.S.statusError='HTTP 502';},
    'Off read before the answer':p=>{p.ctx.S.status.harvest=harvest();},                     // no read started after the acknowledgment
    'Off at the same revision (contradiction)':p=>p.laterRead({harvest:harvest({desired:{...harvest().desired,revision:5}})}),
    'Off at an older revision':p=>p.laterRead({harvest:harvest({desired:{...harvest().desired,revision:4}})}),
    'Off without a revision':p=>p.laterRead({harvest:harvest({desired:{...harvest().desired,revision:null}})}),
    'On':p=>p.laterRead({harvest:on({desired:{...on().desired,revision:5}})}),
  };
  for (const [name,mutate] of Object.entries(variants)) {
    const p=await acked();
    mutate(p);
    const out=p.gems();
    assert.match(out,PAUSE,name);
    assert.doesNotMatch(out,/id="harvest-on"/,name);
    // the button works: one revisionless Off bound to the context
    await p.ctx.setHarvest(false);
    assert.equal(p.posts().length,2,name);
    assert.deepEqual(Object.keys(p.posts()[1][2]).sort(),['enabled','expected_context','idempotency_key'],name);
    assert.equal(p.posts()[1][2].enabled,false,name);
  }
  // control: a current read with a newer Off is the only thing that hides Pause and brings Turn on back
  const p=await acked();
  p.laterRead({harvest:harvest({desired:{...harvest().desired,revision:6}})});
  assert.doesNotMatch(p.gems(),/id="harvest-pause"/);
  assert.match(p.gems(),/id="harvest-on" onclick="setHarvest\(true\)"/);
  // so does a newer "not turned on" (another device reset): unset at a newer revision
  const q=await acked();
  q.laterRead({harvest:harvest({desired:{...harvest().desired,choice:'unset',enabled:null,revision:7}})});
  assert.doesNotMatch(q.gems(),/id="harvest-pause"/);
  // an acknowledged Turn on in another context does not hold Pause here
  const r=await acked();
  r.ctx.S.harvestOn={...r.ctx.S.harvestOn,context:'another'};
  r.laterRead({harvest:harvest()});
  assert.doesNotMatch(r.gems(),/id="harvest-pause"/);
});

test('H2UI-R4-01: the last On a status showed keeps Pause until a later read shows a newer Off; the shared recovery says paused only then', async () => {
  const p=page({status:{harvest:harvest()},realStatus:true});
  const read=async harvestValue=>{const body={device_state:'device',processes:[],process_refresh:FRESH,setup_battle_guard:free,collection_guard:free};
    if (harvestValue!==undefined) body.harvest=harvestValue;
    p.t.routes['GET /api/status']=[reply(200,body)];await p.ctx.loadStatus();return p.gems();};
  assert.doesNotMatch(await read(harvest()),/id="harvest-pause"/,'a current Off with no known On');
  assert.match(await read(on({desired:{...on().desired,revision:8}})),/id="harvest-pause"/);
  for (const h of [null,undefined,{...harvest(),version:2},clone(fixture.status.status_failed),harvest({desired:{...harvest().desired,revision:7}}),harvest({desired:{...harvest().desired,revision:8}})])
    assert.match(await read(h),/id="harvest-pause"/,JSON.stringify(h)?.slice(0,60));
  assert.doesNotMatch(await read(harvest({desired:{...harvest().desired,revision:9}})),/id="harvest-pause"/,'a newer Off');
  // a read that failed after it is not current: Pause again, and the shared recovery does not claim "paused"
  p.t.routes['GET /api/status']=[reply(502,{ok:false,error:'bad gateway'})];await p.ctx.loadStatus();
  assert.ok(p.ctx.S.statusError);
  assert.match(p.gems(),/id="harvest-pause"/);
  p.ctx.S.ownerRefusal={action:'Reconnect',message:'Owned.',code:'device_owned',owner:{kind:'operation',operation_id:'op-c',operation_kind:'gems'},
    recovery:{action:'pause_harvesting',operation_id:'op-c',expected_revision:2},context:LearningStore.context(p.ctx.S.config).id,after:p.ctx.S.statusRequest};
  p.ctx.renderOwnerRefusal();
  assert.match(p.box.innerHTML,/onclick="setHarvest\(false\)" >Pause harvesting<\/button>/);
  assert.doesNotMatch(p.box.innerHTML,/Harvesting is paused/);
});

test('H2UI-R4-01 (input): turning game input off stays offered whenever input may be on or its state is unknown', async () => {
  const quiet={device_state:'device',processes:[],process_refresh:FRESH,harvest:harvest()};
  const reason=p=>p.ctx.accessOffReason();
  const start=(taps=false,status=quiet)=>{const p=page({status});p.ctx.S.config=config(taps);p.ctx.S.status=clone(status);return p;};
  // positively off: a current saved Off and nothing that could still send input
  assert.equal(reason(start()),'');
  assert.equal(reason(start(true)),'','the switch reads on: unticking it turns input off');
  // an acknowledged turn-on whose effect has not been read back (the re-read failed or has not run)
  let p=start();
  p.t.routes['POST /api/automation-access']=[reply(200,{ok:true,enabled:true})];
  await p.ctx.setAutomationAccess(true,{});
  assert.equal(reason(p),'a turn-on was accepted and the saved setting has not been read since');
  p.ctx.S.configReadError='HTTP 502';
  assert.equal(reason(p),'the latest read of the saved settings failed (HTTP 502)');
  // a later settings read decides: on (the switch turns it off) or off again
  p.ctx.S.configReadError='';p.ctx.S.configReadStarted=(p.ctx.S.configReadStarted || 0)+1;p.ctx.S.configSeq=p.ctx.S.configReadStarted;
  assert.equal(reason(p),'');
  p.ctx.S.config=config(true);assert.equal(reason(p),'');
  // a turn-on whose answer was lost: unresolved until its own answer; a confirmed turn-off does not resolve it (H2UI-R5-01)
  const LOST='an earlier turn-on was sent and has no answer, so it may still allow taps';
  p=start();
  p.t.routes['POST /api/automation-access']=['drop',reply(200,{ok:true,enabled:false,revocation:fixture.automation_access.disable_nothing_running.body.revocation})];
  await p.ctx.setAutomationAccess(true,{});
  assert.equal(reason(p),LOST);
  await p.ctx.setAutomationAccess(false,{});
  assert.deepEqual(p.posts().map(entry=>entry[2]),[{enabled:true},{enabled:false}]);
  assert.equal(reason(p),LOST);
  // a turn-on with no answer in the observation window: the late answer re-reads the saved setting
  p=start();const hold=held();
  p.t.routes['POST /api/automation-access']=[hold.step];
  const sending=p.ctx.setAutomationAccess(true,{});
  assert.equal(reason(p),'','while it is in flight the switch shows it and can be unticked');
  p.fire(15000);await sending;
  assert.equal(reason(p),LOST);
  const loads=p.calls.filter(c=>c==='loadHomeData').length;
  hold.release(reply(200,{ok:true,enabled:true}));await flush();await flush();
  assert.equal(p.calls.filter(c=>c==='loadHomeData').length,loads+1,'the late answer re-reads the saved setting');
  assert.equal(reason(p),'a turn-on was accepted and the saved setting has not been read since');
  // a refused turn-on changed nothing
  for (const answer of [fixture.automation_access.enable_during_action_lock,fixture.automation_access.enable_refused_owner]) {
    p=start();p.t.routes['POST /api/automation-access']=[reply(answer.status,answer.body)];
    await p.ctx.setAutomationAccess(true,{});
    assert.equal(reason(p),'',answer.body.code);
  }
  // no saved setting for this emulator, or a failed settings read
  p=start();p.ctx.S.config={active_instance:'main',active_profile:'alice',instances:{}};
  assert.equal(reason(p),'the saved input setting for this emulator was not read');
  p=start();p.ctx.S.configReadError='timed out';assert.match(reason(p),/^the latest read of the saved settings failed/);
  // automation that runs (or may) without input revoked for this emulator
  const procs=[{pid:4343,runner:'gem_collector',operation:{id:'op-c',kind:'gems'}}];
  assert.equal(reason(start(false,{...quiet,processes:procs})),'running automation is not reported cut off from input');
  assert.equal(reason(start(false,{...quiet,processes:procs,harvest:harvest({input_revoked:true})})),'');
  // (H2UI-R5-02) every status that cannot rule out a holder says why
  assert.equal(reason(start(false,{...quiet,process_refresh:{state:'stale',age_sec:30}})),'the process list is not confirmed fresh, and input is not reported revoked');
  assert.equal(reason(start(false,{...quiet,harvest:null,process_refresh:{state:'unknown'}})),"this server doesn't report whether automation input is revoked");
  assert.equal(reason(start(false,{...quiet,processes:undefined})),'the harvesting or process records are malformed, and input is not reported revoked');
  p=start();p.ctx.S.statusError='HTTP 502';
  assert.equal(reason(p),'whether automation is running is not known, and input is not reported revoked');
  p=start(false,{...quiet,harvest:harvest({input_revoked:true})});p.ctx.S.statusError='HTTP 502';
  assert.equal(reason(p),'whether automation is running is not known, and input is not reported revoked','a failed read is not current');
  // a turn-off on its way: the switch shows it
  p=start(false,{...quiet,processes:procs});p.ctx.S.accessPending={enabled:false,context:'x'};assert.equal(reason(p),'');
});

test('H2UI-R4-01 (input): the switch row offers "Turn input off" with its reason, once, beside a switch that reads off', () => {
  const procs=[{pid:7,runner:'gem_collector',operation:{id:'op-c',kind:'gems'}}];
  const OFF=/<p class="runner-access-unconfirmed" data-tone="warn">Input off is not confirmed: running automation is not reported cut off from input\.\s*<button class="small" id="automation-access-off" onclick="setAutomationAccess\(false\)"/;
  const p=runnerPage({device_state:'device',processes:procs,process_refresh:FRESH,harvest:harvest()},false);
  const out=p.html();
  assert.match(out,/id="automation-access"  disabled onchange=/);      // turning on still waits
  assert.match(out,OFF);
  assert.doesNotMatch(runnerPage({device_state:'device',processes:procs,process_refresh:FRESH,harvest:harvest({input_revoked:true})},false).html(),/automation-access-off/);
  assert.doesNotMatch(runnerPage({device_state:'device',processes:procs,process_refresh:FRESH,harvest:harvest()},true).html(),/automation-access-off/);
  // a failed turn-off already offers Try again: not repeated
  p.ctx.S.accessFeedback={context:LearningStore.context(config(false)).id,failed:'boom',revocation:null};
  const failed=p.html();
  assert.match(failed,/Try again/);
  assert.doesNotMatch(failed,/automation-access-off/);
  // dismissed: the reason and its button come back
  p.ctx.S.accessFeedback=null;
  assert.match(p.html(),OFF);
});

test('H2UI-R4-02: a tap-off answer naming an owner without a valid identity or input fact is incomplete, never green', async () => {
  const base=fixture.automation_access.disable_driver_input_refused.body, good=base.revocation.still_owned[0];
  const feedback=async still_owned=>{const p=page({status:{harvest:on(),processes:[]}});
    p.t.routes['POST /api/automation-access']=[reply(200,{...clone(base),revocation:{...clone(base.revocation),still_owned}})];
    await p.ctx.setAutomationAccess(false,{});return p.ctx.accessFeedbackHTML();};
  for (const [name,owners] of [['input only',[{input:'refused'}]],['negative PID',[{kind:'process',pid:-1,input:'refused'}]],
    ['numeric operation id',[{...good,operation_id:42}]],['empty operation id',[{...good,operation_id:''}]],['numeric-string PID',[{kind:'process',pid:'4242',input:'refused'}]],
    ['no kind',[{operation_id:good.operation_id,pid:good.pid,input:'refused'}]],['unknown kind',[{...good,kind:'thread'}]],['fractional PID',[{...good,pid:1.5}]],
    ['process with an operation id',[{kind:'process',pid:7,operation_id:'x',input:'refused'}]],['unknown input fact',[{...good,input:'maybe'}]],
    ['null entry',[null]],['array entry',[[]]],['empty record',[{}]],['one good, one malformed',[clone(good),{input:'refused'}]]]) {
    const out=await feedback(owners);
    assert.doesNotMatch(out,/data-tone="ok"|automation input stopped|keeps running without input/,name);
    assert.match(out,/data-tone="warn">Game input off: the answer was incomplete, so stopped input is not confirmed\./,name);
  }
  // controls: the published well-formed owner stays green; a missing input fact is an owner that may still tap
  assert.match(await feedback([clone(good)]),/data-tone="ok">Game input is off and automation input stopped\. The running automation keeps running without input/);
  const {input,...noInput}=good;
  assert.match(await feedback([noInput]),/data-tone="warn">Game input off was not enforced on the running automation, so it may still tap/);
});

test('H2UI-R4-03: Edit in Runs waits for a profile reload in any phase, even while the previous profile is still on screen', async () => {
  const early=async(profileBody,configBody=config(),target='shard_run',start)=>{
    const p=editPage();start?.(p);
    const cfg=held();p.t.routes['GET /api/config']=[cfg.step];
    p.t.routes['GET /api/profile-src/'+configBody.active_profile]=[reply(200,profileBody)];
    const loading=p.ctx.loadHomeData();
    assert.ok(p.ctx.S.profile,'the previous profile is still on screen');
    p.click(target);await flush();
    const during=[p.ctx.location.hash,[...p.opened]];
    cfg.release(reply(200,configBody));await loading.catch(()=>{});for(let i=0;i<6;i++)await flush();
    return {during,after:[p.ctx.location.hash,p.opened,p.selected.name],toasts:p.toasts()};
  };
  // the new profile no longer has the target: nothing opens, and it says so
  let r=await early({ok:true,profile:{blueprints:{coin_default:{}}},revision:'r3'});
  assert.deepEqual(r.during,['#overview',[]]);
  assert.deepEqual(r.after,['#overview',[],'coin_default']);
  assert.deepEqual(r.toasts,['shard_run is not a run in the active profile, so Runs was not opened.']);
  // the target exists only in the new profile: it opens once the reload settles
  r=await early({ok:true,profile:{blueprints:{coin_default:{},brand_new:{}}},revision:'r3'},config(),'brand_new');
  assert.deepEqual([r.during,r.after,r.toasts],[['#overview',[]],['#runs',['brand_new'],'brand_new'],[]]);
  // the reload switches profile: the click made for the old one opens nothing
  r=await early({ok:true,profile:{blueprints:{coin_default:{},shard_run:{}}},revision:'b1'},{...config(),active_profile:'bob'});
  assert.deepEqual(r.after,['#overview',[],'coin_default']);
  assert.match(r.toasts[0],/changed, so shard_run was not opened in Runs\./);
  // control: the unchanged target opens exactly, after the reload
  r=await early(PROFILE);
  assert.deepEqual([r.during,r.after,r.toasts],[['#overview',[]],['#runs',['shard_run'],'shard_run'],[]]);
  // a reload that never ends: after the bounded wait nothing opens against the previous profile
  const p=editPage();const cfg=held();p.t.routes['GET /api/config']=[cfg.step];
  p.ctx.loadHomeData();p.click('shard_run');await flush();
  const wait=p.fire(10000);await flush();await flush();
  assert.deepEqual([p.ctx.location.hash,p.opened],['#overview',[]]);
  assert.deepEqual(p.toasts(),['The active profile is not loaded, so shard_run was not opened in Runs; try again.']);
  // without a reload the previous profile resolves at once
  const q=editPage();q.click('shard_run');await flush();await flush();
  assert.deepEqual([q.ctx.location.hash,q.opened],['#runs',['shard_run']]);
});

test('H2UI-R4-04: a newer input turn-on or a contradicting current status makes an earlier green turn-off history', async () => {
  const off=async()=>{const p=page({status:{harvest:on(),processes:[]}});
    p.t.routes['POST /api/automation-access']=[reply(200,fixture.automation_access.disable_input_stopped.body)];
    await p.ctx.setAutomationAccess(false,{});
    p.laterRead({harvest:harvest({input_revoked:true}),processes:[],process_refresh:FRESH});
    assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off and automation input stopped\./);
    return p;};
  const HISTORY=/data-tone="warn">An earlier turn-off of game input is no longer current: a turn-on was requested after it\./;
  // Astra's sequence: a turn-on held while a current collecting status arrives
  let p=await off();const hold=held();
  p.t.routes['POST /api/automation-access']=[hold.step];
  const sending=p.ctx.setAutomationAccess(true,{});
  assert.match(p.ctx.accessFeedbackHTML(),HISTORY,'history as soon as the turn-on is sent');
  p.laterRead({harvest:clone(fixture.status.collecting),processes:[{pid:4343,runner:'gem_collector',operation:{id:fixture.status.collecting.operation.id,kind:'gems'}}]});
  assert.doesNotMatch(p.ctx.accessFeedbackHTML(),/data-tone="ok"/);
  hold.release(reply(200,fixture.automation_access.enable_ok.body));await sending;
  assert.doesNotMatch(p.ctx.accessFeedbackHTML(),/data-tone="ok"|automation input stopped/);
  // a refused turn-on: history while it was sent; its answer replaces the outcome (the switch shows the saved setting), never green again
  p=await off();const refused=held();p.t.routes['POST /api/automation-access']=[refused.step];
  const refusing=p.ctx.setAutomationAccess(true,{});
  assert.match(p.ctx.accessFeedbackHTML(),HISTORY);
  refused.release(reply(409,fixture.automation_access.enable_during_action_lock.body));await refusing;
  assert.doesNotMatch(p.ctx.accessFeedbackHTML(),/data-tone="ok"/);
  // without a turn-on: a current status that contradicts the green outcome makes it history
  const CONTRA=reason=>new RegExp('data-tone="warn">An earlier turn-off of game input is no longer confirmed in effect: '+reason);
  p=await off();p.laterRead({harvest:harvest({input_revoked:false})});
  assert.match(p.ctx.accessFeedbackHTML(),CONTRA('the latest status does not report game input revoked for this emulator\\.'));
  // (a status that does not say whether input is revoked but confirms collection)
  p=await off();const collectingNow=clone(fixture.status.collecting);delete collectingNow.input_revoked;p.laterRead({harvest:collectingNow});
  assert.match(p.ctx.accessFeedbackHTML(),CONTRA('the latest status shows the collector collecting\\.'));
  // controls: a failed read or a read started before the answer contradicts nothing; input revoked keeps it green
  p=await off();p.ctx.S.statusError='HTTP 502';p.ctx.S.status.harvest=harvest({input_revoked:false});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok"/);
  p=await off();p.laterRead({harvest:harvest({input_revoked:true,desired:{...harvest().desired,revision:9}})});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off and automation input stopped\./);
});

test('H2UI-R4-05: a collector or driver harvesting records but the process list does not show is never "idle" or free', () => {
  const unverified=clone(fixture.status.worker_unverified);
  assert.equal(unverified.operation.worker_alive,null);
  const status=h=>({processes:[],process_refresh:{state:'fresh',age_sec:0.1,last_success_at:h.server_time-0.1,error:null},harvest:h});
  assert.deepEqual(DashboardView.automationFact({status:status(unverified)}),{text:'Automation state unknown',tone:'warn'});
  assert.equal(DashboardView.activity({status:status(unverified),battleState:'none',runs:{}}).detail,'no tracked battle \u00b7 a diamond collector is recorded but its process is not listed');
  const ownedPreSpawn=on({state:'owned_by_driver',owner:clone(fixture.refusals.device_owned_pre_spawn.body.owner)});
  assert.deepEqual(DashboardView.automationFact({status:status(ownedPreSpawn)}),{text:'Automation state unknown',tone:'warn'});
  assert.match(DashboardView.activity({status:status(ownedPreSpawn),battleState:'none',runs:{}}).detail,/another driver is recorded as holding the emulator but is not listed/);
  assert.deepEqual(DashboardView.automationFact({status:status(unverified),error:'HTTP 502'}),{text:'Automation last known state unknown',tone:'warn'});
  // the Gems row says the same and keeps Pause
  const p=page({status:status(unverified)});
  assert.match(p.gems(),/On \u00b7 Collector state unknown[\s\S]*id="harvest-pause"/);
  // Start hands the emulator over, Collect waits; another recorded driver holds both
  let c=readyPage([],'on',unverified);
  assert.deepEqual([c['#start-run'].disabled,c['#start-gems'].disabled],[false,true]);
  assert.match(c['#run-ready'].innerHTML,/A gem collector is recorded as holding the emulator \(its process is not confirmed\)\. Start playing hands the emulator over/);
  assert.match(c['#run-ready'].innerHTML,/Collect diamonds only: a collector is recorded as holding the emulator\./);
  c=readyPage([],'on',ownedPreSpawn);
  assert.deepEqual([c['#start-run'].disabled,c['#start-gems'].disabled],[true,true]);
  assert.match(c['#run-ready'].innerHTML,/Another driver is recorded as holding the emulator; Start and Collect wait until it stops\./);
  // a status that omits harvesting is not evidence of idle, nor of "no gem collection running" (H2UI-R5-03)
  assert.deepEqual(DashboardView.activity({status:{processes:[],process_refresh:FRESH},battleState:'none',runs:{}}),
    {text:'Automation state unknown',tone:'warn',detail:"no tracked battle \u00b7 this server doesn't report its harvesting records"});
  // controls: a listed collector is running; nothing recorded and nothing listed is idle
  assert.deepEqual(DashboardView.automationFact({status:{...status(unverified),processes:[{pid:4343,runner:'gem_collector'}]}}),{text:'Automation running',tone:'ok'});
  assert.deepEqual(DashboardView.automationFact({status:status(clone(fixture.status.off))}),{text:'Automation idle',tone:'idle'});
  assert.match(readyPage([],'off')['#run-ready'].innerHTML,/^(?![\s\S]*recorded as holding)/);
});

/* ------------------------------------------------ round 6 (Astra r5) */
const STOP=fixture.stop_operation;
test('H2UI-R5-01: a confirmed turn-off never resolves an earlier turn-on that has no answer; only that turn-on\'s own answer does', async () => {
  const LOST='an earlier turn-on was sent and has no answer, so it may still allow taps';
  const NOT_GREEN=/data-tone="warn">Game input off was applied, but an earlier turn-on has no answer and may still reach the server and allow taps again, so input off is not fully confirmed\./;
  const quiet={device_state:'device',processes:[],process_refresh:FRESH,harvest:harvest({input_revoked:true})};
  const lostThenOff=async()=>{
    const p=page({status:clone(quiet)});p.ctx.S.config=config(false);
    const late=held();
    p.t.routes['POST /api/automation-access']=[late.step,reply(200,fixture.automation_access.disable_input_stopped.body)];
    const enabling=p.ctx.setAutomationAccess(true,{});
    p.fire(15000);await enabling;                                          // no answer within the window: unknown
    assert.equal(p.ctx.accessOffReason(),LOST);
    await p.ctx.setAutomationAccess(false,{});                              // Astra's step: Turn input off, confirmed
    return {p,late};
  };
  // Astra's sequence: the turn-off is confirmed and read back; the earlier turn-on can still land
  let {p,late}=await lostThenOff();
  assert.match(p.ctx.accessFeedbackHTML(),NOT_GREEN);
  assert.equal(p.ctx.accessOffReason(),LOST,'Turn input off stays offered');
  // reads after the turn-off that show input off do not resolve it: the backend publishes nothing that fences an earlier turn-on
  p.ctx.S.configReadStarted=(p.ctx.S.configReadStarted || 0)+1;p.ctx.S.configSeq=p.ctx.S.configReadStarted;
  p.laterRead({harvest:harvest({input_revoked:true})});
  assert.match(p.ctx.accessFeedbackHTML(),NOT_GREEN);
  assert.equal(p.ctx.accessOffReason(),LOST);
  // ...and when that turn-on lands on the server before the next read, nothing on screen claims input is off
  p.ctx.S.config=config(true);
  assert.doesNotMatch(p.ctx.accessFeedbackHTML(),/data-tone="ok"/);
  // its own answer resolves it: applied -> the next settings read decides (here: taps on, history)
  late.release(reply(200,fixture.automation_access.enable_ok.body));await flush();await flush();
  assert.notEqual(p.ctx.accessOffReason(),LOST);
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="warn">Game input is allowed now/);
  // a refusal resolves it too; the turn-off is then confirmed green
  ({p,late}=await lostThenOff());
  late.release(reply(409,fixture.automation_access.enable_during_action_lock.body));await flush();await flush();
  assert.equal(p.ctx.accessOffReason(),'');
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off and automation input stopped\./);
  // a lost connection (no HTTP status, no late answer) stays unresolved
  p=page({status:clone(quiet)});p.ctx.S.config=config(false);
  p.t.routes['POST /api/automation-access']=['drop','drop',reply(200,fixture.automation_access.disable_input_stopped.body)];
  await p.ctx.setAutomationAccess(true,{});await p.ctx.setAutomationAccess(true,{});
  assert.equal(p.ctx.S.accessEnables.filter(entry=>!entry.answered).length,2,'two lost turn-ons, each needs its own answer');
  await p.ctx.setAutomationAccess(false,{});
  assert.match(p.ctx.accessFeedbackHTML(),NOT_GREEN);
  // a turn-on sent in another emulator/account/profile does not hold this one
  p.ctx.S.accessEnables.forEach(entry=>{entry.context='another';});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off and automation input stopped\./);
  assert.equal(p.ctx.accessOffReason(),'');
  // control: a turn-off with no earlier turn-on is green at once
  p=page({status:clone(quiet)});p.ctx.S.config=config(false);
  p.t.routes['POST /api/automation-access']=[reply(200,fixture.automation_access.disable_input_stopped.body)];
  await p.ctx.setAutomationAccess(false,{});
  assert.match(p.ctx.accessFeedbackHTML(),/data-tone="ok">Game input is off and automation input stopped\./);
});

test('H2UI-R5-02: turning input off stays offered whenever a holder may be running and input is not reported revoked, even with taps saved off', () => {
  const fresh=h=>({state:'fresh',age_sec:0.1,last_success_at:h.server_time-0.1,error:null});
  const reason=(h,{taps=false,processes=[],cfg}={})=>{const p=page({status:{processes,process_refresh:h && typeof h==='object' && Number.isFinite(h.server_time) ? fresh(h) : FRESH,harvest:h}});
    p.ctx.S.config=cfg || config(taps);return p.ctx.accessOffReason();};
  const unverified=clone(fixture.status.worker_unverified);unverified.input_revoked=false;
  // Astra's case: the published worker_unverified sample, an empty process list, taps saved off, input not revoked
  assert.equal(reason(unverified),'a diamond collector is recorded but its process is not listed, and input is not reported revoked');
  assert.equal(reason({...unverified,input_revoked:true}),'','input revoked: the switch alone is enough');
  assert.equal(reason(on({state:'owned_by_driver',owner:clone(fixture.refusals.device_owned_pre_spawn.body.owner)})),'another driver is recorded as holding the emulator, and input is not reported revoked');
  assert.equal(reason(undefined),"this server doesn't report whether automation input is revoked");
  assert.equal(reason(null),"this server doesn't report whether automation input is revoked");
  assert.equal(reason({...harvest(),version:2}),"this page can't read whether this server has automation input revoked");
  assert.equal(reason(clone(fixture.status.status_failed)),'the harvesting records could not be read, and input is not reported revoked');
  assert.equal(reason(harvest({desired:{...harvest().desired,revision:5.5}})),'the harvesting records could not be read, and input is not reported revoked');
  // a saved setting that does not say whether taps are allowed is unknown, never "off"
  const cfg=config(false);delete cfg.instances.main.allow_taps;
  assert.equal(reason(harvest(),{cfg}),'the saved settings do not say whether taps are allowed for this emulator');
  // control: readable records, nothing recorded or listed, a scan that agrees, taps off: nothing can still tap
  assert.equal(reason(clone(fixture.status.off)),'');
  // the row shows the reason and its control beside the unchecked switch
  const r=runnerPage({device_state:'device',processes:[],process_refresh:fresh(unverified),harvest:unverified},false);
  const out=r.html();
  assert.match(out,/id="automation-access"  disabled onchange=/);
  assert.match(out,/<p class="runner-access-unconfirmed" data-tone="warn">Input off is not confirmed: a diamond collector is recorded but its process is not listed, and input is not reported revoked\.\s*<button class="small" id="automation-access-off" onclick="setAutomationAccess\(false\)"/);
  // the server that does not report harvesting: a calm warning line with the same control
  assert.match(runnerPage({device_state:'device',processes:[],process_refresh:FRESH},false).html(),/data-tone="warn">Input off is not confirmed: this server doesn't report whether automation input is revoked\./);
});

test('H2UI-R5-03: every published status sample with an empty process list reads idle only when nothing is recorded and the records are readable', () => {
  for (const [name,h] of Object.entries(fixture.status)) {
    const status={processes:[],process_refresh:{state:'fresh',age_sec:0.1,last_success_at:h.server_time-0.1,error:null},harvest:clone(h)};
    const fact=DashboardView.automationFact({status});
    const idle=DashboardView.harvestReadable(h) && h.operation===null && h.owner===null;
    assert.equal(fact.text,idle ? 'Automation idle' : 'Automation state unknown',name);
    assert.doesNotMatch(DashboardView.activity({status,battleState:'none',runs:{}}).detail,/no gem collection running/,name);
  }
});

test('H2UI-R5-04: every stop answer is restated without promotion; the contract shape is required', () => {
  const C=STOP.cancel, view=name=>DashboardView.stopResultView(C[name].body,C[name].body.operation.id,{});
  const expect={
    stopped:['ok',false,false,/^Stopped: its verified worker family exited, nothing held the emulator, and the operation is cancelled\.$/],
    stopped_family:['ok',false,false,/^Stopped: its verified worker family exited, nothing held the emulator, and the operation is cancelled\.$/],
    released:['idle',false,false,/^Closed without signalling any process: its worker could never be verified and nothing held the emulator\.$/],
    ended:['idle',false,false,/^It ended on its own or another writer settled it; this Stop signalled no process\.$/],
    ended_after_termination:['idle',false,false,/^This Stop stopped the worker; another writer settled the operation\.$/],
    stopping:['warn',true,false,/^Stop sent; its worker is still exiting, so it is not stopped yet\.$/],
    unverified_lease_free:['warn',true,false,/^Its worker cannot be verified, so no process was signalled and it stays stopping\. Nothing held the emulator when this was checked; Stop again to release it\.$/],
    unverified_lease_held:['warn',true,true,/^Its worker cannot be verified, so no process was signalled and it stays stopping, and an unidentified automation process from another installation holds the emulator\. End that process, or turn game input off\.$/],
    unverified_lease_held_after_stop:['warn',true,true,/^Its worker is gone, but an unidentified automation process from another installation still holds the emulator, so the operation stays stopping\. End that process, or turn game input off\.$/],
    unverified_lease_unreadable:['warn',true,true,/^Its worker cannot be verified, so no process was signalled and it stays stopping, and who holds the emulator could not be read\. End the worker process if you can, or turn game input off\.$/],
    unverified_lease_unreadable_after_stop:['warn',true,true,/^Its worker is gone, but who holds the emulator could not be read, so the operation stays stopping\. Turn game input off, read its current state, then Stop again\.$/]};
  // every published cancel answer has an expectation here: a new sample fails until it is handled
  assert.deepEqual(Object.keys(C).sort(),Object.keys(expect).sort());
  for (const [name,[tone,again,inputOff,text]] of Object.entries(expect)) {
    const v=view(name);
    assert.deepEqual([v.state,v.tone,v.again,v.inputOff,v.revision],[C[name].body.stop.state,tone,again,inputOff,C[name].body.operation.revision],name);
    assert.match(v.text,text,name);
  }
  const conflicts={
    not_cancellable:['refused','bad',false,/^Stop refused: nothing was applied \(Synchronous profile persistence cannot be cancelled\)\. Read its current state, then Stop again\.$/],
    operation_changed:['refused','bad',false,/^Stop refused: nothing was applied \(Operation changed; refresh its status before trying again\)\. Read its current state, then Stop again\.$/],
    operation_required:['refused','bad',false,/^Stop refused: nothing was applied \(operation_id and expected_revision are required\)\. Read its current state, then Stop again\.$/],
    operation_unknown:['refused','bad',false,/^Stop refused: nothing was applied \(Unknown operation\)\. Read its current state, then Stop again\.$/],
    stop_outcome_partial:['partial','warn',true,/^Stop partly done: harvesting was paused\. Nothing more will be sent automatically\. Read its current state, then Stop again\.$/]};
  assert.deepEqual(Object.keys(STOP.conflicts).sort(),Object.keys(conflicts).sort());
  for (const [name,[state,tone,inputOff,text]] of Object.entries(conflicts)) {
    const answer=STOP.conflicts[name].body,v=DashboardView.stopResultView(answer,answer.operation?.id,{});
    assert.deepEqual([v.state,v.tone,v.again,v.inputOff,v.revision],[state,tone,true,inputOff,answer.operation?.revision ?? null],name);
    assert.match(v.text,text,name);
  }
  // malformed or contradictory answers are unknown, never stopped or released
  const ok=C.stopped.body, released=C.released.body, held_=C.unverified_lease_held.body;
  const bad=[null,{},{...ok,ok:false},{...ok,stop:null},{...ok,stop:{state:'gone'}},{...ok,operation:null},{...ok,operation:{...ok.operation,revision:4.5}},
    {...ok,operation:{...ok.operation,id:'another'}},{...ok,operation:{...ok.operation,status:'cancelling'}},{...ok,stop:{...ok.stop,reason:'worker_not_verifiable_lease_free'}},
    {...released,operation:{...released.operation,error:null}},{...C.ended.body,operation:{...C.ended.body.operation,error:{code:'worker_released'}}},
    {...held_,stop:{...held_.stop,reason:'something_else'}},{...held_,stop:{...held_.stop,holder:[]}},{...C.unverified_lease_free.body,stop:{...C.unverified_lease_free.body.stop,holder:{kind:'process'}}},
    {...C.stopping.body,operation:{...C.stopping.body.operation,status:'running'}},
    {...ok,stop:{...ok.stop,by_this_request:undefined}},{...ok,stop:{...ok.stop,by_this_request:null}},
    ...[{paused:null},{requested:1},{released:'false'},{signalled:null},{signalled:[0]},{signalled:['4242']},{family:'unknown'},{family:null},{family:'stopping'},{family:'unverified'}]
      .map(effects=>({...ok,stop:{...ok.stop,by_this_request:{...ok.stop.by_this_request,...effects}}})),
    {...released,stop:{...released.stop,by_this_request:{...ok.stop.by_this_request,released:true}}},
    {...ok,stop:{...ok.stop,by_this_request:{...ok.stop.by_this_request,released:true}}},
    {...ok,operation:{...ok.operation,revision:-1}},{...ok,stop:{...ok.stop,state:'toString'}},
    {...STOP.conflicts.operation_changed.body,stop:ok.stop},
    {...STOP.conflicts.operation_unknown.body,code:'something_else'},
    {...STOP.conflicts.stop_outcome_partial.body,stop:{...STOP.conflicts.stop_outcome_partial.body.stop,by_this_request:{...C.ended.body.stop.by_this_request,requested:false}}},
    ...['stopping','unverified'].map(family=>({...C.ended_after_termination.body,stop:{...C.ended_after_termination.body.stop,
      by_this_request:{...C.ended_after_termination.body.stop.by_this_request,family}}})),
    {...STOP.conflicts.stop_outcome_partial.body,stop:{...STOP.conflicts.stop_outcome_partial.body.stop,
      by_this_request:{...ok.stop.by_this_request,released:true,family:'stopping'}}},
    ...['unverified_lease_held_after_stop','unverified_lease_unreadable_after_stop'].flatMap(name=>['stopping','unverified'].map(family=>
      ({...C[name].body,stop:{...C[name].body.stop,by_this_request:{...C[name].body.stop.by_this_request,family}}}))),
    {...STOP.conflicts.stop_outcome_partial.body,stop:{...STOP.conflicts.stop_outcome_partial.body.stop,
      by_this_request:{...STOP.conflicts.stop_outcome_partial.body.stop.by_this_request,released:true,family:'stopping'}}}];
  for (const answer of bad) {
    const v=DashboardView.stopResultView(answer,answer?.operation?.id === 'another' ? ok.operation.id : answer?.operation?.id,{});
    assert.deepEqual([v.state,v.tone,v.again,v.inputOff],['unknown','warn',true,true],JSON.stringify(answer).slice(0,120));
  }
  // a lease holder the server does not name is "another process"
  assert.match(DashboardView.stopResultView({...held_,stop:{...held_.stop,holder:null}},held_.operation.id).text,/and another process holds the emulator/);
});

test('H2UI-R5-04: a collector or operation that is recorded but not listed always has a working Stop; Stop again names the newest revision, never resent', async () => {
  const recorded=(h,taps=false)=>runnerPage({device_state:'device',processes:[],process_refresh:{state:'fresh',age_sec:0.1,last_success_at:h.server_time-0.1,error:null},harvest:h},taps);
  const stopRow=/<div class="flowcard runner-process runner-recorded"><div class="runner-process-name"><b>Diamond collector<\/b> <span class="muted">· ([^<]*)<\/span><\/div>\s*<button class="small danger" title="Stops this operation\. The game battle keeps playing\." data-operation-id="([^"]+)" data-operation-revision="(\d+)"/;
  // Astra's cases: desired Off, the collector retained stopping or unverifiable, input already revoked
  for (const [name,why] of [['stopping','stopping; its worker is not confirmed gone'],['worker_unverified','its worker cannot be checked from here']]) {
    const h=clone(fixture.status[name]);h.desired={...clone(fixture.status.off.desired),revision:h.desired.revision+1};h.input_revoked=true;
    const m=stopRow.exec(recorded(h).html());
    assert.ok(m,name);
    assert.deepEqual([m[1],m[2],Number(m[3])],[why,h.operation.id,h.operation.revision],name);
    // the Gems row points at it
    const p=page({status:{processes:[],process_refresh:{state:'fresh',age_sec:0.1,last_success_at:h.server_time-0.1,error:null},harvest:h}});
    assert.match(p.gems(),/Its collector is still recorded \([^)]*\); use its Stop in the Now row above\./,name);
  }
  // listed collectors keep their Stop now in the process row, not a second one
  const listed=clone(fixture.status.stopping);
  assert.doesNotMatch(runnerPage({device_state:'device',processes:[{pid:4343,runner:'gem_collector',operation:{id:listed.operation.id,revision:3,kind:'gems'}}],harvest:listed}).html(),/runner-recorded/);
  // every repeat route reply through the one sender; after_release is a later read, not a Stop reply
  const repeatExpect={
    held_after_stop_then_the_survivor_leaves:{
      first:['warn',true,true,/Its worker is gone, but .* still holds the emulator, so the operation stays stopping\./],
      still_held:['warn',true,true,/Its worker is gone, but .* still holds the emulator, so the operation stays stopping\./],
      stale_stop:['bad',true,false,/Stop refused: nothing was applied \(/]},
    stopping_then_stopped:{first:['warn',true,false,/Stop sent; its worker is still exiting/],second:['ok',false,false,/Stopped: its verified worker family exited, nothing held the emulator/]},
    unverified_then_released:{first:['warn',true,true,/Its worker cannot be verified, so no process was signalled/],second:['idle',false,false,/Closed without signalling any process/]}};
  assert.deepEqual(Object.keys(STOP.repeat).sort(),Object.keys(repeatExpect).sort());
  for (const [name,seq] of Object.entries(STOP.repeat)) {
    const expected=repeatExpect[name],id=seq.first.body.operation.id;
    assert.deepEqual(Object.keys(seq).filter(key=>key!=='after_release').sort(),Object.keys(expected).sort(),name);
    const p=page({status:{processes:[],harvest:harvest({operation:{...seq.first.body.operation,revision:2}})}});
    vm.runInContext(section('async function killPid(','async function setAutomationAccess('),p.ctx);
    p.t.routes['POST /api/operations/'+encodeURIComponent(id)+'/cancel']=Object.keys(expected).map(step=>reply(seq[step].status,seq[step].body));
    let revision=2;const sent=[];
    for (const [step,[tone,again,inputOff,text]] of Object.entries(expected)) {
      if (step==='stale_stop') {
        assert.equal(seq.after_release.status,'interrupted');assert.equal(seq.after_release.stop.state,'ended');
        p.laterRead({harvest:harvest({operation:{...seq[step].body.operation,...seq.after_release}})});
        revision=seq[step].body.operation.revision;
        assert.match(p.ctx.stopFeedbackHTML(),new RegExp(`data-stop-again="${id}" data-operation-revision="${revision}"`));
        assert.equal(p.posts().length,sent.length,'a read sends no further Stop');
      }
      sent.push(revision);
      await p.ctx.stopOperation(id,revision,{name:'Diamond collector'});
      const notes=p.ctx.stopFeedbackHTML();revision=seq[step].body.operation.revision;
      assert.match(notes,new RegExp(`data-tone="${tone}"><b>Diamond collector:</b>`),name+': '+step);
      assert.match(notes,text,name+': '+step);
      assert.equal(/data-stop-again/.test(notes),again,name+': '+step);
      assert.equal(/onclick="setAutomationAccess\(false\)">Turn game input off<\/button>/.test(notes),inputOff,name+': '+step);
      if (again) assert.match(notes,new RegExp(`data-stop-again="${id}" data-operation-revision="${revision}"`),name+': newest reply beats stale status');
      assert.deepEqual(p.posts().map(([, , body])=>body.expected_revision),sent,name+': one request per click, never resent');
    }
  }
  // every coded 409 travels through the real transport; partial is never called a refusal
  const conflictExpect={not_cancellable:['bad',false,/Stop refused: nothing was applied \(/],operation_changed:['bad',false,/Stop refused: nothing was applied \(/],
    operation_required:['bad',false,/Stop refused: nothing was applied \(/],operation_unknown:['bad',false,/Stop refused: nothing was applied \(/],
    stop_outcome_partial:['warn',true,/Stop partly done: harvesting was paused\. Nothing more will be sent automatically\. Read its current state, then Stop again\./]};
  assert.deepEqual(Object.keys(STOP.conflicts).sort(),Object.keys(conflictExpect).sort());
  for (const [name,[tone,inputOff,text]] of Object.entries(conflictExpect)) {
    const sample=STOP.conflicts[name],id=sample.body.operation?.id || 'op-x';
    const p=page({status:{processes:[],harvest:harvest()}});
    vm.runInContext(section('async function killPid(','async function setAutomationAccess('),p.ctx);
    p.t.routes['POST /api/operations/'+id+'/cancel']=[reply(sample.status,sample.body)];
    await p.ctx.stopOperation(id,2,{name:'Diamond collector'});
    const notes=p.ctx.stopFeedbackHTML();
    assert.match(notes,new RegExp(`data-tone="${tone}"><b>Diamond collector:</b>`),name);assert.match(notes,text,name);
    assert.match(notes,/data-stop-again/,name);
    assert.equal(/>Turn game input off<\/button>/.test(notes),inputOff,name);
    if (name==='stop_outcome_partial') assert.doesNotMatch(notes,/Stop refused|nothing was applied/i);
    assert.equal(p.posts().length,1,name+': nothing is resent');
    assert.ok(p.calls.includes('loadStatus'),name+': current state is read');
  }
  // lost and unrecognized answers are unknown; neither is resent; a missing revision sends nothing
  const p=page({status:{processes:[],harvest:harvest()}});
  vm.runInContext(section('async function killPid(','async function setAutomationAccess('),p.ctx);
  p.t.routes['POST /api/operations/op-x/cancel']=['drop',reply(409,{ok:false,error:'Operation revision changed'})];
  await p.ctx.stopOperation('op-x',3,{name:'Run'});
  assert.match(p.ctx.stopFeedbackHTML(),/data-tone="warn"><b>Run:<\/b> The stop's answer did not arrive \(Failed to fetch\), so whether it stopped is unknown\./);
  await p.ctx.stopOperation('op-x',3,{name:'Run'});
  assert.match(p.ctx.stopFeedbackHTML(),/data-tone="warn"><b>Run:<\/b> The answer did not say how the stop stands, so it is not confirmed\./);
  assert.match(p.ctx.stopFeedbackHTML(),/>Stop again<\/button>/);assert.match(p.ctx.stopFeedbackHTML(),/>Turn game input off<\/button>/);
  await p.ctx.stopOperation('op-x',NaN,{name:'Run'});
  assert.equal(p.posts().length,2);
  assert.match(p.ctx.stopFeedbackHTML(),/Its revision is not known here, so no stop was sent/);
});

test('Stop now on an untracked runner sends the exact row identity and restates every kill answer; a row without a start time cannot be killed', async () => {
  const rows=STOP.processes, withCreated=rows.find(row=>Number.isFinite(row.created)), without=rows.find(row=>row.created===null);
  const out=runnerPage({device_state:'device',processes:clone(rows),process_refresh:FRESH,harvest:harvest()}).html();
  assert.match(out,new RegExp(`data-pid="${withCreated.pid}" data-created="${String(withCreated.created).replace('.','\\.')}" onclick="killRunner\\(this\\)">Stop now</button>`));
  assert.match(out,/<button class="small danger" disabled title="Its start time is not known, so it cannot be stopped by its identity\.">Stop now<\/button>\s*<p class="runner-process-note">Its start time is not known, so Stop now cannot be sure it stops this runner\. <button class="small ghost" onclick="setAutomationAccess\(false\)">Turn game input off<\/button>/);
  assert.doesNotMatch(out,new RegExp(`data-pid="${without.pid}" data-created`));
  const kill=async answer=>{const p=page({status:{processes:clone(rows),harvest:harvest()}});
    vm.runInContext(section('async function killPid(','async function setAutomationAccess('),p.ctx);
    p.t.routes['POST /api/control']=[answer==='drop' ? 'drop' : reply(answer.status,answer.body)];
    await p.ctx.killRunner({dataset:{pid:String(withCreated.pid),created:String(withCreated.created)}});
    assert.deepEqual(p.posts().map(([, , body])=>body),[{action:'kill',pid:withCreated.pid,created:withCreated.created}]);
    return p.calls.filter(c=>c[0]==='toast').map(c=>[c[1],c[2]]);};
  const K=STOP.kill;
  const expect={stopped:[`That runner (PID ${withCreated.pid}) is no longer running.`,false],gone:[`That runner (PID ${withCreated.pid}) is no longer running.`,false],
    pid_passed_to_another_runner:[K.pid_passed_to_another_runner.body.error,true],created_missing:[K.created_missing.body.error,true],
    not_a_runner:[`PID ${withCreated.pid} is no longer listed as a runner, so nothing was stopped.`,true],invalid_request:[K.invalid_request.body.error,true]};
  assert.deepEqual(Object.keys(K).sort(),Object.keys(expect).sort());
  for (const [name,toast] of Object.entries(expect)) {
    const toasts=await kill(K[name]);
    assert.deepEqual(toasts,[toast],name);
    assert.doesNotMatch(toasts[0][0],/\bkilled\b|\bstopped it\b/,name);
  }
  assert.deepEqual(await kill(reply(500,{ok:false,error:`pid ${withCreated.pid} would not die`})),[[`pid ${withCreated.pid} would not die It may still be running.`,true]]);
  assert.match((await kill('drop'))[0][0],/^The stop's answer did not arrive \(Failed to fetch\), so whether PID \d+ stopped is unknown/);
  // nothing is sent without a start time
  const p=page({status:{processes:clone(rows),harvest:harvest()}});
  vm.runInContext(section('async function killPid(','async function setAutomationAccess('),p.ctx);
  for (const created of [undefined,'','null','NaN']) await p.ctx.killRunner({dataset:{pid:String(without.pid),...(created===undefined ? {} : {created})}});
  assert.deepEqual(p.posts(),[]);
});

test('classic.html Stop sends the exact row identity and restates every kill answer truthfully', async () => {
  const classic=fs.readFileSync(path.join(__dirname,'../webui/classic.html'),'utf8');
  const cut=(start,end)=>{const a=classic.indexOf(start),b=classic.indexOf(end,a);assert.ok(a>=0 && b>a,start);return classic.slice(a,b);};
  const rows=STOP.processes, withCreated=rows.find(row=>Number.isFinite(row.created));
  // the row markup carries pid and created; a row without created is disabled
  const render=cut('    const rows = st.processes.map(p =>','    $("#procs").innerHTML');
  const ctx=vm.createContext({st:{processes:clone(rows)}});vm.runInContext(render.replace('const rows','var rows'),ctx);
  assert.match(ctx.rows[0],new RegExp(`data-pid="${withCreated.pid}" data-created="${String(withCreated.created).replace('.','\\.')}" onclick="kill\\(this\\)">kill</button>`));
  assert.match(ctx.rows[1],/<button class="danger" disabled title="Its start time is not known/);
  const killFn=cut('async function kill(btn) {','function control(action)');
  const run=async answer=>{const alerts=[],sent=[];let refreshed=0;
    const c=vm.createContext({alert:m=>alerts.push(m),confirm:()=>true,refreshSoon:()=>{refreshed++;},JSON,Number,
      fetch:async(url,opts)=>{sent.push(JSON.parse(opts.body));if(answer==='drop')throw new TypeError('Failed to fetch');return {ok:answer.status<400,status:answer.status,json:async()=>clone(answer.body)};}});
    vm.runInContext(killFn,c);
    const btn={dataset:{pid:String(withCreated.pid),created:String(withCreated.created)},disabled:false,textContent:'kill'};
    await c.kill(btn);
    return {alerts,sent,refreshed,btn};};
  const K=STOP.kill;
  let r=await run(K.gone);
  assert.deepEqual(JSON.parse(JSON.stringify(r.sent)),[{action:'kill',pid:withCreated.pid,created:withCreated.created}]);
  assert.deepEqual([r.alerts,r.btn.textContent,r.refreshed],[[],'no longer running',1]);
  r=await run(K.pid_passed_to_another_runner);assert.deepEqual(r.alerts,[K.pid_passed_to_another_runner.body.error]);
  r=await run(K.not_a_runner);assert.deepEqual(r.alerts,[`Runner ${withCreated.pid} is no longer listed as a runner, so nothing was stopped.`]);
  r=await run({status:500,body:{ok:false,error:'pid would not die'}});assert.deepEqual(r.alerts,['pid would not die It may still be running.']);
  r=await run('drop');assert.match(r.alerts[0],/^The stop's answer did not arrive, so whether runner \d+ stopped is unknown/);
  // no start time: nothing is sent
  const c=vm.createContext({alert:()=>{},confirm:()=>true,refreshSoon:()=>{},fetch:async()=>{throw new Error('sent');},JSON,Number});vm.runInContext(killFn,c);
  await c.kill({dataset:{pid:'910002'}});
});

test('H2UI-R5-05: a known On makes an older or equal Off "not confirmed" in the fact, and only a valid, newer Off hides Pause', async () => {
  const acked=async()=>{const p=page({status:{harvest:harvest()}});
    p.t.routes['POST /api/harvest']=[reply(200,{ok:true,replayed:false,desired:{...harvest().desired,choice:'on',enabled:true,revision:5},stop:{requested:false,stopped:[],stopping:[],errors:[]},overlay:null})];
    await p.ctx.setHarvest(true);return p;};
  for (const revision of [4,5]) {
    const p=await acked();p.laterRead({harvest:harvest({desired:{...harvest().desired,revision}})});
    const out=p.gems();
    assert.match(out,/data-tone="warn"><span class="dashboard-dot" aria-hidden="true"><\/span>Choice not confirmed \(this status reads Off, but a later On was recorded here\)<span class="dashboard-fact-detail"> · paused /,String(revision));
    assert.doesNotMatch(out,/>Off<span class="dashboard-fact-detail"> · paused/,String(revision));
    assert.match(out,/id="harvest-pause"/);
  }
  // malformed newer Off records: unreadable, Pause stays, no Turn on
  for (const desired of [{revision:5.5},{revision:6,enabled:true},{revision:6,enabled:null},{revision:-1},{revision:'6'},{revision:6,choice:'paused'}]) {
    const p=await acked();p.laterRead({harvest:harvest({desired:{...harvest().desired,...desired}})});
    const out=p.gems();
    assert.match(out,/Choice unknown/,JSON.stringify(desired));
    assert.match(out,/id="harvest-pause"/,JSON.stringify(desired));
    assert.doesNotMatch(out,/id="harvest-on"/,JSON.stringify(desired));
  }
  // the observed state stays stated beside the qualified choice
  const q=await acked();q.laterRead({harvest:harvest({desired:{...harvest().desired,revision:5},state:'collecting',operation:collector()})});
  assert.match(q.gems(),/Choice not confirmed \(this status reads Off, but a later On was recorded here\) · Collecting gems in the battle on screen/);
  // control: a valid integer revision 6 Off
  const p=await acked();p.laterRead({harvest:harvest({desired:{...harvest().desired,revision:6}})});
  assert.match(p.gems(),/>Off<span class="dashboard-fact-detail"> · paused[\s\S]*id="harvest-on"/);
  assert.doesNotMatch(p.gems(),/id="harvest-pause"/);
  // every published sample's desired record is in its contract shape (status_failed has none)
  for (const [name,h] of Object.entries(fixture.status)) assert.equal(DashboardView.desiredValid(h.desired),h.desired!==null,name);
});

test('H2UI-R5-06: Collecting needs a publication the server marked valid, bound to one battle generation', () => {
  const c=fixture.status.collecting;
  const collecting=mutate=>{const h=clone(c);mutate(h);return /Collecting gems/.test(DashboardView.harvestView({harvest:h,now:h.server_time}).headline);};
  assert.equal(collecting(()=>{}),true);
  for (const [name,mutate] of Object.entries({'publication_valid false':h=>{h.operation.battle.publication_valid=false;},'publication_valid missing':h=>{delete h.operation.battle.publication_valid;},
    'battle id an object':h=>{h.operation.battle.id={};},'battle id missing':h=>{delete h.operation.battle.id;},'battle generation missing':h=>{delete h.operation.battle.generation;},
    'evidence for another generation':h=>{h.operation.evidence.generation='g2';},'battle generation a number':h=>{h.operation.battle.generation=1;h.operation.evidence.generation=1;}}))
    assert.equal(collecting(mutate),false,name);
  // evidence that names no generation does not contradict the battle
  assert.equal(collecting(h=>{delete h.operation.evidence.generation;}),true);
  assert.equal(collecting(h=>{h.operation.evidence=null;}),true);
});

test('H2UI-R5-07: focus returns to the control that took the same role, never to a look-alike control elsewhere', () => {
  const ctx=vm.createContext({});
  vm.runInContext(section('const FOCUS_ROLES','function renderHarvest('),ctx);
  vm.runInContext(section('function restoreRunnerFocus(','function renderRunReady('),ctx);
  const control=(id,tag,text)=>({id,tagName:tag,textContent:text,disabled:false,focused:0,focus(){this.focused++;}});
  const body=controls=>({querySelectorAll:()=>controls});
  const startPreset=control('start-preset','SELECT','FarmShard'), pause=control('harvest-pause','BUTTON','Pause harvesting'), source=control('harvest-source','SELECT','FarmShard');
  // the focused Gems picker is replaced by Pause after a failed read: Pause, not the Next start picker that lists the same runs
  ctx.restoreRunnerFocus(body([pause,startPreset]),{id:'harvest-source',tag:'SELECT',text:'FarmShard',index:1});
  assert.deepEqual([pause.focused,startPreset.focused],[1,0]);
  // the read recovers: the picker takes Pause's place again
  ctx.restoreRunnerFocus(body([source,startPreset]),{id:'harvest-pause',tag:'BUTTON',text:'Pause harvesting',index:0});
  assert.deepEqual([source.focused,startPreset.focused],[1,0]);
  // the input switch and Turn input off share a role
  const sw=control('automation-access','INPUT','');
  ctx.restoreRunnerFocus(body([sw]),{id:'automation-access-off',tag:'BUTTON',text:'Turn input off',index:0});
  assert.equal(sw.focused,1);
  // an id'd control with no replacement in its role leaves focus alone; id-less controls still match by position and text
  ctx.restoreRunnerFocus(body([startPreset]),{id:'some-control',tag:'SELECT',text:'FarmShard',index:0});
  assert.equal(startPreset.focused,0);
  const stop=control('','BUTTON','Stop now');
  ctx.restoreRunnerFocus(body([startPreset,stop]),{id:'',tag:'BUTTON',text:'Stop now',index:1});
  assert.equal(stop.focused,1);
});

test('H2UI-R3-07: scan age and time must be compatible with each other; later sampling stays allowed', () => {
  const S=DashboardView.processScanFresh;
  // H = harvest.server_time; the process scan may be sampled later than H, so a scan time a little after H and an age
  // larger than H - time are legitimate (Astra's second opinion: age 6 at H and at H+2 stay accepted)
  assert.deepEqual([[0,0],[6,-6],[0.1,-0.1],[2,-3.9],[6,0],[6,2],[0,2],[6,-8]].map(([age,delta])=>S({state:'fresh',age_sec:age,last_success_at:NOW+delta},NOW)),
    [true,true,true,true,true,true,true,true]);
  // a scan already older at H than its age allows (age 0 at H-7), or far ahead of H, is incompatible and unknown
  assert.deepEqual([[0,-7],[0,-9],[0,3],[0,-2.5],[6,-8.5],[6,2.5],[7,0],[-1,0]].map(([age,delta])=>S({state:'fresh',age_sec:age,last_success_at:NOW+delta},NOW)),
    [false,false,false,false,false,false,false,false]);
  // only the scan's relation to the given server time matters (never the browser clock)
  assert.equal(S({state:'fresh',age_sec:0,last_success_at:NOW+7},NOW+7),true);
  assert.equal(S({state:'fresh',age_sec:0,last_success_at:NOW},NOW+7),false);
});

test('H2UI-R3-08: a missing, malformed or contradictory stop answer is never "no collector was running"', async () => {
  const after=async (stop,desired={revision:5})=>{const p=page({status:{harvest:on({state:'collecting',operation:collector()}),processes:[]}});
    p.t.routes['POST /api/harvest']=[reply(200,{ok:true,desired,stop})];await p.ctx.setHarvest(false);p.laterRead(COMPLETE());return p.gems();};
  const R={requested:true};
  for (const stop of [null,undefined,{},[],'stopped',{...R,stopped:[],stopping:null,errors:[]},{...R,stopped:[],stopping:{},errors:[]},{...R,stopped:[],stopping:[42],errors:[]},
    {...R,stopped:[],stopping:[''],errors:[]},{...R,stopped:null,stopping:[],errors:[]},{...R,stopped:[],stopping:[]},{...R,stopped:[{}],stopping:[],errors:[]},
    {...R,stopped:[],stopping:[],errors:{}},
    // requested not a boolean
    {requested:'true',stopped:[],stopping:[],errors:[]},{requested:1,stopped:[],stopping:[],errors:[]},{requested:null,stopped:[],stopping:[],errors:[]},
    // contradictory: an id both stopped and stopping, an id twice, ids although no stop ran
    {...R,stopped:['op-c'],stopping:['op-c'],errors:[]},{...R,stopped:['op-c','op-c'],stopping:[],errors:[]},
    {requested:false,stopped:['op-c'],stopping:[],errors:[]},{requested:false,stopped:[],stopping:['op-c'],errors:[]}]) {
    const out=await after(stop);
    assert.doesNotMatch(out,/data-tone="ok"/,JSON.stringify(stop));
    assert.match(out,/Paused, but the answer did not say what stopped, so collector input is not confirmed stopped\./,JSON.stringify(stop));
  }
  // an answer whose own choice is not Off contradicts a pause
  for (const choice of ['on','unset',true,1]) {
    const out=await after({...R,stopped:[],stopping:[],errors:[]},{revision:5,choice});
    assert.match(out,/data-tone="warn">Paused, but the answer did not say what stopped/,String(choice));
  }
  // empty lists without `requested` do not say whether a stop ran (harvest.py: requested false = no stop ran)
  const silent=await after({stopped:[],stopping:[],errors:[]});
  assert.doesNotMatch(silent,/data-tone="ok"|no collector was running/);
  assert.match(silent,/data-tone="warn">Paused, but the answer did not say whether a stop ran, so collector input is not confirmed stopped\./);
  // ids without `requested` show a stop ran: the ids keep their meaning
  assert.match(await after({stopped:['op-c'],stopping:[],errors:[]}),/data-tone="ok">Paused; collector input stopped\./);
  // (stopping, then confirmed by the later complete read that no longer names it)
  assert.match(await after({stopped:[],stopping:['op-c'],errors:[]}),/data-tone="ok">Paused; collector input stopped\./);
  // the server ran no stop because this pause was no longer the current choice: nothing is known about the collector
  const noStop=await after({requested:false,stopped:[],stopping:[],errors:[]},{revision:5,choice:'off'});
  assert.doesNotMatch(noStop,/data-tone="ok"|no collector was running/);
  assert.match(noStop,/data-tone="warn">Paused, but the server ran no stop for this pause \(it was no longer the current choice\), so collector input is not confirmed stopped\./);
  // controls: the contract's explicit outcomes keep their meaning
  assert.match(await after({...R,stopped:[],stopping:[],errors:[]}),/data-tone="ok">Paused; no collector was running\./,'explicit empty lists');
  assert.match(await after({...R,stopped:[],stopping:[],errors:[]},{revision:5,choice:'off'}),/data-tone="ok">Paused; no collector was running\./,'with its Off choice');
  assert.match(await after({...R,stopped:['op-c'],stopping:[],errors:[]}),/data-tone="ok">Paused; collector input stopped\./,'stopped by the server');
  assert.match(await after({...R,stopped:[],stopping:[],errors:[{operation_id:'op-c',message:'cancel refused'}]}),/data-tone="warn">Paused, but stopping the collector reported: cancel refused\./);
  assert.match(await after({requested:false,stopped:[],stopping:[],errors:[{operation_id:null,message:'OSError: x'}]}),/data-tone="warn">Paused, but stopping the collector reported: OSError: x\./);
  // every fixture Off answer still renders its definite outcome (its revision aligned with the later read)
  for (const name of ['off_ok_stopped','off_ok_replayed','off_during_action_lock']) {
    const body=fixture.post_harvest[name].body;
    assert.equal(body.desired.choice,'off',name);
    assert.match(await after(body.stop,{...body.desired,revision:5}),/data-tone="ok">Paused; (collector input stopped|no collector was running)\./,name);
  }
});

test('H2UI-R3-08 (same family): a tap-off answer whose lists contradict each other or its state is never stopped or "nothing was running"', async () => {
  const feedback=async revocation=>{const p=page({status:{harvest:on({state:'collecting',operation:collector()}),processes:[]}});
    p.t.routes['POST /api/automation-access']=[reply(200,{ok:true,enabled:false,revocation})];
    await p.ctx.setAutomationAccess(false,{});return p.ctx.accessFeedbackHTML();};
  const base={fenced:true,latched:true,config_persisted:true,revoked_at:NOW,harvest:{paused:true,revision:5},errors:[],still_owned:[]};
  for (const lists of [{stopped:['op-c'],stopping:['op-c']},{stopped:['op-c','op-c'],stopping:[]},{stopped:[],stopping:['op-c','op-c']},{stopped:{},stopping:[]},{stopped:[],stopping:[7]}]) {
    const out=await feedback({...base,state:'input_stopped',...lists});
    assert.doesNotMatch(out,/data-tone="ok"/,JSON.stringify(lists));
    assert.match(out,/the answer was incomplete, so stopped input is not confirmed/,JSON.stringify(lists));
  }
  // nothing_running while the same answer names a stopped collector contradicts itself
  const contradicted=await feedback({...base,state:'nothing_running',stopped:['op-c'],stopping:[]});
  assert.doesNotMatch(contradicted,/data-tone="ok"|nothing was running/);
  // controls
  assert.match(await feedback({...base,state:'nothing_running',stopped:[],stopping:[]}),/data-tone="ok">Game input is off; nothing was running\./);
  assert.match(await feedback({...base,state:'input_stopped',stopped:['op-c'],stopping:[]}),/data-tone="ok">Game input is off and automation input stopped\./);
});

test('H2UI-R3-05: "Collecting" needs the collector report and the clock to agree; old, future or contradicting times are not collecting', () => {
  const c=fixture.status.collecting;
  const collecting=(mutate,now=c.server_time)=>{const h=clone(c);mutate(h);return /Collecting gems/.test(DashboardView.harvestView({harvest:h,now}).headline);};
  assert.equal(collecting(()=>{}),true);
  assert.equal(collecting(()=>{},c.server_time+86400),true,'the browser clock plays no part');
  assert.equal(collecting(()=>{},c.server_time-86400),true);
  const cases={'age 180':h=>{h.operation.battle.observation_age_sec=180;}, 'age 16':h=>{h.operation.battle.observation_age_sec=16;h.operation.battle.published_at=h.server_time-16;},
    'no server time':h=>{delete h.server_time;}, 'null server time':h=>{h.server_time=null;},
    'future publication':h=>{h.operation.battle.published_at=h.server_time+3600;}, 'stale publication with a fresh age':h=>{h.operation.battle.published_at=h.server_time-180;},
    'future observed_through':h=>{h.operation.evidence.observed_through_at=h.server_time+3600;},
    'future latest confirmation':h=>{h.operation.evidence.latest_confirmations.ad_gems.observed_at=h.server_time+3600;},
    'server clock an hour behind the publication':h=>{h.server_time-=3600;}, 'server clock an hour ahead':h=>{h.server_time+=3600;},
    'operation failed':h=>{h.operation.status='failed';}, 'operation id missing':h=>{delete h.operation.id;}, 'battle not active':h=>{h.operation.battle.status='ended';},
    'negative age':h=>{h.operation.battle.observation_age_sec=-1;}, 'evidence malformed':h=>{h.operation.evidence=[];}, 'dead worker':h=>{h.operation.worker_alive=false;}};
  for (const [name,mutate] of Object.entries(cases)) assert.equal(collecting(mutate),false,name);
  const revoked=clone(c);revoked.input_revoked=true;
  const v=DashboardView.harvestView({harvest:revoked,now:c.server_time});
  assert.deepEqual([v.headline,v.tone],['On \u00b7 Collector running; game input is revoked, so it does not collect','warn']);
  const old=clone(c);old.operation.battle.observation_age_sec=180;
  assert.equal(DashboardView.harvestView({harvest:old,now:c.server_time}).tone,'warn');
});

test('H2UI-R3-03: while a Turn on is pending or unconfirmed, Pause stays and works whatever the status contains', async () => {
  for (const [name,status] of [['harvest null',{harvest:null}],['harvest absent',{harvest:undefined}],['version 2',{harvest:{...harvest(),version:2}}],
    ['status_failed',{harvest:clone(fixture.status.status_failed)}]]) {
    for (const held_ of [true,false]) {
      const p=page({status:{harvest:harvest()}});
      const hold=held();p.t.routes['POST /api/harvest']=[held_ ? hold.step : 'drop',reply(200,{ok:true,desired:{revision:6},stop:{requested:true,stopped:[],stopping:[],errors:[]}})];
      const sending=p.ctx.setHarvest(true);if(!held_)await sending;
      p.laterRead(status);
      const out=p.gems();
      assert.match(out,/<button class="small" id="harvest-pause" onclick="setHarvest\(false\)"  title="Pauses harvesting whatever the unconfirmed Turn on did/,name+(held_?' (held)':' (lost)'));
      assert.match(out,/The pending Turn on uses Farm's saved gem settings/,name);
      await p.ctx.setHarvest(false);
      assert.equal(p.posts().length,2,name);
      assert.deepEqual(Object.keys(p.posts()[1][2]).sort(),['enabled','expected_context','idempotency_key'],name);
      assert.equal(p.posts()[1][2].enabled,false,name);
      if(held_){hold.release(reply(200,{ok:true,desired:{revision:5},stop:null}));await sending;await flush();}
      assert.doesNotMatch(p.gems(),/Turned on/,name);
    }
  }
  // with no pending Turn on, a status without harvesting cannot show it is off: Pause is offered and works (H2UI-R4-01)
  const p=page({status:{harvest:null}});
  assert.match(p.gems(),/id="harvest-pause" onclick="setHarvest\(false\)"  title="No current status confirms that harvesting is off/);
  assert.doesNotMatch(p.gems(),/id="harvest-on"/);
  p.t.routes['POST /api/harvest']=[reply(200,{ok:true,desired:{revision:6},stop:{requested:true,stopped:[],stopping:[],errors:[]}})];
  await p.ctx.setHarvest(false);
  assert.equal(p.posts().length,1);
  assert.equal(await (async()=>{p.ctx.S.status.harvest=undefined;await p.ctx.setHarvest(true);return p.posts().length;})(),1,'Turn on still needs a readable status');
});
