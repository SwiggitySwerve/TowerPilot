const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const WorkspaceStatus = require('../webui/workspace-status.js');
const LearningView = require('../webui/learning-view.js');
const LearningStore = require('../webui/learning-store.js');
const {html, section} = require('./helpers.cjs');

test('running mapping exposes the real current and next step without treating attention as success', () => {
  const record = {status:'running', started_at:100, updated_at:145, message:'Reading modules', steps:[
    {id:'preflight',label:'Check emulator',status:'done'},
    {id:'extract',label:'Extract artwork',status:'skipped'},
    {id:'map',label:'Map artwork',status:'needs_attention'},
    {id:'route_1',label:'Modules',status:'running'},
    {id:'finish',label:'Verify and save',status:'pending'},
  ]};
  const model = WorkspaceStatus.operation({record,running:true,now:160,checkedAt:159});
  assert.equal(model.elapsed,'1m 0s');
  assert.equal(model.workerAge,'15s ago');
  assert.equal(model.checkedAge,'1s ago');
  assert.equal(model.processed,3);
  assert.equal(model.done,1);
  assert.equal(model.attention,1);
  assert.equal(model.current.label,'Modules');
  assert.equal(model.next.label,'Verify and save');
  const output = WorkspaceStatus.operationHTML(model);
  assert.match(output,/1 successful.*1 skipped.*1 need attention/);
  assert.match(output,/Next step:<\/b> Verify and save/);
  assert.doesNotMatch(output,/ETA|ready to run/i);
});

test('saved running state is stopped when no worker is present and its duration does not keep increasing', () => {
  const record={status:'running',started_at:100,updated_at:135,steps:[{id:'extract',label:'Extract',status:'running'}]};
  const before=WorkspaceStatus.operation({record,running:false,now:200});
  const later=WorkspaceStatus.operation({record,running:false,now:500});
  assert.equal(before.state,'stopped');
  assert.equal(before.steps[0].status,'stopped');
  assert.equal(before.elapsed,later.elapsed);
  assert.equal(before.elapsed,'35s');
  assert.match(before.headline,/Last screen learning result/);
});

test('offline snapshots are labelled last known and elapsed stops at the last browser check', () => {
  const record={status:'running',started_at:100,updated_at:130,steps:[]};
  const model=WorkspaceStatus.operation({record,running:true,checkedAt:140,now:200,unavailable:'Network down'});
  assert.equal(model.elapsed,'40s');
  assert.match(model.headline,/Last known:/);
  assert.match(WorkspaceStatus.operationHTML(model),/Status unavailable.*Network down/);
});

test('restoration pending remains visible even after an otherwise completed mapping', () => {
  const model=WorkspaceStatus.operation({record:{status:'done'},running:false,restorePending:true});
  assert.equal(model.state,'needs_attention');
  assert.match(model.headline,/restoration pending/);
  assert.match(model.guidance,/restoration details/);
});

test('a saved failure with no detailed steps keeps its exact error and does not invent progress', () => {
  const model=WorkspaceStatus.operation({record:{status:'error',message:'Display setup failed: timed out',total:0},running:false});
  const output=WorkspaceStatus.operationHTML(model);
  assert.equal(model.state,'error');
  assert.match(output,/Display setup failed: timed out/);
  assert.doesNotMatch(output,/<progress|1 steps|0 of 1/);
});

test('phases come only from recorded IDs and untrusted worker text is escaped', () => {
  const model=WorkspaceStatus.operation({record:{status:'running',message:'<script>bad</script>',steps:[{id:'extract',label:'<Artwork>',status:'running'}]},running:true});
  assert.deepEqual(model.phases.map(phase=>phase.id),['artwork']);
  const output=WorkspaceStatus.operationHTML(model);
  assert.match(output,/&lt;script&gt;/);
  assert.doesNotMatch(output,/<script>/);
});

test('a configured connection does not satisfy live reachability, and there is no Screen check stage', () => {
  const output=WorkspaceStatus.stagesHTML({tools:{installed:true},accounts:{active:'one'},
    config:{active_instance:'main',instances:{main:{serial:'127.0.0.1:16384'}}},
    status:{connected:false,calibration:{ready:true}},
    wizard:{resolution:{ok:true,serial:'127.0.0.1:16384',width:1080,height:1920}}});
  assert.match(output,/2 of 4 checks satisfied/);
  assert.match(output,/currently not reachable/);
  assert.doesNotMatch(output,/Screen check|setup-screen/);
  // calibration.ready is not "screens learned"; only a ready run is
  assert.match(output,/Learn screens from Overview/);
  const learned=WorkspaceStatus.stagesHTML({tools:{installed:true},accounts:{active:'one'},
    config:{active_instance:'main',instances:{main:{serial:'s'}}},status:{device_state:'device'},readiness:{bp_farm:{ready:true}}});
  assert.match(learned,/4 of 4 checks satisfied/);
  assert.match(learned,/Setup done/);
});

test('context counts only explicitly checked individual runs and excludes the day plan', () => {
  const accounts={active:'one',accounts:[{id:'one',label:'<Profile>'}]};
  const output=WorkspaceStatus.contextHTML({runs:{farm:{},shard:{},combo:{}},readiness:{farm:{ready:true},combo:{ready:true}},
    accounts,status:{connected:false,processes:[]}});
  assert.match(output,/1 of 2 ready/);
  assert.match(output,/Some readiness checks unavailable/);
  assert.match(output,/Not reachable/);
  // the profile name moved to the header; the summary no longer repeats it or links to Settings
  assert.doesNotMatch(output,/Profile|role="button"/);
  assert.match(WorkspaceStatus.headerHTML({accounts,status:{connected:false,processes:[]}}),/<span class="header-profile">&lt;Profile&gt;<\/span>/);
});

test('workspace refresh performs only status reads and never applies or launches calibration', async () => {
  const calls=[];
  const ctx=vm.createContext({S:{view:'setup'},Date,
    api:async path=>{calls.push(path);return path==='/api/runs'?{runs:{},readiness:{}}:{};},
    renderWorkspaceStatus:()=>{},post:()=>{throw Error('Unexpected mutation');}});
  vm.runInContext(section('async function refreshWorkspaceStatus(){','function openWorkspaceSection('),ctx);
  await vm.runInContext('refreshWorkspaceStatus()',ctx);
  // calibration status belongs to the 2.5 s status tick, not this slow-data read
  assert.deepEqual(calls,['/api/config','/api/accounts','/api/runs','/api/wizard/tools','/api/wizard/state']);
  assert.equal(ctx.S.workspaceLoading,false);
});

test('a workspace refresh failure keeps the last snapshot instead of declaring an idle operation', async () => {
  const snapshot={calibration:{running:true},checkedAt:100};
  const ctx=vm.createContext({S:{view:'setup',workspace:snapshot},Date,
    api:async()=>{throw Error('offline');},renderWorkspaceStatus:()=>{}});
  vm.runInContext(section('async function refreshWorkspaceStatus(){','function openWorkspaceSection('),ctx);
  await vm.runInContext('refreshWorkspaceStatus()',ctx);
  assert.equal(ctx.S.workspace,snapshot);
  assert.equal(ctx.S.workspace.calibration.running,true);
  assert.equal(ctx.S.workspaceError,'offline');
});

