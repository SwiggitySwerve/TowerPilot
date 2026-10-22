const test=require('node:test');
const assert=require('node:assert/strict');
const UI=require('../webui/run-workspace.js');
const base={routines:{ad_gems:{enabled:true,interval_sec:300,window_sec:10}}};
const battle=(extra={})=>({id:'battle-1',operation_id:'op-1',generation:2,status:'active',control_revision:0,applied_revision:0,envelope:{controls:base},effective:base,overrides:{},capabilities:{controls:['routines.ad_gems.enabled','routines.ad_gems.interval_sec','routines.ad_gems.window_sec','shopping_plan'],actions:['ad_gems']},
  // The driver has just published a status report; tests of a missing or old report pass their own runtime.
  runtime:{server_time:Date.now()/1000},...extra});
const plan=()=>({version:2,enabled:true,interval_sec:5,cash_reserve:100,queue_mode:'round_robin',queue:[{id:'health',enabled:true,tap_limit:2,from_wave:1,until_wave:null},{id:'damage',enabled:true,tap_limit:null,from_wave:1,until_wave:null}],excluded_upgrades:['defense_absolute']});

test('flat overrides retain immutable defaults and preserve false and zero',()=>{
  const frozen={routines:{ad_gems:{enabled:true,interval_sec:300}},cash:12};
  const result=UI.effective(frozen,{'routines.ad_gems.enabled':false,cash:0,'routines.ad_gems.interval_sec':null});
  assert.deepEqual(result,{routines:{ad_gems:{enabled:false,interval_sec:300}},cash:0});
  assert.equal(frozen.routines.ad_gems.enabled,true);
});
test('accepted revision stays pending until driver acknowledgement; refresh retains typing',()=>{
  const model=UI.makeModel('live',battle());
  model.pending['routines.ad_gems.interval_sec']={value:70,revision:1};
  model.draft['routines.ad_gems.window_sec']=20;
  assert.equal(UI.refresh(model,battle({control_revision:1,applied_revision:0})),true);
  assert.equal(UI.fieldValue(model,'routines.ad_gems.interval_sec'),70);
  assert.ok(model.pending['routines.ad_gems.interval_sec']);
  UI.refresh(model,battle({control_revision:1,applied_revision:1,effective:{routines:{ad_gems:{enabled:true,interval_sec:70,window_sec:10}}}}));
  assert.equal(Object.keys(model.pending).length,0);
  assert.equal(UI.fieldValue(model,'routines.ad_gems.window_sec'),20);
});
test('identity and monotonically increasing revisions reject stale observations',()=>{
  const model=UI.makeModel('live',battle({control_revision:3,applied_revision:2}));
  for(const change of [{id:'battle-2'},{operation_id:'op-2'},{generation:3},{control_revision:2},{applied_revision:1}])assert.equal(UI.refresh(model,battle({control_revision:3,applied_revision:2,...change})),false);
  assert.equal(model.snapshot.control_revision,3);
});
test('saved identity rejects another context even with identical profile revision and settings',()=>{
  const snapshot={blueprint:'farm',profile_revision:'same_bytes',settings:base,context:{instance:'main',account:'first',profile:'one'}};
  const model=UI.makeModel('saved',snapshot);
  for(const context of [{...snapshot.context,instance:'other'},{...snapshot.context,account:'second'},{...snapshot.context,profile:'two'}])assert.equal(UI.refresh(model,{...snapshot,context}),false);
  assert.equal(model.snapshot.context.account,'first');
});
test('countdowns use only observed deadlines and explain blocked, stale and unknown states',()=>{
  assert.equal(UI.countdown({deadline:115,observed_at:100},true,102),'13s');
  assert.equal(UI.countdown({deadline:99,observed_at:100},true,102),'Due · awaiting driver');
  assert.equal(UI.countdown({deadline:115,observed_at:80},true,102),'Stale observation');
  assert.equal(UI.countdown({state:'blocked',blocked_reason:'Screen not owned'},true,102),'Screen not owned');
  assert.equal(UI.countdown({state:'waiting_condition',condition:'Wave unknown'},true,102),'Wave unknown');
  assert.equal(UI.countdown(null,true,102),'Timing unknown');
  assert.equal(UI.countdown(null,false,102),'Off');
  assert.equal(UI.countdown({state:'scheduled',next_due_at:112,server_time:100},true,102),'10s');
  assert.equal(UI.countdown({state:'window',window_ends_at:107,server_time:100},true,102),'Window 5s');
  assert.equal(UI.countdown({blocker:'waiting_for_game_state',server_time:100},true,102),'Waiting for game state');
});
test('duration hints appear strictly above sixty seconds and preserve fractional seconds',()=>{
  for(const [value,expected] of [[720,'12m 00s'],[960,'16m 00s'],[90,'1m 30s'],[60.5,'1m 00.5s'],[90.1,'1m 30.1s'],[119.9999,'1m 59.9999s'],[60,''],[59.9,''],[0,''],[-90,''],[null,''],[NaN,''],[Infinity,'']])assert.equal(UI.durationHint(value),expected,String(value));
});

