const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const WorkspaceStatus = require('../webui/workspace-status.js');
const LearningController = require('../webui/learning-controller.js');
const LearningStore = require('../webui/learning-store.js');
const DiagnosticsView = require('../webui/diagnostics-view.js');
const {html, section} = require('./helpers.cjs');

test('refresh resumes preparation completion once, for the saved account and run', async () => {
  const stored = new Map(), requests = [], messages = [];
  const config = {active_instance:'main',instances:{main:{account:'alice',serial:'one',rendering:{width:1080,height:1920,dpi:280}}}};
  const storage = {getItem:k=>stored.get(k) ?? null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)};
  const scope = LearningStore.context(config);
  storage.setItem(scope.preparationKey, JSON.stringify({context:scope.id,preset:'bp_shard_run',operationId:'op-100',revision:1}));
  const flow = LearningController.create({
    config:()=>config, storage, now:()=>100_000,
    selectedRun:()=> 'bp_shard_run',
    apply:async()=>{requests.push('/api/calibrate/apply');return {operation:{id:'op-100',revision:5,status:'succeeded'}};},
    readiness:async preset=>{requests.push('/api/readiness?preset='+preset);return {ready:true};},
    changed:snapshot=>messages.push(snapshot.message), completed:async()=>{}
  });
  assert.equal(flow.pending().preset,'bp_shard_run');
  config.instances.main.account='bob';
  assert.equal(flow.pending(),null);
  config.instances.main.account='alice';
  const observed = {operation:{id:'op-100',revision:3,status:'awaiting_apply',context:{...scope}},running:false,state:{phases:{bootstrap:{kind:'battle',started_at:100,status:'done'}}}};
  // Two status polls may arrive before the apply request finishes.
  const first = flow.observe(observed);
  const second = flow.observe(observed);
  await Promise.all([first,second]);
  assert.deepEqual(requests,['/api/calibrate/apply','/api/readiness?preset=bp_shard_run']);
  assert.equal(flow.pending().outcome,'succeeded');
  assert.match(messages.at(-1),/Ready/);
  await flow.observe(observed);
  assert.equal(requests.length,2);
});

test('screen capture has separate persisted feedback and blocks duplicate starts', () => {
  const progress = {}, buttons = [{}, {}];
  const ctx = vm.createContext({$:()=>progress, document:{querySelectorAll:()=>buttons},
    calibrationMode:st=>st.selection?.mode});
  vm.runInContext(section('function observationFeedback(', 'let clientClickerGeneration'), ctx);
  ctx.st = {running:true,selection:{mode:'observe'},state:{observation:{status:'running',message:'Reading Home'}}};
  vm.runInContext('observationFeedback(st)',ctx);
  assert.match(progress.textContent,/running.*Reading Home/);
  assert.ok(buttons.every(b=>b.disabled));
  ctx.st = {running:false,state:{observation:{status:'done',message:'Captured 2'}}};
  vm.runInContext('observationFeedback(st)',ctx);
  assert.match(progress.textContent,/finished.*Captured 2/);
  assert.ok(buttons.every(b=>!b.disabled));
  ctx.st.state.observation.status = 'running';
  vm.runInContext('observationFeedback(st)',ctx);
  assert.match(progress.textContent,/stopped before completion/);
});

test('the status tick survives a stopped response and a connection failure without rebuilding the form', async () => {
  let ticks = 0, reports = [];
  const requests = [];
  const progress = {};
  const ctx = vm.createContext({LearningStore,learningStatus:()=>ctx.api('/api/calibrate/status'),S:{}, $:key=>key === '#brand-inst' ? null : progress, Promise, Date,
    api:async path=>{ requests.push(path); if (path === '/api/status') return {processes:[]};
      ticks++; if(ticks === 2) throw Error('offline'); return {running:ticks>2}; },
    calibReport:st=>reports.push(st.running),renderWorkspaceStatus:()=>{},calibrationBusy:()=>{},
    applyGate:()=>{},renderBootStatus:()=>{},renderHomeLive:()=>{},refreshWorkspaceStatus:()=>{},
    localStorage:{getItem:()=>null}, pendingPreparation:()=>null,
    learningTracker:()=>({observe:()=>{},unavailable:()=>{}})});
  vm.runInContext(section('async function loadStatus(){', '/* Shared status reads'),ctx);
  vm.runInContext(section('function launchSettled(', 'function renderMappingPlan('),ctx);
  await vm.runInContext('loadStatus()',ctx);
  assert.deepEqual(reports,[false]);
  await vm.runInContext('loadStatus()',ctx);
  assert.match(progress.textContent,/Retrying/);
  await vm.runInContext('loadStatus()',ctx);
  assert.deepEqual(reports,[false,true]);
  // one /api/status and one /api/calibrate/status per tick, nothing else
  assert.deepEqual(requests,Array(3).fill(['/api/status','/api/calibrate/status']).flat());
});