test('a context-changing mutation discards in-flight workspace responses', async () => {
  let release;
  const snapshot={accounts:{active:'bob'}};
  const ctx=vm.createContext({S:{view:'setup',workspace:snapshot,workspaceEpoch:0},Date,
    api:path=>path==='/api/config' ? new Promise(resolve=>{release=resolve;}) : Promise.resolve({}),
    renderWorkspaceStatus:()=>{}});
  vm.runInContext(section('async function refreshWorkspaceStatus(){','function openWorkspaceSection('),ctx);
  const pending=vm.runInContext('refreshWorkspaceStatus()',ctx);
  ctx.S.workspaceEpoch++;
  release({active_instance:'alice'});
  await pending;
  assert.equal(ctx.S.workspace,snapshot);
  assert.equal(ctx.S.workspace.accounts.active,'bob');
});

test('the most recent stopped operation takes precedence over historical full mapping', () => {
  const st={running:false,state:{phases:{bootstrap:{status:'done',updated_at:100}},observation:{status:'done',t:300}}};
  const basic={status:'done',finished_at:200};
  assert.equal(WorkspaceStatus.selectOperation(st,basic).mode,'observe');
  delete st.state.observation;
  assert.equal(WorkspaceStatus.selectOperation(st,basic).mode,'basic');
  st.running=true; st.selection={mode:'bootstrap'};
  assert.equal(WorkspaceStatus.selectOperation(st,basic).mode,'bootstrap');
});

test('game requirements distinguish configuration, connection and screen learning', () => {
  assert.match(WorkspaceStatus.requirementHTML('tools'),/Game not needed.*emulator can be closed/);
  assert.match(WorkspaceStatus.requirementHTML('profile'),/Game not needed/);
  assert.match(WorkspaceStatus.requirementHTML('connection'),/Emulator required.*Tower can be closed/);
  assert.match(WorkspaceStatus.requirementHTML('mapping'),/Game required while screens are learned.*Do not close the emulator/);
  assert.match(WorkspaceStatus.requirementHTML('configuration'),/Game not needed/);
  assert.match(WorkspaceStatus.requirementHTML('observe'),/Game required.*does not tap/);
});

const instConfig = (extra={}) => ({active_instance:'main',instances:{main:{serial:'127.0.0.1:16384',label:'My Tower',...extra}}});
const statusWith = (device_state, extra={}) => ({device_state, port_open:true, connected:device_state === 'device', processes:[], ...extra});