for(const scope of ['live','saved'])test(`${scope} seconds fields show duration hints above separate pending or default feedback`,()=>{
  const settings={routines:{ad_gems:{enabled:true,interval_sec:720,window_sec:60},floating_gems:{enabled:true,interval_sec:960,window_sec:90,tap_interval_sec:60.5},shopping:{enabled:true,interval_sec:720}}};
  const model=UI.makeModel(scope,scope==='live'?battle({effective:settings}):{blueprint:'farm',settings,capabilities:{controls:[]}});
  model.draft['routines.ad_gems.interval_sec']=960;
  const html=UI.renderHTML(model);
  assert.match(html,/data-duration="routines.ad_gems.interval_sec" >16m 00s<\/small><small data-pending="routines.ad_gems.interval_sec">Pending/);
  assert.match(html,/data-duration="routines.ad_gems.window_sec" hidden><\/small>/);
  assert.match(html,/data-duration="routines.floating_gems.window_sec" >1m 30s<\/small>/);
  assert.match(html,/data-duration="routines.floating_gems.tap_interval_sec" >1m 00.5s<\/small>/);
  assert.match(html,/data-duration="routines.shopping.interval_sec" >12m 00s<\/small>/);
  assert.doesNotMatch(html,/data-duration="[^"]+\.enabled"/);
});

test('commands bind battle, generation and revision and create distinct idempotency keys',()=>{
  const model=UI.makeModel('live',battle({control_revision:4}));
  const a=UI.command(model,{action:'ad_gems'}),b=UI.command(model,{action:'ad_gems'});
  assert.deepEqual([a.battle_id,a.generation,a.expected_revision,a.action],['battle-1',2,4,'ad_gems']);
  assert.notEqual(a.idempotency_key,b.idempotency_key);
});
test('global queue moves across workshop pages and null limits remain unlimited',()=>{
  const original=plan();const moved=UI.moveQueue(original,'damage','health');
  assert.deepEqual(moved.queue.map(u=>u.id),['damage','health']);
  const edited=UI.editPlan(moved,'queue.damage.tap_limit',null);
  assert.equal(edited.queue[0].tap_limit,null);
  assert.deepEqual(original.queue.map(u=>u.id),['health','damage']);
  assert.equal(UI.editPlan(original,'cash_reserve',0).cash_reserve,0);
  assert.ok(UI.editPlan(original,'queue.defense_absolute.enabled',true).queue.some(u=>u.id==='defense_absolute'));
  assert.deepEqual(UI.editPlan(original,'queue.defense_absolute.enabled',true).excluded_upgrades,[]);
});
for(const excluded of [false,true])test(`reselecting an upgrade appends it and preserves its settings (${excluded?'excluded':'disabled'})`,()=>{
  const original=plan();
  Object.assign(original.queue[0],{enabled:excluded,tap_limit:0,weight:4,from_wave:12,until_wave:90});
  original.excluded_upgrades=excluded?['health','defense_absolute']:['defense_absolute'];
  const before=structuredClone(original);
  const selected=UI.editPlan(original,'queue.health.enabled',true);
  assert.deepEqual(selected,{...before,queue:[before.queue[1],{...before.queue[0],enabled:true}],excluded_upgrades:['defense_absolute']});
  assert.deepEqual(original,before);
  const selectedAgain=UI.editPlan(selected,'queue.health.enabled',true);
  assert.deepEqual(selectedAgain,selected);
});
test('dropping an unselected upgrade before a target enables it without losing queue or plan settings',()=>{
  const original=plan();original.queue_mode='weighted_split';
  original.queue.splice(1,0,{id:'range',enabled:false,tap_limit:7,weight:3,from_wave:20,until_wave:80});
  original.excluded_upgrades.push('range');
  const before=structuredClone(original);
  const dropped=UI.dropInQueue(original,'range','health');
  assert.deepEqual(dropped,{...before,queue:[{...before.queue[1],enabled:true},before.queue[0],before.queue[2]],excluded_upgrades:['defense_absolute']});
  assert.deepEqual(original,before);
});
test('dropping a new upgrade at the end adds one selected entry and preserves existing configuration',()=>{
  const original=plan(),before=structuredClone(original);
  const dropped=UI.dropInQueue(original,'defense_absolute');
  assert.deepEqual(dropped,{...before,queue:[...before.queue,{id:'defense_absolute',enabled:true,tap_limit:null,from_wave:1,until_wave:null,weight:1}],excluded_upgrades:[]});
  assert.deepEqual(original,before);
});
test('selected upgrades can move before either neighbor or to the end without duplicates',()=>{
  const original=plan();
  original.queue.push({id:'cash_bonus',enabled:true,tap_limit:0,weight:5,from_wave:50,until_wave:100});
  const before=structuredClone(original);
  const earlier=UI.dropInQueue(original,'cash_bonus','health');
  assert.deepEqual(earlier,{...before,queue:[before.queue[2],before.queue[0],before.queue[1]]});
  const later=UI.dropInQueue(original,'health','cash_bonus');
  assert.deepEqual(later,{...before,queue:[before.queue[1],before.queue[0],before.queue[2]]});
  const appended=UI.dropInQueue(original,'health',null);
  assert.deepEqual(appended,{...before,queue:[before.queue[1],before.queue[2],before.queue[0]]});
  assert.deepEqual(UI.dropInQueue(original,'health','health'),before);
  assert.deepEqual(original,before);
});
test('selected card chips keep numeric controls and accessible Try once actions visible',()=>{
  const p=plan();const settings={...base,shopping_plan:p};
  const model=UI.makeModel('live',battle({effective:settings,catalog:[{id:'damage',label:'Damage',section:'attack',order:1,recognition:'template'},{id:'health',label:'Health',section:'defense',order:0,recognition:'template'},{id:'range',label:'Range',section:'attack',order:2,recognition:'unsupported'}]}));
  const html=UI.renderHTML(model);
  assert.match(html,/class="know-grid rw-upgrades"/);
  assert.match(html,/aria-label="Try once: Damage"/);
  assert.match(html,/data-shop="queue.damage.tap_limit"/);
  assert.match(html,/class="rw-chip-controls" >|class="rw-chip-controls"\s*>/);
  assert.match(html,/Recognition unavailable/);
  assert.match(html,/data-move="damage"/);
  assert.match(html,/data-shop="cash_reserve"/);
  assert.match(html,/provisional/);
  assert.doesNotMatch(html,/Wave rules/);
});
for(const scope of ['live','saved'])test(`${scope} workshop presents priority before page groups in reading and keyboard order`,()=>{
  const catalog=[{id:'damage',label:'Damage',section:'attack',order:1,recognition:'template'},{id:'health',label:'Health',section:'defense',order:0,recognition:'template'}];
  const settings={...base,shopping_plan:plan()};
  const model=UI.makeModel(scope,scope==='live'?battle({effective:settings,catalog}):{blueprint:'farm',settings,catalog,capabilities:{controls:['shopping_plan']}});
  const html=UI.renderHTML(model);
  const queue=html.indexOf('class="rw-global-queue"'),pages=html.indexOf('class="rw-selector-pages"');
  assert.ok(queue>=0 && pages>queue);
  assert.ok(html.indexOf('data-queue-id="health"')<pages);
  assert.ok(html.indexOf('data-upgrade="damage"')>pages);
  assert.match(html,/or select an upgrade/);
  if(scope==='saved')assert.match(html,/<button class="small ghost" type="button" disabled aria-label="Try once: Damage"/);
});
test('weighted split exposes per-turn quantities on selected chips',()=>{
  const p=plan();p.queue_mode='weighted_split';p.queue[0].weight=3;
  const model=UI.makeModel('saved',{blueprint:'farm',settings:{...base,shopping_plan:p},catalog:[{id:'health',label:'Health',section:'defense',order:0,recognition:'template'}],capabilities:{controls:['shopping_plan']}});
  const html=UI.renderHTML(model);
  assert.match(html,/value="weighted_split" selected/);
  assert.match(html,/Per turn/);
  assert.match(html,/max="100"[^>]*data-shop="queue.health.weight" value="3"/);
  assert.equal(UI.editPlan(p,'queue.health.weight',4).queue[0].weight,4);
});
test('legacy conversion requires an explicit reviewed action and never silently starts a queue',()=>{
  const model=UI.makeModel('saved',{blueprint:'farm',settings:{...base,shopping_plan:null},capabilities:{controls:['shopping_plan']},legacy_conversion:{plan:plan(),warnings:['Bounded attempt review required']}});
  const html=UI.renderHTML(model);
  assert.match(html,/Review shopping conversion/);
  assert.match(html,/data-convert-plan/);
  assert.doesNotMatch(html,/data-new-plan/);
  assert.equal(model.snapshot.settings.shopping_plan,null);
  assert.match(html,/rw-conversion-preview/);
  assert.match(html,/2\. Damage/);
  assert.match(html,/No tap cap/);
  assert.match(html,/<details><summary>Raw configuration<\/summary><pre>/);
  assert.doesNotMatch(html,/<details open><summary>Raw configuration/);
});
test('history presents observed duration, last wave and capture failures without inventing metrics',()=>{
  const html=UI.historySummaryHTML({boundary_evidence:{last_observed_wave:123},runtime:{observed_duration_sec:65,stats_capture:{status:'failed',verified:false,reason:'clipboard_stale'}}});
  assert.match(html,/123/);assert.match(html,/1m 5s observed/);assert.match(html,/Failed/);assert.match(html,/unverified/);assert.match(html,/clipboard_stale/);
  assert.match(html,/Recorded collection evidence <strong>Not recorded/);
  assert.match(html,/Gem total unknown/);
  const empty=UI.historySummaryHTML({});assert.match(empty,/Observed duration <strong>Unknown/);assert.doesNotMatch(empty,/0m 0s/);
});