test('a calibration read that overlaps a mutation is discarded by the status tick', async () => {
  let release;
  const reports = [];
  const ctx = vm.createContext({LearningStore,learningStatus:()=>ctx.api('/api/calibrate/status'),S:{workspaceEpoch:0}, $:()=>({}), Promise, Date,
    api:path=>path === '/api/status' ? Promise.resolve({}) : new Promise(resolve=>{release=resolve;}),
    calibReport:st=>reports.push(st),renderWorkspaceStatus:()=>{},calibrationBusy:()=>{},
    applyGate:()=>{},renderBootStatus:()=>{},renderHomeLive:()=>{},refreshWorkspaceStatus:()=>{},
    localStorage:{getItem:()=>null}, pendingPreparation:()=>null,
    learningTracker:()=>({observe:()=>{},unavailable:()=>{}})});
  vm.runInContext(section('async function loadStatus(){', '/* Shared status reads'),ctx);
  vm.runInContext(section('function launchSettled(', 'function renderMappingPlan('),ctx);
  const pending = vm.runInContext('loadStatus()',ctx);
  ctx.S.workspaceEpoch++;
  release({running:false});
  await pending;
  assert.deepEqual(reports,[]);
});

test('selections survive re-render, reload, and switching between accounts', () => {
  const stored = new Map();
  const controls = {'#calib-taps':{checked:true},'#calib-over':{checked:true}};
  const ctx = vm.createContext({S:{config:{active_instance:'main',instances:{main:{account:'alice',serial:'one'}}}},
    $:id=>controls[id],document:{querySelectorAll:()=>[{value:'g'},{value:'w'}]},
    localStorage:{getItem:key=>stored.get(key),setItem:(key,v)=>stored.set(key,v)}});
  vm.runInContext(section('function calibrationPreferences(){','async function renderCalibrate(){'),ctx);
  vm.runInContext('rememberCalibration(); S.calibrationChoices = {};',ctx);
  assert.equal(vm.runInContext('calibrationPreferences().phases.join(",")',ctx),'g,w');
  assert.equal(vm.runInContext('calibrationPreferences().overwrite',ctx),true);
  vm.runInContext('S.config.instances.main.account="bob"',ctx);
  assert.equal(vm.runInContext('calibrationPreferences().phases.join(",")',ctx),'c,m');
  vm.runInContext('S.config.instances.main.account="alice"',ctx);
  assert.equal(vm.runInContext('calibrationPreferences().phases.join(",")',ctx),'g,w');
});


test('saved knowledge stays separate from unchecked next-scan choices and image verification', () => {
  const ctx = vm.createContext({esc:v=>String(v), S:{calibrationChoices:{}}});
  vm.runInContext(section('function calibrationKnowledge(st){', 'async function renderCalibrate(){'),ctx);
  ctx.status = {state:{phases:{global:{status:'done',results:{global_presets:['Example']}}}},
    report:{entries:[{phase:'global',status:'stale',verified:false},{phase:'global',status:'exists'}]}};
  const rendered = vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.match(rendered,/Scanned/);
  assert.match(rendered,/Example/);
  assert.match(rendered,/1 need attention/);
  assert.match(rendered,/1 not yet verified/);
  assert.match(rendered,/Not scanned/);
  assert.doesNotMatch(rendered,/checkbox/);
});