test('the banner reports what adb sees for every device_state, never port reachability', () => {
  const expected = {
    device:/Online/, offline:/Emulator offline[\s\S]*Android isn&#39;t answering/, unauthorized:/Not authorized/,
    missing:/Not found by adb/, no_server:/adb server not running/, unconfigured:/Not configured/, unknown:/Not confirmed/,
  };
  for (const [state, label] of Object.entries(expected)) {
    const output = WorkspaceStatus.contextHTML({config:instConfig(), status:statusWith(state)});
    const header = WorkspaceStatus.headerHTML({config:instConfig(), status:statusWith(state)});
    assert.match(output, label, state);
    assert.match(header, new RegExp(`<span>${WorkspaceStatus.connectionState(statusWith(state)).label}</span>`), state);
    assert.doesNotMatch(output + header, /Port reachable/, state);
    // the header pill offers Reconnect unless adb reports the device or no emulator is configured;
    // the summary never repeats it
    assert.equal(/onclick="reconnect\(this\)"/.test(header), !['device','unconfigured'].includes(state), state);
    assert.doesNotMatch(output, /reconnect\(/, state);
  }
  for (const html of [WorkspaceStatus.contextHTML({config:instConfig(), status:statusWith('unconfigured')}),
                      WorkspaceStatus.headerHTML({config:instConfig(), status:statusWith('unconfigured')})])
    assert.match(html, /<a href="#emulators" data-workspace-section="setup-connection">Choose emulator<\/a>/);
  // an unrecognised state is not promoted to Online
  assert.match(WorkspaceStatus.contextHTML({config:instConfig(), status:statusWith('sideways')}), /Not confirmed/);
  assert.match(WorkspaceStatus.headerHTML({config:instConfig(), status:statusWith('sideways')}), /dot bad[\s\S]*Not confirmed/);
  assert.match(WorkspaceStatus.headerHTML({config:instConfig(), status:statusWith('device')}), /dot ok[\s\S]*Online/);
});

test('a status without device_state falls back to connected but is never labelled Online', () => {
  const up = WorkspaceStatus.connectionState({connected:true});
  assert.equal(up.online, true);
  assert.equal(up.verified, false);
  assert.equal(up.label, 'Not confirmed');
  assert.equal(WorkspaceStatus.connectionState({connected:false}).online, false);
  assert.equal(WorkspaceStatus.connectionState(null).label, 'Not checked');
  assert.doesNotMatch(WorkspaceStatus.contextHTML({config:instConfig(), status:{connected:true,processes:[]}}), /Online|Port reachable/);
});

test('an automatic reconnect in progress replaces the adb wording; gave_up, idle and older payloads keep it', () => {
  const reconnect = (state, extra={}) => ({reconnect:{state, attempts:0, next_try_in:null, last_error:'', ...extra}});
  const trying = statusWith('missing', reconnect('trying', {attempts:3, next_try_in:4.2, last_error:'<cannot connect>'}));
  const header = WorkspaceStatus.headerHTML({config:instConfig(), status:trying});
  assert.match(header, /dot bad[\s\S]*<span>Reconnecting to the emulator\.\.\. \(attempt 3\)<\/span>/);
  assert.doesNotMatch(header, /Not found by adb/);
  assert.match(header, /onclick="reconnect\(this\)"/);   // an immediate manual attempt stays available
  const context = WorkspaceStatus.contextHTML({config:instConfig(), status:trying});
  assert.match(context, /Reconnecting to the emulator\.\.\. \(attempt 3\)/);
  assert.doesNotMatch(context, /next attempt in/);   // the countdown is not shown: it would rewrite the card on every tick
  assert.match(context, /&lt;cannot connect&gt;/);
  assert.match(WorkspaceStatus.stagesHTML({tools:{installed:true},accounts:{active:'one'},config:instConfig(),status:trying}),
    /○<\/span><b>Emulator connection<\/b><small>Reconnecting to the emulator\.\.\. \(attempt 3\)/);
  assert.match(WorkspaceStatus.screenPlaceholderHTML(trying), /Reconnecting to the emulator/);
  const conn = WorkspaceStatus.connectionState(trying);
  assert.equal(conn.online, false);
  assert.equal(conn.key, 'missing');
  // before the first attempt: no attempt number
  assert.equal(WorkspaceStatus.connectionState(statusWith('offline', reconnect('trying'))).label, 'Reconnecting to the emulator...');
  // gave_up, idle and a payload without the key all read exactly as today
  const plain = statusWith('missing');
  for (const status of [statusWith('missing', reconnect('gave_up', {attempts:5, last_error:'refused'})), statusWith('missing', reconnect('idle'))]) {
    assert.equal(WorkspaceStatus.headerHTML({config:instConfig(), status}), WorkspaceStatus.headerHTML({config:instConfig(), status:plain}));
    assert.equal(WorkspaceStatus.contextHTML({config:instConfig(), status}), WorkspaceStatus.contextHTML({config:instConfig(), status:plain}));
  }
  assert.match(WorkspaceStatus.headerHTML({config:instConfig(), status:plain}), /Not found by adb[\s\S]*onclick="reconnect\(this\)"/);
  // an online device is Online whatever the reconnect record says
  assert.equal(WorkspaceStatus.connectionState(statusWith('device', reconnect('trying', {attempts:2}))).label, 'Online');
});

test('a Start blocker sentence never doubles the full stop after an ellipsis label', () => {
  const text = status => WorkspaceStatus.startBlockers({status, config:instConfig({allow_taps:true})})[0].text;
  const trying = attempts => statusWith('missing', {reconnect:{state:'trying', attempts, next_try_in:null, last_error:''}});
  assert.equal(text(trying(0)).startsWith('Emulator: Reconnecting to the emulator... Start the emulator, then Reconnect.'), true, text(trying(0)));
  assert.doesNotMatch(text(trying(0)), /\.{4}/);
  assert.equal(text(trying(2)).startsWith('Emulator: Reconnecting to the emulator... (attempt 2). Start the emulator'), true, text(trying(2)));
  assert.equal(text(statusWith('missing')).startsWith('Emulator: Not found by adb. Start the emulator'), true, text(statusWith('missing')));
});

const STATES = ['offline', 'unauthorized', 'missing', 'no_server', 'unconfigured', 'unknown'];
const regions = (status, config = instConfig({allow_taps:true})) => ({
  header:WorkspaceStatus.headerHTML({config, status}),
  context:WorkspaceStatus.contextHTML({config, status}),
  stages:WorkspaceStatus.stagesHTML({tools:{installed:true}, accounts:{active:'one'}, config, status}),
  placeholder:WorkspaceStatus.screenPlaceholderHTML(status),
  blockers:JSON.stringify(WorkspaceStatus.startBlockers({status, config})),
  control:WorkspaceStatus.controlBlockersHTML({status, config}),
  started:WorkspaceStatus.getStartedHTML(WorkspaceStatus.getStarted({tools:{installed:true}, accounts:{active:'one'}, config, status}))});

test('an automatic reconnect keeps the fix the user can act on for every non-device state', () => {
  for (const state of STATES) {
    const plain = WorkspaceStatus.connectionState(statusWith(state));
    const trying = WorkspaceStatus.connectionState(statusWith(state, {reconnect:{state:'trying', attempts:1, next_try_in:5, last_error:'device ' + state + ' after recovery'}}));
    assert.ok(trying.hint.startsWith(plain.hint), state + ': ' + trying.hint);
    assert.match(trying.hint, /etrying automatically\. Last error: device \w+ after recovery$/, state);
    assert.equal(trying.label, 'Reconnecting to the emulator... (attempt 1)', state);
  }
  const unauthorized = statusWith('unauthorized', {reconnect:{state:'trying', attempts:1, next_try_in:5, last_error:''}});
  assert.match(WorkspaceStatus.startBlockers({status:unauthorized, config:instConfig({allow_taps:true})})[0].text, /Accept the USB debugging prompt inside the emulator, then Reconnect\./);
});

test('a gave_up, idle or absent reconnect record leaves every region exactly as an older payload renders it', () => {
  for (const state of [...STATES, 'device']) for (const processes of [[], [{pid:1, runner:'main'}]]) {
    const plain = regions(statusWith(state, {processes}));
    for (const record of [{state:'gave_up', attempts:10, next_try_in:null, last_error:'refused'}, {state:'idle', attempts:0, next_try_in:null, last_error:''}])
      assert.deepEqual(regions(statusWith(state, {processes, reconnect:record})), plain, state + ' ' + record.state + ' runner ' + processes.length);
  }
});

test('a reconnect record never lets an unescaped last_error into any region', () => {
  const status = statusWith('missing', {reconnect:{state:'trying', attempts:2, next_try_in:5, last_error:'<img src=x onerror=1>'}});
  const out = regions(status);
  delete out.blockers;   // plain sentences; control and started escape them into markup
  for (const [name, markup] of Object.entries(out)) assert.doesNotMatch(markup, /<img/, name);
  assert.match(out.header, /&lt;img src=x onerror=1&gt;/);
});

test('with a runner alive the dashboard still reconnects a stopped adb server, and the header only shows a disabled Reconnect', () => {
  const status = statusWith('no_server', {processes:[{pid:1, runner:'main'}], reconnect:{state:'trying', attempts:1, next_try_in:null, last_error:''}});
  const header = WorkspaceStatus.headerHTML({config:instConfig(), status});
  assert.match(header, /Reconnecting to the emulator\.\.\. \(attempt 1\)/);
  assert.match(header, /<button class="small ghost" disabled/);
  assert.doesNotMatch(header, /onclick="reconnect/);
});

/* The header over the real reconnect(), updateWorkspaceRegion() and renderWorkspaceStatus(): every write of
   #header-status makes a new button node, as innerHTML does; `posts` counts POST /api/wizard/reconnect. */
function reconnectPage(status) {
  const header = {_html:'', set innerHTML(v) { this._html = v; this.button = {disabled:/<button[^>]* disabled/.test(v), textContent:'Reconnect', isConnected:true}; if (this.old) this.old.isConnected = false; this.old = this.button; },
    get innerHTML() { return this._html; }};
  const page = {header, posts:0, release:null};
  const ctx = vm.createContext({WorkspaceStatus, $:key => key === '#header-status' ? header : null, toast() {}, document:{},
    post:() => { page.posts++; return new Promise((resolve, reject) => { page.release = resolve; page.fail = reject; }); },
    loadStatus:async () => vm.runInContext('renderWorkspaceStatus()', ctx),   // the real one ends by rendering the workspace status
    workspaceOperation:() => WorkspaceStatus.operation({record:null}),
    S:{workspace:{config:instConfig(), accounts:{}}, workspaceError:'', statusError:'', status}});
  vm.runInContext(section('function updateWorkspaceRegion(', '/* Slow-changing workspace data'), ctx);
  vm.runInContext(section('async function reconnect(btn){', '/* ====='), ctx);
  vm.runInContext('renderWorkspaceStatus()', ctx);
  page.ctx = ctx;
  return page;
}
const trying = attempts => statusWith('missing', {reconnect:{state:'trying', attempts, next_try_in:null, last_error:'e'}});

test('a status tick that rewrites the header while Reconnect is in flight offers no second Reconnect until the POST settles', async () => {
  const page = reconnectPage(trying(3));
  page.ctx.btn = page.header.button;
  const running = vm.runInContext('reconnect(btn)', page.ctx);
  page.ctx.S.status = trying(4);                       // the attempt count is in the label: this tick rewrites the header
  vm.runInContext('renderWorkspaceStatus()', page.ctx);
  assert.notEqual(page.header.button, page.ctx.btn);   // the clicked node was replaced...
  assert.equal(page.header.button.disabled, true);     // ...by a disabled one
  assert.doesNotMatch(page.header.innerHTML, /onclick="reconnect/);
  assert.equal(page.posts, 1);
  page.release({message:'connected'});
  await running;
  assert.match(page.header.innerHTML, /onclick="reconnect\(this\)"/);   // settled: offered again
  assert.equal(page.header.button.disabled, false);
});

test('a Reconnect that settles with no tick between re-enables the clicked button', async () => {
  const page = reconnectPage(trying(3));
  const clicked = page.header.button;
  page.ctx.btn = clicked;
  const running = vm.runInContext('reconnect(btn)', page.ctx);
  assert.equal(clicked.disabled, true);
  page.release({message:'connected'});
  await running;
  assert.equal(page.header.button, clicked);
  assert.equal(clicked.disabled, false);
  assert.equal(clicked.textContent, 'Reconnect');
});

for (const message of ['Stop running automation first; reconnecting can drop its connection.', 'adb connect failed', 'HTTP 500']) {
  test(`a Reconnect refused or failed (${message}) offers Reconnect again after a tick rewrote the header in flight`, async () => {
    const page = reconnectPage(trying(3));
    page.ctx.btn = page.header.button;
    const running = vm.runInContext('reconnect(btn)', page.ctx);
    page.ctx.S.status = trying(4);
    vm.runInContext('renderWorkspaceStatus()', page.ctx);
    assert.equal(page.header.button.disabled, true);
    page.fail(new Error(message));
    await running;
    assert.match(page.header.innerHTML, /onclick="reconnect\(this\)"/);
    assert.equal(page.header.button.disabled, false);
    assert.equal(page.posts, 1);
  });
}

test('Reconnect is disabled with a reason while any runner is alive', () => {
  const status = statusWith('offline',{processes:[{pid:1,runner:'calibrate'}]});
  const header = WorkspaceStatus.headerHTML({config:instConfig(), status});
  assert.match(header, /<button class="small ghost" disabled title="Stop running automation first; reconnecting can drop its connection.">Reconnect<\/button>/);
  assert.doesNotMatch(header, /onclick="reconnect/);
  // the reason is also visible text in Overview's status summary
  assert.match(WorkspaceStatus.contextHTML({config:instConfig(), status}), /Reconnect waits until automation stops/);
  assert.doesNotMatch(WorkspaceStatus.contextHTML({config:instConfig(), status:statusWith('offline')}), /Reconnect waits/);
});

test('the Emulator field names the instance and serial, not the profile label', () => {
  const accounts = {active:'one',accounts:[{id:'one',label:'My Tower'}]};
  const plain = WorkspaceStatus.contextHTML({config:instConfig(), accounts, status:statusWith('device')});
  assert.match(plain, /<dt>Emulator<\/dt><dd>main<\/dd><small>127\.0\.0\.1:16384<\/small>/);
  const named = WorkspaceStatus.contextHTML({config:instConfig(), accounts, status:statusWith('device'),
    emulators:[{emulator:'MuMu',name:'Player 0',adb_port:16384},{emulator:'BlueStacks',name:'Other',adb_port:5555}]});
  assert.match(named, /<dt>Emulator<\/dt><dd>MuMu Player 0<\/dd>/);
  assert.doesNotMatch(named, /My Tower/);
  assert.match(WorkspaceStatus.headerHTML({config:instConfig(), accounts, status:statusWith('device')}), /<span class="header-profile">My Tower<\/span>/);
  assert.match(WorkspaceStatus.headerHTML({config:instConfig(), status:statusWith('device')}), /<span class="header-profile">No profile yet<\/span>/);
});

test('setup stage 3 is not satisfied when the port is open but adb reports the emulator offline', () => {
  const base = {tools:{installed:true},accounts:{active:'one'},config:instConfig(),wizard:{}};
  const offline = WorkspaceStatus.stagesHTML({...base,status:statusWith('offline',{calibration:{ready:false}})});
  assert.match(offline, /2 of 4 checks satisfied/);
  assert.match(offline, /<span class="stage-number" aria-hidden="true">○<\/span><b>Emulator connection<\/b><small>Emulator offline: adb sees the port but Android isn&#39;t answering/);
  const online = WorkspaceStatus.stagesHTML({...base,status:statusWith('device',{calibration:{ready:false}})});
  assert.match(online, /3 of 4 checks satisfied/);
  assert.match(online, /✓<\/span><b>Emulator connection<\/b><small>Online/);
  const legacy = WorkspaceStatus.stagesHTML({...base,status:{connected:true,calibration:{ready:false}}});
  assert.match(legacy, /2 of 4 checks satisfied/);
});

test('start blockers name connection and game input only, and clear when both hold', () => {
  const ids = (status, config) => WorkspaceStatus.startBlockers({status, config}).map(b => b.id);
  assert.deepEqual(ids(null, instConfig()), ['connection','taps']);
  assert.deepEqual(ids(statusWith('offline',{calibration:{ready:true}}), instConfig({allow_taps:true})), ['connection']);
  // calibration.ready (control_gate) is no longer a global Start blocker
  assert.deepEqual(ids(statusWith('device',{calibration:{ready:false}}), instConfig({allow_taps:true})), []);
  assert.deepEqual(ids(statusWith('device',{calibration:{ready:true}}), instConfig()), ['taps']);
  assert.deepEqual(ids(statusWith('device',{calibration:{ready:true}}), instConfig({allow_taps:true})), []);
  const panel = WorkspaceStatus.controlBlockersHTML({status:statusWith('offline',{calibration:{ready:false}}), config:instConfig(),
    runs:{bp_farm:{label:'<Farm>'},bp_shard:{},combo:{}}, readiness:{bp_farm:{ready:false},bp_shard:{ready:true},combo:{ready:false}}});
  assert.match(panel, /Automation cannot start yet/);
  assert.doesNotMatch(panel, /mapping/i);
  assert.match(panel, /Emulator: Emulator offline[\s\S]*href="#emulators" data-workspace-section="setup-connection"/);
  assert.match(panel, /1 of 2 runs not ready: &lt;Farm&gt;[\s\S]*href="#screens" data-workspace-section="run-preparation"/);
  const clear = WorkspaceStatus.controlBlockersHTML({status:statusWith('device',{calibration:{ready:true}}), config:instConfig({allow_taps:true}),
    runs:{bp_farm:{}}, readiness:{bp_farm:{ready:true}}});
  assert.match(clear, /Nothing blocks automation/);
});

function runReadyContext(status, config, readiness, runs={}){
  const controls = {'#start-preset':{value:'bp_farm'},'#run-ready':{},'#start-run':{},'#start-gems':{},'#run-collection-summary':{}};
  const prepare = {}, runTypePrepare = {};   // Live control's Prepare and a run type's on Runs
  const ctx = vm.createContext({LearningStore,S:{status,config,runReadiness:readiness,runs,readinessFresh:true,readinessContext:LearningStore.context(config).id},WorkspaceStatus,
    $:key=>controls[key],document:{querySelectorAll:()=>[prepare, runTypePrepare]},esc:String,outstandingCard:()=>''});
  vm.runInContext(section('function renderRunReady(){', 'async function killPid('), ctx);
  vm.runInContext('renderRunReady()', ctx);
  assert.equal(runTypePrepare.disabled, prepare.disabled);   // every Prepare follows one rule
  return {controls, prepare};
}

test('collection summary follows the selected policy and prevents a disabled or duplicate collector', () => {
  const status = statusWith('device', {calibration:{ready:true}});
  const config = instConfig({allow_taps:true});
  const ready = {bp_farm:{ready:true}};
  let {controls} = runReadyContext(status, config, ready, {bp_farm:{gather:{ad_gems:false,gem_orbit:{enabled:false}}}});
  assert.equal(controls['#start-gems'].disabled, true);
  assert.match(controls['#run-collection-summary'].textContent, /Ad gems: off. Floating gems: off/);
  ({controls} = runReadyContext(status, config, ready, {bp_farm:{gather:{ad_gems:true,gem_orbit:{enabled:true}}}}));
  assert.equal(controls['#start-gems'].disabled, false);
  assert.match(controls['#run-collection-summary'].textContent, /Ad gems: on. Floating gems: on \(timed clicks\)/);
  ({controls} = runReadyContext({...status, processes:[{runner:'gem_collector'}]}, config, ready));
  assert.equal(controls['#start-gems'].disabled, true);
});

test('Start and Collect diamonds stay disabled with visible reasons until the run, emulator and input all allow it', () => {
  const ready = {bp_farm:{ready:true}};
  let {controls, prepare} = runReadyContext(statusWith('offline',{calibration:{ready:true}}), instConfig({allow_taps:true}), ready);
  assert.equal(controls['#start-run'].disabled, true);
  assert.equal(controls['#start-gems'].disabled, true);
  assert.equal(prepare.disabled, true);
  assert.match(controls['#run-ready'].innerHTML, /Start is disabled[\s\S]*Emulator offline/);
  assert.doesNotMatch(controls['#run-ready'].innerHTML, /Ready to start/);
  ({controls, prepare} = runReadyContext(statusWith('device',{calibration:{ready:true}}), instConfig(), ready));
  assert.equal(controls['#start-run'].disabled, true);
  assert.equal(prepare.disabled, false);
  assert.match(controls['#run-ready'].innerHTML, /Game input is disabled/);
  ({controls} = runReadyContext(statusWith('device',{calibration:{ready:true}}), instConfig({allow_taps:true}), {bp_farm:{ready:false,missing:['a.png']}}));
  assert.equal(controls['#start-run'].disabled, true);
  assert.equal(controls['#start-gems'].disabled, false);
  ({controls} = runReadyContext(statusWith('device',{calibration:{ready:true}}), instConfig({allow_taps:true}), ready));
  assert.equal(controls['#start-run'].disabled, false);
  assert.equal(controls['#start-gems'].disabled, false);
  assert.match(controls['#run-ready'].innerHTML, /Ready to start/);
});

test('Stop now and Finish current run are rendered enabled while the emulator is offline', () => {
  const body = {dataset:{},contains:()=>false};
  let readyCalls = 0;
  const ctx = vm.createContext({S:{status:statusWith('offline',{processes:[{pid:42,runner:'orchestrator'}],stop_flag:false,calibration:{ready:false}}),
    config:instConfig(), runs:{bp_farm:{}}, runReadiness:{}}, WorkspaceStatus, LearningView, document:{activeElement:null},
    $:key=>key === '#runner-body' ? body : undefined, esc:String, renderRunReady:()=>readyCalls++});
  vm.runInContext(section('function renderRunner(){', 'function renderRunReady(){'), ctx);
  vm.runInContext('renderRunner()', ctx);
  assert.match(body.innerHTML, /<button class="small danger" onclick="killPid\(42\)">Stop now<\/button>/);
  assert.match(body.innerHTML, /<button class="ghost" onclick="ctl\('stop_after_run'\)">Finish current run, then stop<\/button>/);
  assert.equal(readyCalls, 1);
});

test('artwork pairs request a screen cut only for templates known to exist', () => {
  const ctx = vm.createContext({S:{calib:{have:['buttons/battle.png']}}});
  vm.runInContext(section('function artPair(', 'function rowState('), ctx);
  assert.match(vm.runInContext("artPair('buttons/battle.png','ok')", ctx), /\/api\/template\/buttons\/battle\.png/);
  const missing = vm.runInContext("artPair('buttons/missing.png','bad')", ctx);
  assert.doesNotMatch(missing, /\/api\/template\//);
  assert.match(missing, /\/api\/artwork\/buttons\/missing\.png/);
  ctx.S.calib = undefined;
  assert.doesNotMatch(vm.runInContext("artPair('buttons/battle.png','ok')", ctx), /\/api\/template\//);
});

test('the live screen shows a placeholder and requests no frame unless the emulator is online', () => {
  const slot = {dataset:{}};
  const ctx = vm.createContext({S:{status:statusWith('offline'),calibTs:1}, WorkspaceStatus, esc:String, $:key=>key === '#live-screen' ? slot : null});
  vm.runInContext(section('function syncLiveScreen(){', '/* ---- outstanding images'), ctx);
  vm.runInContext('syncLiveScreen()', ctx);
  assert.match(slot.innerHTML, /Live screen unavailable — emulator offline/);
  assert.doesNotMatch(slot.innerHTML, /frame\.png/);
  ctx.S.status = statusWith('device');
  vm.runInContext('syncLiveScreen()', ctx);
  assert.match(slot.innerHTML, /<img id="calib-frame" src="\/api\/frame\.png\?ts=1"/);
  slot.innerHTML = 'kept';   // an unchanged state does not rebuild the cropper
  vm.runInContext('syncLiveScreen()', ctx);
  assert.equal(slot.innerHTML, 'kept');
});

test('the calibration Stop button is hidden unless a worker is running', () => {
  const stop = {};
  const ctx = vm.createContext({document:{querySelectorAll:()=>[],querySelector:()=>stop}});
  vm.runInContext(section('function calibrationBusy(', 'function receiveCalibration('), ctx);
  vm.runInContext('calibrationBusy(false)', ctx);
  assert.equal(stop.hidden, true);
  vm.runInContext('calibrationBusy(true)', ctx);
  assert.equal(stop.hidden, false);
  assert.equal(stop.disabled, false);
  vm.runInContext('calibrationBusy(true,false)',ctx);
  assert.equal(stop.disabled,false);
  assert.equal(stop.hidden,false);
  assert.match(html, /onclick="stopCalibrate\(\)" hidden>Stop<\/button>/);
});

test('one status timer drives the dashboard and the dead scan poller is gone', () => {
  assert.equal(html.match(/setInterval\(/g).length, 1);
  assert.match(html, /setInterval\(loadStatus, 2500\)/);
  assert.doesNotMatch(html, /startScan|pollScan|scan-state|connect-overlay/);
});


const cardInput = (over={}) => ({tools:{installed:true}, accounts:{active:'one'}, config:instConfig(),
  status:statusWith('device'), readiness:{bp_farm:{ready:false}, combo:{ready:true}}, ...over});

test('get-started stage A needs tools, an active profile and a configured serial', () => {
  for (const [field, value] of [['tools',{installed:false}],['accounts',{}],['config',{active_instance:'main',instances:{main:{}}}]]) {
    const model = WorkspaceStatus.getStarted(cardInput({[field]:value}));
    assert.equal(model.a.done, false, field);
    assert.equal(model.done, false, field);
    const output = WorkspaceStatus.getStartedHTML(model, {profileHTML:'<form id="p"></form>', emulatorHTML:'<p id="e"></p>', learnHTML:'<button id="client-remap"></button>'});
    assert.match(output, /Get started/);
    assert.doesNotMatch(output, /Learn your game/, field);   // stage B waits for stage A
  }
  const noProfile = WorkspaceStatus.getStartedHTML(WorkspaceStatus.getStarted(cardInput({accounts:{}})), {profileHTML:'<form id="p"></form>'});
  assert.match(noProfile, /<form id="p"><\/form>/);
  const noSerial = WorkspaceStatus.getStartedHTML(WorkspaceStatus.getStarted(cardInput({config:{active_instance:'main',instances:{main:{}}}})), {emulatorHTML:'<p id="e"></p>'});
  assert.match(noSerial, /<p id="e"><\/p>/);
});

test('get-started stage B is done only when a non-combo run is ready, then the card collapses', () => {
  const learning = WorkspaceStatus.getStarted(cardInput());
  assert.equal(learning.a.done, true);
  assert.equal(learning.b.done, false);    // combo's readiness does not count
  const output = WorkspaceStatus.getStartedHTML(learning, {learnHTML:'<button id="client-remap">Learn screens</button>'});
  assert.match(output, /Learn your game[\s\S]*Keep The Tower open at Home[\s\S]*0 of 1 runs ready[\s\S]*Learn screens/);
  assert.match(output, /Online <small>127\.0\.0\.1:16384<\/small>/);
  const done = WorkspaceStatus.getStarted(cardInput({readiness:{bp_farm:{ready:true}}}));
  assert.equal(done.done, true);
  assert.equal(WorkspaceStatus.getStartedHTML(done), '<p class="get-started-done">✓ Setup done · <a href="#profiles">Profiles</a></p>');
  // calibration.ready alone never completes stage B
  assert.equal(WorkspaceStatus.getStarted(cardInput({status:statusWith('device',{calibration:{ready:true}})})).b.done, false);
});

test('a dropped connection does not reopen a completed get-started card', () => {
  for (const status of [statusWith('offline'), statusWith('missing'), statusWith('no_server'), {connected:false}, null]) {
    const model = WorkspaceStatus.getStarted(cardInput({status, readiness:{bp_farm:{ready:true}}}));
    assert.equal(model.done, true);
    assert.match(WorkspaceStatus.getStartedHTML(model), /Setup done/);
  }
  // before completion the emulator row still shows the live state
  const offline = WorkspaceStatus.getStartedHTML(WorkspaceStatus.getStarted(cardInput({status:statusWith('offline')})));
  assert.match(offline, /Emulator offline <small>127\.0\.0\.1:16384<\/small>/);
});

test("Overview's card reuses the existing profile form, suggestion and Learn screens action", () => {
  const source = section('function renderGetStarted(){', "/* Overview's blockers panel");
  assert.match(source, /accountSetupHtml\(S\.workspace\.accounts\)/);
  assert.match(source, /suggestionHtml\(S\.emus\)/);
  assert.match(source, /onclick="remapClient\(\)"/);
  assert.match(html, /<article id="get-started"[^>]*><\/article>/);
  assert.match(html, /el.hidden = model.done/);
});

/* renderHome against stub panels and requests; returns the written panel markup. */
async function renderHomePanels(S, emulatorInventory={instances:[]}, lifecycle=[]){
  const panels = {}, requests = [];
  const ctx = vm.createContext({LearningStore,S:{view:'home', tab:'overview', profiles:{active:'p'}, ...S}, WorkspaceStatus,
    runWorkspace:{attach(){},selected(){return '';},choose(){}},
    $:selector => (panels[selector] ||= {options:[],_html:'',get innerHTML(){return this._html;},set innerHTML(value){lifecycle.push(selector);this._html=value;}}),
    api:async url => { requests.push(url); return url === '/api/runs' ? {runs:{}, readiness:{}} : emulatorInventory; },
    loadHomeData:async()=>{}, toast:()=>{}, starterBanner:()=>'',
    stopStream(){lifecycle.push('stopStream');}, renderStream(){}, renderRunner(){}, renderDay(){}, renderFlows(){}, renderBehaviors(){}, renderLoadouts(){},
    renderGlobal(){}, renderHomeLive(){}, renderControlBlockers(){}, renderGetStarted(){}, renderWorkspaceStatus(){}, mountConfigurationPage(){}, mountDiagnostics(){}});
  vm.runInContext(section('async function renderHome(){', '/* ------------------------------------------------------------- loadouts'), ctx);
  await vm.runInContext('renderHome()', ctx);
  const panel = name => panels['#panel-' + name]?.innerHTML || '';
  return {ctx, panel, requests};
}

test('rebuilding Dashboard releases its existing stream before replacing any panel', async () => {
  const lifecycle = [];
  await renderHomePanels({config:instConfig()}, {instances:[]}, lifecycle);
  assert.equal(lifecycle[0],'stopStream');
  assert.equal(lifecycle[1],'#panel-overview');
  assert.equal(lifecycle.filter(event=>event === 'stopStream').length,1);
});

test('Dashboard separates current controls, activity and screen from configuration pages', async () => {
  const {panel} = await renderHomePanels({config:instConfig()});
  // renderRunner fills #runner-body with Stop now / Finish current run (see the offline test above)
  assert.match(panel('overview'), /id="control-status"[\s\S]*id="workspace-context"[\s\S]*id="control-blockers"[\s\S]*id="card-runner"[\s\S]*id="runner-body"[\s\S]*id="events"[\s\S]*id="get-started"[\s\S]*id="stream-slot"/);
  for (const [tab, card] of [['runs','card-flows'],['runs','card-behaviors'],['schedule','card-day'],['equipment','card-loadouts'],['collection','card-global']])
    assert.match(panel(tab), new RegExp(`id="${card}"`), tab);
  for (const tab of ['runs','schedule','equipment','collection','abilities']) {
    assert.doesNotMatch(panel(tab), /runner-body|get-started/, tab);
    assert.match(panel(tab), /Game not needed to review or edit/, tab);   // every configuration tab says so
  }
  // the schedule is a tab of its own, no longer a closed disclosure
  assert.doesNotMatch(panel('schedule'), /<details>/);
  assert.doesNotMatch(html, /aria-label="Control sections"/);   // the in-page pill row is gone
  assert.match(panel('collection'), /id="collection-settings"[\s\S]*id="collection-policies"/);
  assert.match(panel('abilities'), /id="abilities-settings"[\s\S]*id="ability-policies"/);
  assert.match(panel('runtime'), /id="runtime-settings"/);
  assert.match(panel('runs'), /id="shopping-policies"/);
  for (const tab of ['overview','runs','schedule','equipment','collection','abilities','runtime']) {
    for (const [owner, id] of [['runs','shopping-policies'],['collection','collection-policies'],['abilities','ability-policies'],['runtime','runtime-settings']])
      if (tab !== owner) assert.doesNotMatch(panel(tab), new RegExp(`id="${id}"`), `${id} belongs only to ${owner}`);
  }
});

test('a home render that finishes after another view opened writes nothing', async () => {
  const {ctx, panel} = await renderHomePanels({config:instConfig(), view:'calibrate'});
  assert.equal(panel('overview'), '');
  assert.equal(panel('runs'), '');
  assert.equal(ctx.S.view, 'calibrate');
});

test('the status summary names the emulator from one inventory read, whatever tab loaded first', async () => {
  const inventory = {instances:[{emulator:'MuMu',name:'Player 0',adb_port:16384}]};
  let {ctx, requests} = await renderHomePanels({config:instConfig()}, inventory);
  assert.equal(requests.filter(url => url === '/api/wizard/emulators').length, 1);
  assert.match(WorkspaceStatus.contextHTML({config:instConfig(), status:statusWith('device'), emulators:ctx.S.emus.instances}), /<dd>MuMu Player 0<\/dd>/);
  await vm.runInContext('renderHome()', ctx);   // a serial is configured: not read again
  assert.equal(requests.filter(url => url === '/api/wizard/emulators').length, 1);
  // Settings already read it: Overview reuses that read
  ({requests} = await renderHomePanels({config:instConfig(), emus:inventory}));
  assert.equal(requests.filter(url => url === '/api/wizard/emulators').length, 0);
  // no serial yet: every entry re-reads it for the connect suggestion
  const noSerial = {active_instance:'main', instances:{main:{}}};
  ({requests} = await renderHomePanels({config:noSerial, emus:inventory}));
  assert.equal(requests.filter(url => url === '/api/wizard/emulators').length, 1);
});

test('old section deep-links open the tab that now holds the section', () => {
  const location = {hash:'#overview'};
  const ctx = vm.createContext({S:{tab:'overview'}, location, document:{getElementById:()=>null}});
  vm.runInContext(html.match(/const TAB_ALIASES = .*;/)[0], ctx);
  vm.runInContext(section('const SECTION_TABS', "document.addEventListener('click'"), ctx);
  for (const [route, section, tab] of [['home','card-flows','runs'],['home','card-behaviors','runs'],['home','card-day','schedule'],
      ['home','card-loadouts','equipment'],['home','card-global','collection'],['setup','setup-connection','emulators'],
      ['setup','setup-profile','profiles'],['setup','setup-tools','emulators'],['settings','logging','runtime'],['rewards','rewards','collection'],
      ['calibrate','run-preparation','screens'],['screens','workspace-operation','screens'],['profiles','workspace-operation','profiles'],['overview','card-day','schedule']]) {
    ctx.S.tab = 'overview'; location.hash = '#overview';
    vm.runInContext(`openWorkspaceSection(${JSON.stringify(route)}, ${JSON.stringify(section)})`, ctx);
    assert.equal(location.hash, '#' + tab, section);
    assert.equal(ctx.S.workspaceSection, section);   // scrolled to once the tab is shown
  }
  // a section on the current tab scrolls in place
  ctx.S.workspaceSection = null; location.hash = '#overview';
  vm.runInContext('openWorkspaceSection("home", "card-runner")', ctx);
  assert.equal(location.hash, '#overview');
  assert.equal(ctx.S.workspaceSection, null);
});

test('a refusal sent with HTTP 200 shows its message, not the status code', async () => {
  const ctx = vm.createContext({reportDiagnostic(){}});
  vm.runInContext(section('async function api(', 'const post = '), ctx);
  const reply = (status, body) => { ctx.fetch = async () => ({ok:status < 400, status, json:async () => { if (!body) throw new Error('no json'); return body; }}); };
  reply(200, {ok:false, message:'cannot connect to 127.0.0.1:16384: No connection could be made'});
  await assert.rejects(vm.runInContext('api("/api/wizard/reconnect", {method:"POST"})', ctx), {message:'cannot connect to 127.0.0.1:16384: No connection could be made'});
  reply(409, {ok:false, error:'runners alive - stop them first', message:'ignored'});
  await assert.rejects(vm.runInContext('api("/api/wizard/reconnect")', ctx), {message:'runners alive - stop them first'});
  reply(400, {ok:false, problems:['a','b']});
  await assert.rejects(vm.runInContext('api("/x")', ctx), {message:'a\nb'});
  reply(502, null);
  await assert.rejects(vm.runInContext('api("/x")', ctx), {message:'HTTP 502'});
  reply(200, {ok:true, message:'connected to 127.0.0.1:16384'});
  assert.equal((await vm.runInContext('api("/x")', ctx)).message, 'connected to 127.0.0.1:16384');
});

test('stream cleanup replaces the MJPEG source with a local image before detaching on navigation, disconnect or toggle', () => {
  for (const transition of ['navigate','disconnect','toggle']) {
    const events = [], image = {set src(value){events.push(['source',value]);}};
    let attached = true;
    const slot = {dataset:{},set innerHTML(value){events.push(['detach',value]);attached=false;}};
    const toggle = {checked:true};
    const ctx = vm.createContext({S:{status:statusWith('device'),tab:'overview'}, WorkspaceStatus, Date,
      $:key => ({'#stream-slot':slot,'#stream-toggle':toggle,'#stream-slot img':attached?image:null})[key]});
    vm.runInContext(section('function stopStream(){','function renderHomeLive('),ctx);
    // Preserve the current live stream across unchanged status ticks.
    slot.dataset.state = JSON.stringify([true,true,true,'',4,'main','']);
    vm.runInContext('renderStream()',ctx);
    assert.deepEqual(events,[]);
    if (transition === 'navigate') ctx.S.tab = 'runs';
    if (transition === 'disconnect') ctx.S.status = statusWith('offline');
    if (transition === 'toggle') toggle.checked = false;
    vm.runInContext('renderStream()',ctx);
    assert.equal(events.length,2,transition);
    assert.equal(events[0][0],'source',transition);
    assert.match(events[0][1],/^data:image\/gif;base64,/,transition);
    assert.equal(events[1][0],'detach',transition);
    assert.doesNotMatch(events[1][1],/stream\.mjpg/,transition);
    vm.runInContext('stopStream()',ctx); // idempotent once no image remains
    assert.equal(events.length,2,transition);
  }
});

test('the Overview stream shows the live-screen placeholder offline and streams only while Overview is shown', () => {
  const slot = {dataset:{}}, toggle = {checked:true};
  const ctx = vm.createContext({S:{status:statusWith('offline'), tab:'overview'}, WorkspaceStatus, Date,
    $:key => ({'#stream-slot':slot, '#stream-toggle':toggle})[key]});
  vm.runInContext(section('function stopStream(){', 'function renderHomeLive('), ctx);
  vm.runInContext('renderStream()', ctx);
  assert.equal(slot.innerHTML, WorkspaceStatus.screenPlaceholderHTML(ctx.S.status));   // the Screens placeholder
  assert.match(slot.innerHTML, /Live screen unavailable — emulator offline[\s\S]*Emulator offline/);
  assert.doesNotMatch(slot.innerHTML, /stream\.mjpg|<img/);
  ctx.S.status = statusWith('device');
  vm.runInContext('renderStream()', ctx);
  assert.match(slot.innerHTML, /<img src="\/api\/stream\.mjpg\?fps=4&scale=0\.4&ts=\d+&instance=main&stream_id=[a-z0-9_]+" alt="live stream">/);
  slot.innerHTML = 'kept';                        // a status tick with nothing changed does not restart the stream
  vm.runInContext('renderStream()', ctx);
  assert.equal(slot.innerHTML, 'kept');
  ctx.S.tab = 'runs';                             // the hidden Overview panel stops requesting frames
  vm.runInContext('renderStream()', ctx);
  assert.equal(slot.innerHTML, '');
  ctx.S.tab = 'overview'; toggle.checked = false;
  vm.runInContext('renderStream()', ctx);
  assert.match(slot.innerHTML, /stream off/);
});

test('the offline Overview stream and Screens live screen follow the reconnect wording on every status tick', () => {
  const slots = {'#stream-slot':{dataset:{}}, '#live-screen':{dataset:{}}, '#stream-toggle':{checked:true}};
  const ctx = vm.createContext({S:{tab:'overview', calibTs:1}, WorkspaceStatus, Date, $:key => slots[key] || null});
  vm.runInContext(section('function stopStream(){', 'function renderHomeLive('), ctx);
  vm.runInContext(section('function syncLiveScreen(){', '/* ---- outstanding images'), ctx);
  const missing = reconnect => ({device_state:'missing', processes:[], reconnect});
  for (const status of [missing(undefined),
                        missing({state:'trying', attempts:1, next_try_in:5, last_error:'device offline'}),
                        missing({state:'trying', attempts:9, next_try_in:60, last_error:'device offline'}),
                        missing({state:'gave_up', attempts:10, next_try_in:null, last_error:'device offline'})]) {
    ctx.S.status = status;
    vm.runInContext('renderStream(); syncLiveScreen();', ctx);
    const expected = WorkspaceStatus.screenPlaceholderHTML(status);
    assert.equal(slots['#stream-slot'].innerHTML, expected, `stream slot, reconnect ${status.reconnect?.state}`);
    assert.equal(slots['#live-screen'].innerHTML, expected, `live screen, reconnect ${status.reconnect?.state}`);
  }
  // gave_up: today's missing wording, no leftover reconnect attempt from an earlier tick
  assert.match(slots['#stream-slot'].innerHTML, /Not found by adb/);
  assert.doesNotMatch(slots['#live-screen'].innerHTML, /Reconnecting/);
});

test('status ticks of one automatic reconnect that differ only in the countdown rewrite no region', () => {
  const writes = {}, slots = {};
  const $ = key => (slots[key] ||= {dataset:{}, contains:() => false, set innerHTML(v) { writes[key] = (writes[key] || 0) + 1; }, set textContent(v) {}});
  const config = {active_instance:'main', instances:{main:{serial:'127.0.0.1:16384', allow_taps:true}}};
  const ctx = vm.createContext({WorkspaceStatus, LearningView, $, document:{activeElement:null, querySelectorAll:() => []}, esc:String,
    outstandingCard:() => '', workspaceOperation:() => WorkspaceStatus.operation({record:null}),
    S:{tab:'overview', view:'home', config, runs:{bp_coin_default:{label:'Coin'}}, runReadiness:{bp_coin_default:{ready:true}},
      workspace:{config, accounts:{active:'a', accounts:[{id:'a', label:'A'}]}}, workspaceError:'', statusError:''}});
  vm.runInContext(section('function renderRunner(){', 'async function killPid('), ctx);
  vm.runInContext(section('function stopStream(){', 'function renderHomeLive('), ctx);
  vm.runInContext(section('function syncLiveScreen(){', '/* ---- outstanding images'), ctx);
  vm.runInContext(section('function updateWorkspaceRegion(', '/* Slow-changing workspace data'), ctx);
  // the dashboard recomputes next_try_in on every poll: 40 s, 37.5 s, ... of one backoff
  for (let wait = 40; wait > 0; wait -= 2.5) {
    ctx.S.status = {device_state:'missing', processes:[], stop_flag:false,
      reconnect:{state:'trying', attempts:4, next_try_in:wait, last_error:'device missing after recovery'}};
    vm.runInContext('renderRunner(); renderStream(); syncLiveScreen(); renderWorkspaceStatus();', ctx);
  }
  for (const key of ['#runner-body', '#stream-slot', '#live-screen', '#header-status', '#workspace-context'])
    assert.equal(writes[key], 1, key);
});

test("Overview's get-started card never shows a doubled full stop after the reconnect label", () => {
  const el = {classList:{toggle:() => {}}, contains:() => false};
  let written = '';
  const config = {active_instance:'main', instances:{main:{serial:'127.0.0.1:16384'}}};
  const ctx = vm.createContext({WorkspaceStatus, $:() => el, document:{activeElement:null}, esc:String, workspaceOperation:() => ({}),
    accountSetupHtml:() => '', suggestionHtml:() => '', updateWorkspaceRegion:(_selector, markup) => { written = markup; },
    S:{workspace:{config, accounts:{active:'a'}, tools:{installed:true}}, status:statusWith('missing', {reconnect:{state:'trying', attempts:0, next_try_in:null, last_error:''}})}});
  vm.runInContext(section('function renderGetStarted(){', "/* Overview's blockers panel"), ctx);
  vm.runInContext('renderGetStarted()', ctx);
  assert.match(written, /Emulator: Reconnecting to the emulator\.\.\. Start the emulator, then Reconnect\./);
  assert.doesNotMatch(written, /\.{4}/);
});

test('Runs lists each run type with its readiness and a Prepare action gated like Live control', () => {
  const body = {};
  const ctx = vm.createContext({S:{profile:{blueprints:{farm:{kind:'coin', loadout:'as_is', tier:3}, shard:{kind:'shard'}, raw:{kind:'coin'}}},
      runReadiness:{bp_farm:{ready:true}, bp_shard:{ready:false, missing:['a.png','b.png']}}, runTemplates:[],
      status:statusWith('offline'), config:instConfig({allow_taps:true})},
    WorkspaceStatus, esc:String, bpLabel:name => name, bpKindLabel:b => b.kind,
    $:key => key === '#flows-body' ? body : null, updateWorkspaceRegion:(_selector, markup) => { body.innerHTML = markup; }});
  for (const [from, to] of [['/* Run types (Runs tab)','function openRunTemplate('],['function prepareBlocked(','async function killPid(']])
    vm.runInContext(section(from, to), ctx);
  vm.runInContext('renderFlows()', ctx);
  const card = name => body.innerHTML.split('<div class="flowcard">').find(c => c.includes(`<b>${name}</b>`));
  assert.match(card('farm'), /Ready to start/);
  assert.doesNotMatch(card('farm'), /Prepare/);
  assert.match(card('shard'), /2 screens to learn/);
  assert.match(card('shard'), /<button class="small ghost" data-prepare-run onclick="prepareRun\('bp_shard'\)" disabled>Prepare<\/button>/);   // emulator offline
  assert.doesNotMatch(card('raw'), /Ready|to learn/);
  assert.match(card('raw'), /Prepare/);   // no readiness entry: nothing claimed
  ctx.S.status = statusWith('device');
  vm.runInContext('renderFlows()', ctx);
  assert.match(card('shard'), /onclick="prepareRun\('bp_shard'\)" >Prepare<\/button>/);
  ctx.S.status = statusWith('device', {processes:[{pid:1, runner:'orchestrator'}]});
  vm.runInContext('renderFlows()', ctx);
  assert.match(card('shard'), /onclick="prepareRun\('bp_shard'\)" disabled>Prepare/);   // automation running
});