test('setup evidence distinguishes manual verification, degraded partial continuation and unknown reports',()=>{
  const verified=UI.setupEvidenceHTML({state:'verified',loadout:'Farm',detail:'manual_equipment',continued_with_partial:false,modules:[]});
  assert.match(verified,/Setup <strong class="rw-setup-verified">Verified<\/strong>/);
  assert.match(verified,/Loadout: Farm/);assert.match(verified,/Manual equipment/);
  assert.doesNotMatch(verified,/Continued with partial setup/);
  const degraded=UI.setupEvidenceHTML({state:'degraded',detail:'manual_equipment',reason:'assist_not_observed',continued_with_partial:true,modules:[{module:'core',role:'assist',state:'unknown',detail:'slot_not_observed',reason:'empty_slot'}]});
  assert.match(degraded,/rw-setup-degraded">Degraded/);assert.match(degraded,/assist_not_observed/);
  assert.match(degraded,/Continued with partial setup/);assert.match(degraded,/Module evidence \(1\)/);
  assert.match(degraded,/<strong>core<\/strong> \(Assist\) · Unknown · Slot not observed · empty_slot/);
  const slots=UI.setupEvidenceHTML({state:'degraded',detail:'unexpected_setup_result',modules:[
    {module:'cannon',role:'category',state:'verified',detail:'equipped_header'},
    {module:'core',role:'primary',state:'degraded',detail:'not_in_expected_slot'},
    {module:'generator',role:'assist',state:'unknown',detail:'not_verified'}]});
  assert.match(slots,/Unexpected setup result/);
  assert.match(slots,/\(Category slot\) · Verified · Equipped slot confirmed/);
  assert.match(slots,/\(Primary\) · Degraded · Not in expected slot/);
  assert.match(slots,/\(Assist\) · Unknown · Not verified/);
  assert.doesNotMatch(slots,/unexpected_setup_result|equipped_header|not_in_expected_slot|not_verified/);
  for(const missing of [undefined,null,{}, {state:'unsupported'}]){
    const html=UI.setupEvidenceHTML(missing);
    assert.match(html,/rw-setup-unknown">Unknown/);assert.match(html,/No setup evidence recorded/);
    assert.doesNotMatch(html,/rw-setup-verified/);
  }
});

test('global presets describe selection-only evidence and adopted or as-is setup remains explicit',()=>{
  const html=UI.setupEvidenceHTML({state:'verified',detail:'global_preset_selection',loadout:'Selected preset'});
  assert.match(html,/Verified/);assert.match(html,/Global preset selection only; contents not inspected/);
  assert.doesNotMatch(html,/equipment verified|Manual equipment/i);
  for(const [detail,wording] of [['as_is','Equipment left as is; not verified'],['adopted','Adopted battle; setup not verified'],['setup_refused','Setup refused']]){
    const report=UI.setupEvidenceHTML({state:'unknown',detail,reason:'no_setup_observation'});
    assert.match(report,/rw-setup-unknown">Unknown/);assert.ok(report.includes(wording));assert.match(report,/no_setup_observation/);
  }
});

test('setup evidence escapes backend loadout, reason and module text',()=>{
  const hostile='<img src=x onerror="alert(1)"> & \'name\'';
  const html=UI.setupEvidenceHTML({state:hostile,loadout:hostile,detail:hostile,reason:hostile,modules:[{module:hostile,role:hostile,state:hostile,detail:hostile,reason:hostile}]});
  assert.doesNotMatch(html,/<img|onerror="alert/);
  assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;name&#39;/);
  assert.match(html,/rw-setup-unknown">Unknown/);
});

test('current battles and history share setup evidence while saved controls have no outcome',()=>{
  const setup={state:'degraded',detail:'manual_equipment',reason:'assist_unverified',continued_with_partial:true};
  const current=UI.renderHTML(UI.makeModel('live',battle({runtime:{setup}})));
  const history=UI.historySummaryHTML({runtime:{setup}});
  for(const html of [current,history]){
    assert.ok(html.includes(UI.setupEvidenceHTML(setup)));
    assert.match(html,/Continued with partial setup/);
  }
  assert.match(current,/data-setup aria-label="Setup evidence"/);
  assert.match(UI.historySummaryHTML({}),/rw-setup-unknown">Unknown/);
  assert.doesNotMatch(UI.renderHTML(UI.makeModel('saved',{blueprint:'farm',settings:base,runtime:{setup}})),/rw-setup|Setup evidence/);
});

test('snapshot notices appear escaped immediately after the toolbar',()=>{
  const model=UI.makeModel('saved',{blueprint:'farm',settings:base,notice:'Driver <legacy> & unsupported'});
  assert.match(UI.renderHTML(model),/<span role="status" class="rw-status"><\/span><\/div><p class="muted rw-plan-note">Driver &lt;legacy&gt; &amp; unsupported<\/p>/);
});

function host(){
  const status={textContent:''};
  const doc={activeElement:null};
  const input={dataset:{control:'routines.ad_gems.interval_sec'},type:'number',value:'60',valueAsNumber:60,ownerDocument:doc,checkValidity:()=>true,closest(selector){return selector==='[data-control]'?this:null;}};
  return {isConnected:true,renderCount:0,status,input,ownerDocument:doc,
    set innerHTML(value){this.markup=value;this.renderCount++;},get innerHTML(){return this.markup;},
    querySelector(selector){return selector==='.rw-status'?status:null;},
    querySelectorAll(selector){return selector==='[data-control]'?[input]:[];}};
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,480));
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('polling refreshes setup evidence without replacing focused or invalid controls',async()=>{
  const h=host(),setupRegion={dataset:{},renderCount:0,set innerHTML(value){this.markup=value;this.renderCount++;},get innerHTML(){return this.markup;}};
  const query=h.querySelector.bind(h);
  h.querySelector=selector=>selector==='[data-setup]'?setupRegion:query(selector);
  let snapshot=battle({runtime:{setup:{state:'unknown',detail:'adopted'}}});
  const workspace=UI.create({request:async()=>({battle:snapshot})});
  try {
    workspace.attach({live:h});await settle();
    assert.match(setupRegion.innerHTML,/Adopted battle; setup not verified/);
    const renders=h.renderCount;
    h.ownerDocument.activeElement=h.input;h.input.value='';h.input.valueAsNumber=NaN;h.oninput({target:h.input});
    snapshot=battle({runtime:{setup:{state:'degraded',detail:'manual_equipment',reason:'assist_not_observed',continued_with_partial:true}}});
    await workspace.poll();
    assert.match(setupRegion.innerHTML,/Degraded/);assert.match(setupRegion.innerHTML,/assist_not_observed/);
    assert.match(setupRegion.innerHTML,/Continued with partial setup/);
    assert.equal(h.renderCount,renders);assert.equal(h.input.value,'');assert.equal(h.ownerDocument.activeElement,h.input);
    assert.equal(h.status.textContent,'Enter a valid value');
    const setupRenders=setupRegion.renderCount;await workspace.poll();
    assert.equal(setupRegion.renderCount,setupRenders,'unchanged evidence preserves module disclosure state');
  } finally {workspace.destroy();}
});

test('history detail displays legacy unknown and recorded setup outcomes',async()=>{
  const target={innerHTML:'',textContent:''};
  const historyHost={querySelector:selector=>selector==='.rw-history-detail'?target:null};
  let snapshot=battle({status:'completed'});
  const workspace=UI.create({request:async()=>({battle:snapshot,events:[]})});
  try {
    workspace.attach({history:historyHost});await workspace.detail('battle-1');
    assert.match(target.innerHTML,/rw-setup-unknown">Unknown/);
    snapshot=battle({status:'completed',runtime:{setup:{state:'verified',detail:'global_preset_selection'}}});
    await workspace.detail('battle-1');
    assert.match(target.innerHTML,/Global preset selection only; contents not inspected/);
  } finally {workspace.destroy();}
});
test('duration hints update immediately while typing, hide for invalid or short values, and follow refreshed seconds',async()=>{
  const h=host(),duration={textContent:'',hidden:true},pending={textContent:''};
  const originalQuery=h.querySelector.bind(h);
  h.querySelector=selector=>selector==='[data-duration="routines.ad_gems.interval_sec"]'?duration:selector==='[data-pending="routines.ad_gems.interval_sec"]'?pending:originalQuery(selector);
  let snapshot=battle(),writes=0;
  const workspace=UI.create({request:async(_url,opts)=>{if(opts)writes++;return {battle:snapshot};}});
  workspace.attach({live:h});await settle();
  assert.equal(duration.textContent,'5m 00s');assert.equal(duration.hidden,false);
  h.ownerDocument.activeElement=h.input;
  for(const [value,expected] of [['720','12m 00s'],['960','16m 00s'],['90','1m 30s'],['60',''],['',''],['60.5','1m 00.5s']]){
    h.input.value=value;h.input.valueAsNumber=value===''?NaN:Number(value);h.oninput({target:h.input});
    assert.equal(duration.textContent,expected);assert.equal(duration.hidden,!expected);
  }
  assert.equal(writes,0);assert.equal(pending.textContent,'Pending');
  workspace.destroy();
  const refreshed=host(),refreshedDuration={textContent:'',hidden:true},refreshedQuery=refreshed.querySelector.bind(refreshed);
  refreshed.querySelector=selector=>selector==='[data-duration="routines.ad_gems.interval_sec"]'?refreshedDuration:refreshedQuery(selector);
  const observer=UI.create({request:async()=>({battle:snapshot})});
  observer.attach({live:refreshed});await settle();
  snapshot=battle({effective:{routines:{ad_gems:{enabled:true,interval_sec:960,window_sec:10}}}});await observer.poll();
  assert.equal(refreshed.input.value,960);assert.equal(refreshedDuration.textContent,'16m 00s');
  snapshot=battle({effective:{routines:{ad_gems:{enabled:true,interval_sec:60,window_sec:10}}}});await observer.poll();
  assert.equal(refreshedDuration.textContent,'');assert.equal(refreshedDuration.hidden,true);
  observer.destroy();
});

test('dragging an unselected workshop chip submits its retained settings at the requested queue position',async()=>{
  const h=host(),writes=[],original=plan();
  original.queue.push({id:'range',enabled:false,tap_limit:0,weight:4,from_wave:10,until_wave:50});
  original.excluded_upgrades.push('range');
  const before=structuredClone(original);
  let snapshot=battle({effective:{...base,shopping_plan:original},catalog:[{id:'range',label:'Range',section:'attack',recognition:'template'}]});
  const workspace=UI.create({request:async(_url,opts)=>{
    if(opts){
      const body=JSON.parse(opts.body);writes.push(body);
      snapshot={...snapshot,control_revision:1,applied_revision:1,effective:{...base,shopping_plan:body.changes.shopping_plan}};
    }
    return {battle:snapshot};
  }});
  try {
    workspace.attach({live:h});await settle();
    const row={dataset:{upgrade:'range'},getAttribute:()=> 'true'};
    let transfer;
    const dataTransfer={setData:(_type,value)=>transfer=value,getData:()=>transfer};
    h.ondragstart({target:{closest:selector=>selector==='[data-queue-id], [data-upgrade]'?row:null},dataTransfer,preventDefault(){assert.fail('supported chip drag was refused');}});
    h.ondrop({target:{closest:selector=>selector==='[data-queue]'?{}:selector==='[data-queue-id]'?{dataset:{queueId:'health'}}:null},dataTransfer,preventDefault(){}});
    await wait();assert.equal(writes.length,1);
    assert.equal(writes[0].battle_id,'battle-1');assert.equal(writes[0].generation,2);
    assert.deepEqual(writes[0].changes,{shopping_plan:{...before,queue:[{...before.queue[2],enabled:true},before.queue[0],before.queue[1]],excluded_upgrades:['defense_absolute']}});
    assert.deepEqual(original,before);
  } finally {workspace.destroy();}
});
for(const scenario of ['external','unsupported','input','outside','mismatched','read-only'])test(`queue drag refuses ${scenario} input without submitting a change`,async()=>{
  const h=host(),writes=[];
  const snapshot=battle({effective:{...base,shopping_plan:plan()},catalog:[{id:'range',label:'Range',section:'attack',recognition:'template'}]});
  if(scenario==='read-only')snapshot.capabilities.controls=[];
  const workspace=UI.create({request:async(_url,opts)=>{
    if(opts)writes.push(JSON.parse(opts.body));
    return {battle:snapshot};
  }});
  try {
    workspace.attach({live:h});await settle();
    const row={dataset:{upgrade:'range'},getAttribute:()=>scenario==='unsupported'?'false':'true'};
    const dataTransfer={setData(){},getData:()=>scenario==='mismatched'?'health':'range'};
    if(scenario!=='external')h.ondragstart({target:{closest:selector=>selector==='[data-queue-id], [data-upgrade]'?row:selector==='input,select,[data-action]'&&scenario==='input'?{}:null},dataTransfer,preventDefault(){}});
    h.ondrop({target:{closest:selector=>selector==='[data-queue]'&&scenario!=='outside'?{}:null},dataTransfer,preventDefault(){}});
    await wait();assert.deepEqual(writes,[]);assert.equal(h.status.textContent,'Driver acknowledged');
  } finally {workspace.destroy();}
});
test('conversion reserve preview makes no request until the reviewed queue is explicitly applied',async()=>{
  const h=host();const button={disabled:true},preview={dataset:{conversion:'cash_reserve'},value:'50',valueAsNumber:50,tagName:'INPUT',checkValidity:()=>true};
  const originalQuery=h.querySelector;
  h.querySelector=selector=>selector==='[data-convert-plan]'?button:originalQuery(selector);
  const p=plan();p.cash_reserve=null;let writes=0,lastWrite;
  const workspace=UI.create({request:async(_url,opts)=>{
    if(opts){writes++;lastWrite=JSON.parse(opts.body);return {settings:{...base,shopping_plan:lastWrite.changes.shopping_plan}};}
    return {blueprint:'farm',settings:{...base,shopping_plan:null},catalog:[],capabilities:{controls:['shopping_plan']},legacy_conversion:{plan:p,warnings:[]}};
  }});
  workspace.attach({saved:h});await workspace.choose('farm');
  h.oninput({target:{closest:selector=>selector==='[data-conversion]'?preview:null}});
  assert.equal(writes,0);assert.equal(button.disabled,false);
  h.onclick({target:{closest:selector=>selector==='[data-convert-plan]'?button:null}});await settle();
  assert.equal(writes,1);assert.equal(lastWrite.changes.shopping_plan.cash_reserve,50);
  assert.equal(p.cash_reserve,null);workspace.destroy();
});
test('live debounce sends identity and leaves Pending through accepted revision without rebuilding inputs',async()=>{
  const h=host();let current=battle();const requests=[];
  const workspace=UI.create({request:async(url,opts)=>{
    if(!opts)return {battle:current,server_time:Date.now()/1000};
    requests.push({url,body:JSON.parse(opts.body)});
    current=battle({control_revision:1,applied_revision:0});return {control_revision:1};
  }});
  workspace.attach({live:h});await settle();
  h.input.value='60';h.input.valueAsNumber=60;h.ownerDocument.activeElement=h.input;
  h.oninput({target:h.input});await wait();
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'/api/operations/op-1/live-controls');
  assert.deepEqual(requests[0].body.changes,{'routines.ad_gems.interval_sec':60});
  assert.equal(requests[0].body.battle_id,'battle-1');
  assert.equal(h.status.textContent,'Pending');
  await workspace.poll();assert.equal(h.status.textContent,'Pending');assert.equal(h.renderCount,1);
  current=battle({control_revision:1,applied_revision:1,effective:{routines:{ad_gems:{enabled:true,interval_sec:60,window_sec:10}}}});
  await workspace.poll();assert.equal(h.status.textContent,'Driver acknowledged');assert.equal(h.renderCount,1);
  workspace.destroy();
});

for(const editDuringRequest of [false,true])test(`live drafts wait for acknowledgement and drain automatically (${editDuringRequest?'in-flight':'accepted'} edit)`,async()=>{
  const h=host(),requests=[],errors=[];let snapshot=battle(),release;
  const workspace=UI.create({onError:error=>errors.push(error),request:async(_url,opts)=>{
    if(!opts)return {battle:snapshot};
    const body=JSON.parse(opts.body);requests.push(body);
    if(snapshot.control_revision>snapshot.applied_revision)throw new Error('Previous control revision is still pending');
    if(editDuringRequest && requests.length===1)await new Promise(resolve=>release=resolve);
    snapshot=battle({control_revision:requests.length,applied_revision:requests.length-1});
    return {battle:snapshot};
  }});
  try {
    workspace.attach({live:h});await settle();h.ownerDocument.activeElement=h.input;
    h.input.value='60';h.input.valueAsNumber=60;h.oninput({target:h.input});await wait();
    h.input.value='70';h.input.valueAsNumber=70;h.oninput({target:h.input});
    if(editDuringRequest){release();await settle();}
    h.input.value='90';h.input.valueAsNumber=90;h.oninput({target:h.input});await wait();
    assert.equal(requests.length,1);assert.equal(h.status.textContent,'Pending');
    await workspace.poll();assert.equal(requests.length,1);
    snapshot=battle({control_revision:1,applied_revision:1,effective:{routines:{ad_gems:{enabled:true,interval_sec:60,window_sec:10}}}});
    await workspace.poll();await settle();
    assert.equal(requests.length,2);assert.equal(requests[1].expected_revision,1);
    assert.deepEqual(requests[1].changes,{'routines.ad_gems.interval_sec':90});
    assert.equal(h.status.textContent,'Pending');assert.deepEqual(errors,[]);
    assert.equal(h.input.value,'90');assert.equal(h.ownerDocument.activeElement,h.input);assert.equal(h.renderCount,1);
    snapshot=battle({control_revision:2,applied_revision:2,effective:{routines:{ad_gems:{enabled:true,interval_sec:90,window_sec:10}}}});
    await workspace.poll();assert.equal(h.status.textContent,'Driver acknowledged');
  } finally {workspace.destroy();}
});

test('acknowledgement does not drain a draft while its numeric input is invalid',async()=>{
  const h=host(),requests=[];let snapshot=battle({control_revision:1,applied_revision:0});
  const workspace=UI.create({request:async(_url,opts)=>{
    if(!opts)return {battle:snapshot};
    requests.push(JSON.parse(opts.body));return {control_revision:2};
  }});
  try {
    workspace.attach({live:h});await settle();h.ownerDocument.activeElement=h.input;
    h.input.value='60';h.input.valueAsNumber=60;h.oninput({target:h.input});await wait();
    h.input.value='';h.input.valueAsNumber=NaN;h.oninput({target:h.input});
    snapshot=battle({control_revision:1,applied_revision:1});await workspace.poll();await settle();
    assert.equal(requests.length,0);assert.equal(h.status.textContent,'Enter a valid value');assert.equal(h.input.value,'');
    h.input.value='90';h.input.valueAsNumber=90;h.oninput({target:h.input});await wait();
    assert.equal(requests.length,1);assert.equal(requests[0].expected_revision,1);
    assert.deepEqual(requests[0].changes,{'routines.ad_gems.interval_sec':90});
  } finally {workspace.destroy();}
});

for(const replacement of ['battle','none','account'])test(`queued drafts cannot submit after ${replacement} changes`,async()=>{
  const h=host();let snapshot=battle(),writes=0,release;
  const workspace=UI.create({request:async(_url,opts)=>{
    if(opts){writes++;return {control_revision:1};}
    if(release===null)await new Promise(resolve=>release=resolve);
    return {battle:snapshot};
  }});
  try {
    workspace.attach({live:h,context:'first'});await settle();
    h.input.value='60';h.input.valueAsNumber=60;h.oninput({target:h.input});
    snapshot=replacement==='none'?null:battle({id:'battle-2',operation_id:'op-2',generation:3});
    if(replacement==='account'){
      release=null;workspace.attach({live:h,context:'second'});
    } else await workspace.poll();
    await wait();assert.equal(writes,0);
    if(replacement==='account'){release();await settle();}
    await workspace.poll();assert.equal(writes,0);
  } finally {workspace.destroy();}
});
test('saved edits use saved scope and require returned settings before reporting Saved',async()=>{
  const h=host(),requests=[];
  const workspace=UI.create({request:async(url,opts)=>{
    if(!opts)return {blueprint:'farm',context:{instance:'test',account:'test_account',profile:'test_profile'},profile_revision:'r1',settings:base,capabilities:battle().capabilities};
    const body=JSON.parse(opts.body);requests.push({url,body});
    return {blueprint:'farm',profile_revision:'r2',settings:{routines:{ad_gems:{enabled:true,interval_sec:60,window_sec:10}}}};
  }});
  workspace.attach({saved:h});await workspace.choose('farm');h.input.value='60';h.input.valueAsNumber=60;
  h.oninput({target:h.input});await wait();
  assert.equal(requests[0].url,'/api/run-controls');
  assert.equal(requests[0].body.blueprint,'farm');assert.equal(requests[0].body.expected_revision,'r1');
  assert.deepEqual(requests[0].body.context,{instance:'test',account:'test_account',profile:'test_profile'});
  assert.equal(requests[0].body.battle_id,undefined);assert.equal(h.status.textContent,'Saved');
  workspace.destroy();
});
test('invalid edits cancel a queued valid value instead of sending it while typing',async()=>{
  const h=host();let writes=0;
  const workspace=UI.create({request:async(_url,opts)=>{if(opts)writes++;return {battle:battle()};}});
  workspace.attach({live:h});await settle();
  h.ownerDocument.activeElement=h.input;
  h.input.value='60';h.input.valueAsNumber=60;h.oninput({target:h.input});
  h.input.value='';h.input.valueAsNumber=NaN;h.oninput({target:h.input});
  await wait();assert.equal(writes,0);assert.equal(h.status.textContent,'Enter a valid value');
  workspace.destroy();
});
test('Run now remains busy through request acceptance until command completion',async()=>{
  const h=host();const button={dataset:{action:'ad_gems'},disabled:false};
  h.querySelectorAll=selector=>selector==='[data-action]'?[button]:[];
  const event={target:{closest:selector=>selector==='[data-action]'?button:null}};
  let snapshot=battle(),writes=0,release;
  const workspace=UI.create({request:async(_url,opts)=>{
    if(!opts)return {battle:snapshot};
    writes++;await new Promise(resolve=>release=resolve);return {command:{id:'command-1',state:'requested'}};
  }});
  workspace.attach({live:h});await settle();h.onclick(event);h.onclick(event);
  assert.equal(writes,1);assert.equal(button.disabled,true);
  release();await settle();assert.equal(button.disabled,true);
  snapshot=battle({commands:[{id:'command-1',state:'applied'}]});await workspace.poll();
  assert.equal(button.disabled,false);assert.equal(h.status.textContent,'Driver acknowledged');
  workspace.destroy();
});
test('started commands block actions and expired commands release the UI with their reason',async()=>{
  const h=host();const button={dataset:{action:'ad_gems'},disabled:false};
  h.querySelectorAll=selector=>selector==='[data-action]'?[button]:[];
  const event={target:{closest:selector=>selector==='[data-action]'?button:null}};
  let snapshot=battle({commands:[{id:'automatic',state:'started'}]});
  const workspace=UI.create({request:async(_url,opts)=>opts?{command:{id:'manual',state:'pending'}}:{battle:snapshot}});
  workspace.attach({live:h});await settle();assert.equal(button.disabled,true);
  snapshot=battle({commands:[]});await workspace.poll();assert.equal(button.disabled,false);
  h.onclick(event);await settle();assert.equal(button.disabled,true);
  snapshot=battle({commands:[{id:'manual',state:'expired',reason:'Game state was unavailable'}]});await workspace.poll();
  assert.equal(button.disabled,false);assert.equal(h.status.textContent,'Game state was unavailable');
  workspace.destroy();
});
test('a late edit response cannot update replacement battle controls',async()=>{
  const h=host();let snapshot=battle(),release;
  const workspace=UI.create({request:async(_url,opts)=>{
    if(!opts)return {battle:snapshot};
    await new Promise(resolve=>release=resolve);return {battle:battle({control_revision:1,applied_revision:1})};
  }});
  workspace.attach({live:h});await settle();h.input.value='60';h.input.valueAsNumber=60;h.oninput({target:h.input});await wait();
  snapshot=battle({id:'battle-2',operation_id:'op-2',generation:3});await workspace.poll();
  const renderCount=h.renderCount;release();await settle();
  assert.equal(h.renderCount,renderCount);assert.equal(h.status.textContent,'Driver acknowledged');assert.equal(h.input.value,300);
  workspace.destroy();
});
test('switching saved runs flushes the previous valid draft before loading the next run',async()=>{
  const h=host(),requests=[];
  const workspace=UI.create({request:async(url,opts)=>{
    requests.push({url,body:opts?JSON.parse(opts.body):null});
    const blueprint=opts?'farm':url.includes('other')?'other':'farm';
    return {blueprint,profile_revision:opts?'r2':'r1',settings:base,capabilities:battle().capabilities};
  }});
  workspace.attach({saved:h});await workspace.choose('farm');
  h.input.value='60';h.input.valueAsNumber=60;h.oninput({target:h.input});
  await workspace.choose('other');
  assert.equal(requests[1].url,'/api/run-controls');assert.equal(requests[1].body.blueprint,'farm');
  assert.equal(requests[2].url,'/api/run-controls?blueprint=other');assert.equal(workspace.selected(),'other');
  workspace.destroy();
});

test('ad observation distinguishes first observed bounds from unknown spawn time and stale visibility',()=>{
  const runtime={enabled:true,state:'scheduled',visibility:'visible',visibility_reason:'battle_frame',
    first_seen_at:100,last_observed_at:108,last_seen_at:108,stale_after_sec:8,next_due_at:200,next_check_at:112,
    appearance_after_at:98,counters:{attempts:3,confirmed:1,skips:2,windows_missed:1}};
  const fresh=UI.observationValues(runtime,110);
  assert.equal(fresh.visibility,'Visible on last battle frame');
  assert.match(fresh.first_seen,/10s ago/);
  assert.match(fresh.appearance,/2\.0s observation interval/);
  assert.equal(fresh.timing,'Scheduled window in 90s');
  assert.equal(fresh.next_check,'Passive check in 2s');
  assert.equal(fresh.counters,'Attempts 3 · confirmed 1 · skips 2 · missed windows 1');
  assert.equal(UI.observationValues(runtime,117).visibility,'Unknown (stale observation)');
  assert.equal(UI.observationValues(runtime,110,true).visibility,'Unknown (live status unavailable)');
  assert.match(UI.observationValues({...runtime,appearance_after_at:null},110).appearance,/first observation is not spawn time/);
  assert.match(UI.observationValues(null,110).visibility,/Unknown/);
});

test('ad response and window countdowns identify failures independently of schedule wait',()=>{
  const runtime={visibility:'visible',last_observed_at:100,stale_after_sec:8,window_ends_at:140,response_due_at:115,
    last_failed_attempt:{reason:'offer_moved',observed_at:99}};
  const values=UI.observationValues(runtime,105);
  assert.equal(values.timing,'Response in 10s; window closes in 35s');
  assert.match(values.failure,/Offer moved.*6s ago/);
  assert.match(UI.observationValues(runtime,116).timing,/Response due; awaiting driver/);
  assert.equal(UI.observationValues({...runtime,enabled:false},105).timing,'Collection off');
});

test('live observation markup is stable and inspect links preserve exact escaped identities',()=>{
  const model=UI.makeModel('live',battle({id:'battle &/1',operation_id:'op?1',instance:'emulator-main'}));
  const html=UI.renderHTML(model);
  assert.match(html,/data-observation-field="first_seen"/);
  assert.match(html,/data-runtime-raw="ad_gems"/);
  assert.match(html,/Inspect events/);
  const link=UI.inspectLink(model.snapshot,{offer_id:'offer#1',window_id:'window:2',first_seen_at:100});
  const params=new URLSearchParams(link.split('?')[1]);
  assert.equal(params.get('battle_id'),'battle &/1');
  assert.equal(params.get('operation_id'),'op?1');
  assert.equal(params.get('offer_id'),'offer#1');
  assert.equal(params.get('since'),'40');
  assert.equal(params.has('window_id'),false,'offer history spans collection windows');
  assert.equal(params.has('instance'),false,'dashboard and driver evidence remain joined');
  assert.doesNotMatch(UI.renderHTML(UI.makeModel('saved',{blueprint:'farm',settings:base})),/data-observation-field/);
});

test('observation clock ticks update text without replacing controls or focused drafts',async()=>{
  const h=host(),field={dataset:{observationField:'visibility'},textContent:''};
  const region={querySelectorAll:()=>[field]},raw={dataset:{runtimeRaw:'ad_gems'},textContent:''};
  const original=h.querySelectorAll;
  h.querySelectorAll=selector=>selector==='[data-observation="ad_gems"]'?[region]:selector==='[data-runtime-raw]'?[raw]:original(selector);
  let snapshot=battle({runtime:{routines:{ad_gems:{visibility:'visible',last_observed_at:Date.now()/1000,stale_after_sec:8}}}});
  const workspace=UI.create({request:async()=>({battle:snapshot})});
  workspace.attach({live:h});await settle();
  const renders=h.renderCount;h.ownerDocument.activeElement=h.input;h.input.value='1234';
  workspace.tick();assert.equal(field.textContent,'Visible on last battle frame');
  snapshot=battle({runtime:{routines:{ad_gems:{visibility:'unknown',visibility_reason:'not_battle'}}}});
  await workspace.poll();workspace.tick();
  assert.match(field.textContent,/Unknown/);
  assert.equal(h.renderCount,renders);assert.equal(h.input.value,'1234');assert.equal(h.ownerDocument.activeElement,h.input);
  assert.match(raw.textContent,/not_battle/);
  workspace.destroy();
});