const TAB_NAMES = ['overview','runs','history','schedule','equipment','collection','abilities','profiles','emulators','screens','runtime'];
/* The router section against one link and panel for every flat destination. */
function routerContext(){
  const panels = TAB_NAMES.map(name => ({id:'panel-' + name, hidden:true, innerHTML:''}));
  const tabs = TAB_NAMES.map(name => ({id:'tab-' + name, textContent:name+' icon', dataset:{title:name,description:name + ' description'}, attrs:{'aria-controls':'panel-' + name},
    setAttribute(key, value){ this.attrs[key] = value; }, getAttribute(key){ return this.attrs[key]; }, removeAttribute(key){ delete this.attrs[key]; }}));
  const location = {hash:''}, renders = [], mounts = [], unmounts = [], diagnostics = [];
  const shell = Object.fromEntries(['page-title','page-description','navigation-toggle','app-sidebar','view', 'collection-settings','abilities-settings','runtime-settings','runtime-diagnostics'].map(id => ['#' + id, {id,attrs:{},classList:{toggle(){}},addEventListener(){},getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v}}]));
  const ctx = vm.createContext({S:{status:{setup_complete:true,calibration:{ready:false}}},
    RunWorkspace:{create:()=>({poll(){},history(){}})},api(){},
    DiagnosticsView:{...DiagnosticsView,create:()=>({mount(host,options){diagnostics.push({host:host.id,options})},unmount(){diagnostics.push({unmounted:true})}})},
    $:selector => shell[selector] || panels.find(panel => '#' + panel.id === selector),
    document:{querySelectorAll:selector => selector === '[data-page]' ? tabs : panels},
    location, history:{replaceState:(_a,_b,v)=>location.hash=v}, esc:String,
    settingsWorkspace:{unmount(){unmounts.push(ctx.S.tab)},mountPage(host,options){mounts.push({host:host.id,options:JSON.parse(JSON.stringify(options))})}},
    window:{addEventListener:()=>{}}, syncConnectOverlay:()=>{}, renderStream:()=>{}, openWorkspaceSection:()=>{},
    renderCalibrate:async()=>{renders.push('calibrate')},renderSetup:async()=>{renders.push('setup')},renderHome:async()=>{renders.push('home')},renderWorkspaceStatus:()=>{},
    renderControlBlockers:()=>{},renderGetStarted:()=>{},syncLiveScreen:()=>{},refreshWorkspaceStatus:()=>{}});
  vm.runInContext(section('function calibOk(){','/* ------------------------------------------------- connect overlay'),ctx);
  const go = async hash => { location.hash = hash; await vm.runInContext('route()',ctx); };
  return {ctx, panels, tabs, location, renders, mounts, unmounts, diagnostics, go};
}

test('Dashboard is the landing page, old routes are aliases, and no page is gated on setup_complete', async () => {
  for (const setup_complete of [true,false]) {
    const {ctx, location, renders, go} = routerContext();
    ctx.S.status.setup_complete = setup_complete;
    assert.equal(vm.runInContext('defaultView()',ctx),'overview');
    await go('');
    assert.equal(location.hash,'#overview');
    assert.deepEqual(renders,['home']);
    // each old route lands on its tab and renders that view
    for (const [old, tab, view] of [['#calibrate','#screens','calibrate'],['#setup','#emulators','setup'],['#home','#overview','home'],['#settings','#runtime','home'],['#rewards','#collection','home']]) {
      await go(old);
      assert.equal(location.hash,tab);
      assert.equal(renders.at(-1),view);
    }
    for (const tab of TAB_NAMES.map(name=>'#'+name)) {
      await go(tab);
      assert.equal(location.hash,tab);
    }
    await go('#nowhere');
    assert.equal(location.hash,'#overview');
    assert.equal(renders.at(-1),'home');
  }
  // index.html never reads the setup_complete sentinel
  const script = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotMatch(script,/setup_complete/);
});

test('switching between automation pages shows another panel without rendering again', async () => {
  const {ctx, panels, tabs, renders, go} = routerContext();
  await go('#overview');
  for (const tab of ['runs','schedule','equipment','collection','abilities','runtime','overview']) {
    vm.runInContext('$("#view").scrollTop = 200',ctx);
    await go('#' + tab);
    assert.equal(ctx.S.tab,tab);
    assert.equal(ctx.S.view,'home');
    assert.deepEqual(panels.filter(panel => !panel.hidden).map(panel => panel.id),['panel-' + tab]);
    assert.deepEqual(tabs.filter(t => t.attrs['aria-current'] === 'page').map(t => t.id),['tab-' + tab]);
    assert.equal(ctx.document.title, tab + ' · Tower Pilot');
    assert.equal(vm.runInContext('$("#view").scrollTop',ctx),0);
  }
  assert.deepEqual(renders,['home']);
  // leaving the home view empties its panels (ids stay unique), returning renders it once
  panels[1].innerHTML = '<article id="card-flows"></article>';
  await go('#screens');
  assert.equal(ctx.S.view,'calibrate');
  assert.equal(panels[1].innerHTML,'');
  await go('#schedule');
  assert.deepEqual(renders,['home','calibrate','home']);
});

test('Runtime diagnostic deep links retain exact filters and release the viewer on navigation',async()=>{
  const {location,diagnostics,go}=routerContext();
  const hash='#runtime?battle_id=b%26x&operation_id=op%2F1&offer_id=offer%3A2&since=100';
  await go(hash);
  assert.equal(location.hash,hash);
  assert.equal(diagnostics.at(-1).host,'runtime-diagnostics');
  assert.deepEqual(diagnostics.at(-1).options.filters,{battle_id:'b&x',operation_id:'op/1',offer_id:'offer:2',since:'100'});
  await go('#overview');
  assert.equal(diagnostics.at(-1).unmounted,true);
});

test('sidebar uses native links with one labelled page per destination', () => {
  const nav = html.match(/<nav id="app-navigation"[\s\S]*?<\/nav>/)[0];
  const links = [...nav.matchAll(/<a id="tab-(\w+)" href="#(\w+)" data-page="(\w+)"/g)];
  assert.deepEqual(links.map(t => t[1]),TAB_NAMES);
  for (const [, id, href, page] of links) {
    assert.equal(href,id);
    assert.equal(page,id);
    assert.ok(html.includes(`<section data-page-panel id="panel-${id}" aria-labelledby="tab-${id}"`));
  }
  assert.doesNotMatch(nav, /role="tab|tabindex="-1"/);
  assert.match(nav, /aria-label="Main navigation"/);
  assert.match(html, /id="navigation-toggle"[^>]*aria-controls="app-sidebar"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(html, /id="settings-navigation"/);
  assert.doesNotMatch(html, /<nav class="section-links"/);
});

test('mobile sidebar toggles independently of the current page and closes on navigation', async () => {
  const {ctx, go} = routerContext();
  vm.runInContext('toggleNavigation(true)',ctx);
  assert.equal(vm.runInContext('$("#navigation-toggle").getAttribute("aria-expanded")',ctx),'true');
  await go('#runtime');
  assert.equal(vm.runInContext('$("#navigation-toggle").getAttribute("aria-expanded")',ctx),'false');
  await go('#overview');
  assert.equal(vm.runInContext('$("#navigation-toggle").getAttribute("aria-expanded")',ctx),'false');
});

test('configuration destinations mount only their owned controls and release ownership on navigation', async () => {
  const {go, mounts, unmounts} = routerContext();
  for (const page of ['collection','abilities','runtime']) {
    await go('#'+page);
    const count = mounts.length;
    await go('#'+page);
    assert.equal(mounts.length,count,'same page preserves its mounted editor');
  }
  assert.deepEqual(mounts,[
    {host:'collection-settings',options:{moduleIds:['rewards'],policyModules:['ad','orbit','gather']}},
    {host:'abilities-settings',options:{moduleIds:['global_abilities']}},
    {host:'runtime-settings',options:{moduleIds:['loop','tap','missions','fleet','logging']}}
  ]);
  await go('#screens');
  assert.deepEqual(unmounts,[undefined,'collection','abilities','runtime']);
  await go('#collection');
  assert.equal(mounts.length,4,'returning remounts the released editor');
});

test('leaving Dashboard releases its stream after changing destination and before detaching the panel', async () => {
  const {ctx, panels, go} = routerContext();
  await go('#overview');
  const overview = panels.find(panel=>panel.id === 'panel-overview');
  overview.innerHTML = '<div id="stream-slot"><img src="/api/stream.mjpg"></div>';
  const calls = [];
  ctx.renderStream = () => calls.push({tab:ctx.S.tab, markup:overview.innerHTML});
  await go('#screens');
  assert.equal(calls[0].tab,'screens','cleanup sees the new destination so it stops streaming');
  assert.match(calls[0].markup,/stream\.mjpg/,'old image is still attached when cleanup runs');
  assert.equal(overview.innerHTML,'','panel is detached after cleanup');
});

test('progress counts completed and skipped steps, retains history, and escapes game text',()=>{
  const ctx=vm.createContext({WorkspaceStatus,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')});
  vm.runInContext(section('function scanTimelineHTML(', 'function renderScanTimeline('),ctx);
  ctx.record={status:'running',message:'Reading <name>',steps:[
    {id:'a',label:'Home',status:'done'}, {id:'b',label:'Guild',status:'skipped'},
    {id:'c',label:'Modules',status:'running'}, {id:'d',label:'Save',status:'pending'}
  ],history:[{at:1,message:'Home verified'},{at:2,message:'Read <script>'}]};
  const html=vm.runInContext('scanTimelineHTML(record,true)',ctx);
  assert.match(html,/value="2" max="4"/);
  assert.match(html,/aria-current="step"/);
  assert.match(html,/1 skipped/);
  assert.match(html,/Home verified/);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>/);
  const interrupted=vm.runInContext('scanTimelineHTML(record,false)',ctx);
  assert.match(interrupted,/Stopped before completion/);
  assert.doesNotMatch(interrupted,/aria-current="step"/);
  assert.match(interrupted,/scan-step-stopped/);
});

test('old scan reports do not invent a detailed step history',()=>{
  const ctx=vm.createContext({WorkspaceStatus,esc:String});
  vm.runInContext(section('function scanTimelineHTML(', 'function renderScanTimeline('),ctx);
  const html=vm.runInContext('scanTimelineHTML({status:"done",completed:16,total:16})',ctx);
  assert.match(html,/next scan/);
  assert.doesNotMatch(html,/<progress/);
});

test('basic scan uses actual phase history and ignores previous starter activity',()=>{
  const ctx=vm.createContext({});
  vm.runInContext(section('function calibrationMode(', 'function calibReport('),ctx);
  ctx.st={running:true,selection:{mode:'basic',phases:['c','m']},state:{phases:{cards:{status:'done',started_at:1,finished_at:3},modules:{status:'running',started_at:4},bootstrap:{status:'done'}}},activity:{kind:'calibrate_cut',name:'Example'}};
  const p=vm.runInContext('basicScanProgress(st)',ctx);
  assert.equal(p.steps.length,2);
  assert.equal(p.active_step,'modules');
  assert.equal(p.history.length,3);
  assert.equal(p.message,'Checking Example');
});

test('an identical account-scan timeline is drawn again after an observe tick cleared the element',()=>{
  const timeline={dataset:{}, querySelector:()=>null, querySelectorAll:()=>[], innerHTML:''};
  const element=()=>({dataset:{}, querySelector:()=>null, querySelectorAll:()=>[], textContent:''});
  const slots={'#calib-report':element(), '#calib-phase2':element(), '#calib-timeline':timeline};
  const ctx=vm.createContext({WorkspaceStatus, S:{}, esc:String, Date, $:key=>slots[key] || null,
    renderWorkspaceStatus:()=>{}, calibrationBusy:()=>{}, observationFeedback:()=>{}, renderCalibrationIntent:()=>{},
    updateWorkspaceRegion:()=>{}, assetLibraryHTML:()=>'', calibrationKnowledge:()=>'', api:async()=>({}), renderScanPlan:()=>{}});
  vm.runInContext(section('function scanTimelineHTML(', 'function assetLibraryHTML('),ctx);
  vm.runInContext(section('function calibrationMode(', 'function calibrationBusy('),ctx);
  const basic={running:true, selection:{mode:'basic', phases:['c']}, state:{phases:{cards:{status:'running', started_at:4}}}};
  vm.runInContext('S.previewUpdatedAt=Date.now()',ctx);
  ctx.st=basic;
  vm.runInContext('calibReport(st)',ctx);
  const drawn=timeline.innerHTML;
  assert.match(drawn,/Account scan/);
  ctx.st={running:false, selection:{mode:'observe', phases:['c']}, state:{}};
  vm.runInContext('calibReport(st)',ctx);
  assert.equal(timeline.innerHTML,'');
  ctx.st=basic;                                   // the same scan again: its timeline must be drawn, not skipped as unchanged
  vm.runInContext('calibReport(st)',ctx);
  assert.equal(timeline.innerHTML,drawn);
});

test('asset summary separates extracted artwork, mappings, and verified screen appearances',()=>{
  const ctx=vm.createContext({esc:s=>String(s).replaceAll('<','&lt;'), rowState:()=>'', artPair:()=>''});
  vm.runInContext(section('function assetLibraryHTML(', 'function calibrationMode('),ctx);
  ctx.assets={version:'1',images:120,unique_images:100,mapped:4,verified:1,empty_placeholders:2,targets:[{rel:'home/icon.png',names:['Icon'],verification:'pending'}]};
  const html=vm.runInContext('assetLibraryHTML(assets)',ctx);
  assert.match(html,/120 image objects extracted/);
  assert.match(html,/4 manifest targets mapped/);
  assert.match(html,/1 verified on screen/);
  assert.match(html,/empty texture placeholders/);
  assert.match(html,/Awaiting screen verification/);
});

test('card inventory count is independent of preset and reference counts', () => {
  const ctx=vm.createContext({esc:v=>String(v)});
  vm.runInContext(section('function calibrationKnowledge(st){','async function renderCalibrate(){'),ctx);
  ctx.status={state:{phases:{cards:{status:'done',results:{names:['First','Second']}}}},
    report:{entries:[]},card_manifest:{complete:true,cards:Array.from({length:35},(_,i)=>({name:'Card '+(i+1)}))}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.match(rendered,/35 cards identified · full inventory verified · 2 presets/);
  assert.match(rendered,/Card 35/);
});

test('card inventory surfaces active and mastery counts and per-card marks', () => {
  const ctx=vm.createContext({esc:v=>String(v)});
  vm.runInContext(section('function calibrationKnowledge(st){','async function renderCalibrate(){'),ctx);
  ctx.status={state:{phases:{cards:{status:'done',results:{names:['P1']}}}},
    report:{entries:[]},card_manifest:{complete:true,active:22,mastered:5,
      cards:[{name:'Damage'},{name:'Nuke',active:true},{name:'Intro Sprint',active:true,mastery:true}]}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.match(rendered,/3 cards identified · full inventory verified · 1 presets · 22 active · 5 mastered/);
  const cells=gridCells(rendered);
  assert.deepEqual(cells.map(c=>c.name),['Damage','Nuke','Intro Sprint']);
  assert.deepEqual(cells.map(c=>c.marks),[[],['active'],['active','mastered']]);
});

/* The rendered <li> cells of the know-grid lists in `rendered`: name, tinted flag and aria-labelled marks. */
function gridCells(rendered){
  return [...rendered.matchAll(/<li( class="on")? title="([^"]*)"><span class="know-name">([^<]*)<\/span>(?:<span class="know-marks">(.*?)<\/span><\/span>)?<\/li>/g)]
    .map(m=>({on:!!m[1], name:m[3], marks:[...(m[4]||'').matchAll(/aria-label="(\w+)"/g)].map(x=>x[1])}));
}
/* The page's own esc() and calibrationKnowledge, so an esc() change reaches these tests. */
function knowledgeContext(){
  const ctx=vm.createContext({});
  vm.runInContext(section('function esc(s){','\n\n'),ctx);
  vm.runInContext(section('function calibrationKnowledge(st){','async function renderCalibrate(){'),ctx);
  return ctx;
}
/* The declaration block of the page's CSS rule whose selector is exactly `selector` (whitespace-collapsed). */
function cssRule(selector){
  const m=html.match(new RegExp('(?:^|[}\\n])\\s*'+selector.replace(/[.[\]()=*]/g,'\\$&')+'\\s*\\{([^}]*)\\}'));
  if(!m) throw new Error('css rule not found: '+selector);
  return m[1].replace(/\s+/g,' ');
}
/* The user's saved card list, in order; the names ending in ✓ are active. There is no mastery in it. */
const USER_CARDS='Damage✓|Attack Speed✓|Health✓|Health Regen|Range|Cash✓|Coins✓|Slow Aura✓|Critical Chance✓|Enemy Balance✓|Extra Defense✓|Fortress|Free Upgrades✓|Extra Orb✓|Plasma Cannon✓|Critical Coin✓|Wave Skip✓|Intro Sprint|Land Mine Stun✓|Recovery Package Chance✓|Cells✓|Death Ray✓|Energy Net|Super Tower|Second Wind✓|Demon Mode|Energy Shield|Wave Accelerator✓|Berserker|Ultimate Crit|Nuke';
const USER_CARD_LIST=USER_CARDS.split('|')
  .map(s=>s.endsWith('✓')?{name:s.slice(0,-1),active:true}:{name:s});

test('the 31-card sample renders as an ordered grid with 20 active cells and a counts line', () => {
  const ctx=knowledgeContext();
  assert.equal(USER_CARD_LIST.length,31);
  ctx.status={state:{phases:{cards:{status:'done',results:{names:['A','B','C','D','E']}}}},
    report:{entries:[]},card_manifest:{complete:true,cards:USER_CARD_LIST}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.match(rendered,/<div class="muted">31 cards identified · full inventory verified · 5 presets · 20 active<\/div>/);
  assert.doesNotMatch(rendered,/· \d+ mastered/);
  const cells=gridCells(rendered);
  assert.deepEqual(cells.map(c=>c.name),USER_CARD_LIST.map(c=>c.name));
  assert.equal(cells.filter(c=>c.on).length,20);
  assert.ok(cells.every(c=>c.on===c.marks.includes('active')&&!c.marks.includes('mastered')));
  assert.match(rendered,/<div class="muted">✓ active · ★ mastered<\/div><ul class="know-grid">/);
  assert.doesNotMatch(rendered,/Damage ✓|, Attack Speed/);
});

test('a card name is escaped, never injected as markup', () => {
  const ctx=knowledgeContext();
  ctx.status={state:{phases:{cards:{status:'done',results:{names:[]}}}},report:{entries:[]},
    card_manifest:{complete:true,cards:[{name:'<img onerror=x>',active:true}]}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.doesNotMatch(rendered,/<img/);
  assert.equal(gridCells(rendered)[0].name,'&lt;img onerror=x&gt;');
});

test('a card that is both active and mastered shows both marks', () => {
  const ctx=knowledgeContext();
  ctx.status={state:{phases:{cards:{status:'done',results:{names:[]}}}},report:{entries:[]},
    card_manifest:{complete:true,cards:[{name:'Intro Sprint',active:true,mastery:true},{name:'Wave Skip',mastery:true}]}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.deepEqual(gridCells(rendered).map(c=>c.marks),[['active','mastered'],['mastered']]);
  assert.deepEqual(gridCells(rendered).map(c=>c.on),[true,false]);
  assert.match(rendered,/1 active · 2 mastered/);
});

test('zero cards renders the counts line and no empty grid or legend', () => {
  const ctx=knowledgeContext();
  ctx.status={state:{phases:{cards:{status:'done',results:{names:[]}}}},report:{entries:[]},card_manifest:{complete:false,cards:[]}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.match(rendered,/0 cards identified · full inventory not yet confirmed · 0 presets/);
  assert.doesNotMatch(rendered,/know-grid|active · ★ mastered/);
});

test('other feature name lists use the same grid without marks', () => {
  const ctx=knowledgeContext();
  ctx.status={state:{phases:{global:{status:'done',results:{global_presets:['Farm','Boss']}},
      guardians:{status:'done',results:{guardians:['Chrono']}},modules:{status:'done'}}},
    report:{entries:[],player:{}}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  const cells=gridCells(rendered);
  assert.deepEqual(cells.map(c=>c.name),['Farm','Boss','Chrono']);
  assert.ok(cells.every(c=>!c.on&&c.marks.length===0));
  assert.doesNotMatch(rendered,/active · ★ mastered/);
  assert.doesNotMatch(rendered,/Farm, Boss/);
});

test('bots, workshop presets and the cards_observed fallback use the same grid', () => {
  const ctx=knowledgeContext();
  ctx.status={state:{phases:{bots:{status:'done'},workshop:{status:'done'},cards:{status:'done'}}},
    report:{entries:[],player:{category_presets:{bots:['Bot A'],workshop:['Shop A','Shop B']},
      cards_observed:[{name:'Seen',active:true}]}}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.deepEqual(gridCells(rendered).map(c=>[c.name,c.on]),[['Seen',true],['Bot A',false],['Shop A',false],['Shop B',false]]);
});

test('a scanned Modules row stays a sentence: its preset tabs are not rendered as a grid', () => {
  const ctx=knowledgeContext();
  ctx.status={state:{phases:{modules:{status:'done',results:{preset_tabs:['Tab One']}}}},
    report:{entries:[],player:{category_presets:{modules:['Tab Two']}}}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.match(rendered,/Full inventory not yet confirmed; 0 equipped; 0 inventory copies recorded/);
  assert.doesNotMatch(rendered,/know-grid|Tab One|Tab Two/);
});

test('a quote in a name is escaped in the title attribute and the text', () => {
  const ctx=knowledgeContext();
  ctx.status={state:{phases:{cards:{status:'done',results:{names:[]}}}},report:{entries:[]},
    card_manifest:{complete:true,cards:[{name:'" onmouseover="alert(1)'}]}};
  const rendered=vm.runInContext('calibrationKnowledge(status)',ctx);
  assert.doesNotMatch(rendered,/onmouseover="/);
  assert.match(rendered,/<li title="&quot; onmouseover=&quot;alert\(1\)"><span class="know-name">&quot; onmouseover=&quot;alert\(1\)<\/span><\/li>/);
});

test('the grid takes no width from its content, so a long name cannot widen the table past a phone screen', () => {
  // A table cell never shrinks below its content's min-content width; a nowrap name made the grid
  // (and so the Screens table) wider than a 375 px viewport. width:0 + min-width:100% lets the grid
  // contribute nothing to that width and then fill the cell.
  const rule=cssRule('.know-grid');
  assert.match(rule,/(^|[ ;])width: ?0\b/);
  assert.match(rule,/min-width: ?100%/);
});

test('mark glyphs sit in fixed slots: the check always in the first, the star in the second', () => {
  // With flex-end packing a lone check sat where the star goes once any card was mastered.
  assert.match(cssRule('.know-marks'),/display: ?grid/);
  assert.match(cssRule('.know-marks'),/grid-template-columns: ?repeat\(2,/);
  assert.match(cssRule('.know-marks [aria-label=active]'),/grid-column: ?1/);
  assert.match(cssRule('.know-marks [aria-label=mastered]'),/grid-column: ?2/);
});

test('starter scan consent gate posts flows=true on OK and flows=false on Cancel', async () => {
  const run = async (confirmReturns) => {
    let body = null;
    const progress = {};
    const ctx = vm.createContext({
      LearningStore, crypto:{randomUUID:()=>'test-request'}, startCalibrationOperation:(path,body)=>ctx.post(path,body), S:{}, window:{confirm:()=>confirmReturns}, Date:{now:()=>1},
      rememberCalibration:()=>{}, calibrationBusy:()=>{}, pollCalibrate:()=>{},
      toast:()=>{},
      $:id=> id==='#bootstrap-progress' ? progress : {checked:false},
      post:async(url,b)=>{ body=b; return {}; },
    });
    vm.runInContext(section('async function startBootstrap(){', 'async function startCalibrate('), ctx);
    await vm.runInContext('startBootstrap()', ctx);
    return body;
  };
  const ok = await run(true);
  assert.equal(ok.bootstrap, true);
  assert.equal(ok.flows, true);
  const cancelled = await run(false);
  assert.equal(cancelled.bootstrap, true);
  assert.equal(cancelled.flows, false);
});
