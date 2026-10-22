/* Dashboard variant of the shared run controller: compact live rows in the one
   live host, the read-only saved preview for the Start picker run, and their
   request lifetimes. Offline: fake hosts and a fake transport; no request
   leaves the test and no browser DOM is assumed. */
const test=require('node:test');
const assert=require('node:assert/strict');
const UI=require('../webui/run-workspace.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const debounce=()=>new Promise(resolve=>setTimeout(resolve,470));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const clone=value=>JSON.parse(JSON.stringify(value));
const count=(html,needle)=>html.split(needle).length-1;
const values=(html,attribute)=>[...html.matchAll(new RegExp(`${attribute}="([^"]+)"`,'g'))].map(match=>match[1]);

const catalog=[{id:'attack_skip',label:'Enemy attack level skip',section:'attack',game_order:1},{id:'health_skip',label:'Enemy health level skip',section:'defense',game_order:1},
  {id:'death_defy',label:'Death defy',section:'defense',game_order:2},{id:'damage',label:'Damage',section:'attack',game_order:2},{id:'health',label:'Health',section:'defense',game_order:3}];
const plan=(extra={})=>({version:2,enabled:true,interval_sec:90,cadence:'single_attempt',cash_reserve:250000,queue_mode:'highest_affordable',
  queue:catalog.map(entry=>({id:entry.id,enabled:true,tap_limit:null,from_wave:1,until_wave:null,weight:1})),excluded_upgrades:[],...extra});
const routines={ad_gems:{enabled:true,interval_sec:720,window_sec:60},floating_gems:{enabled:true,interval_sec:960,window_sec:60,tap_interval_sec:5},shopping:{enabled:true,interval_sec:90},
  rewards:{enabled:true},abilities:{enabled:true},rescue:{enabled:false},repeat:{enabled:true}};
const names=['ad_gems','floating_gems','shopping','rewards','abilities','rescue','repeat'];
const farmCaps={controls:[...names.map(name=>`routines.${name}.enabled`),'routines.ad_gems.interval_sec','routines.ad_gems.window_sec','routines.floating_gems.interval_sec',
  'routines.floating_gems.window_sec','routines.floating_gems.tap_interval_sec','routines.shopping.interval_sec','shopping_plan'],
  actions:['ad_gems','floating_gems','shopping','shopping:attack','shopping:defense','shopping:utility',...catalog.map(entry=>`shopping:${entry.section}:${entry.id}`)]};
const collectorCaps={controls:farmCaps.controls.filter(path=>/ad_gems|floating_gems/.test(path)),actions:['ad_gems','floating_gems']};
const battle=(extra={})=>({id:'battle-1',operation_id:'op-1',generation:'driver',status:'active',origin:'started',control_revision:1,applied_revision:1,
  envelope:{controls:{routines,shopping_plan:plan()}},effective:{routines:{...routines,ad_gems:{...routines.ad_gems,interval_sec:600}},shopping_plan:plan()},
  overrides:{routines:{ad_gems:{interval_sec:600}}},capabilities:farmCaps,catalog,commands:[],runtime:{server_time:Date.now()/1000},...extra});

test('the variant option leaves default and saved rendering unchanged',()=>{
  const live=UI.makeModel('live',battle());
  const saved=UI.makeModel('saved',{blueprint:'farm',context:{instance:'i',account:'a',profile:'p'},settings:{routines,shopping_plan:plan()},catalog,capabilities:{controls:farmCaps.controls,actions:[]}});
  const original=UI.renderHTML(live);
  assert.equal(UI.renderHTML(live,{}),original);assert.equal(UI.renderHTML(live,{variant:'default'}),original);
  assert.doesNotMatch(original,/rw-dashboard|rw-summary|rw-advanced/);assert.match(original,/Applies to this battle · frozen defaults are retained/);
  assert.equal(UI.renderHTML(saved,{variant:'dashboard'}),UI.renderHTML(saved),'saved controls never take the dashboard variant');
});

test('the dashboard variant renders every control and action once, with primary rows first and the full editor closed',()=>{
  const html=UI.renderHTML(UI.makeModel('live',battle()),{variant:'dashboard'});
  for(const attribute of ['data-control','data-action','data-countdown']){
    const found=values(html,attribute);
    assert.deepEqual(found,[...new Set(found)],`${attribute} values are unique`);
  }
  const advanced=html.indexOf('<details class="rw-advanced" data-advanced >');
  assert.ok(advanced>0,'the advanced disclosure is closed by default');
  const rows=['ad_gems','floating_gems','shopping'].map(name=>html.indexOf(`<section class="rw-summary-routine" data-routine="${name}">`));
  assert.ok(rows.every((index,i)=>index>0 && index<advanced && (i===0 || index>rows[i-1])),'primary rows precede the disclosure in order');
  for(const name of ['ad_gems','floating_gems','shopping']){
    for(const marker of [`data-control="routines.${name}.enabled"`,`data-control="routines.${name}.interval_sec"`,`data-action="${name}"`,`data-countdown="${name}"`,`data-routine-outcome="${name}"`,`data-action-reason="${name}"`])
      assert.ok(html.indexOf(marker)>0 && html.indexOf(marker)<advanced,`${marker} sits in its summary row`);
  }
  for(const marker of ['data-control="routines.ad_gems.window_sec"','data-control="routines.floating_gems.tap_interval_sec"','data-control="routines.rewards.enabled"','data-action="shopping:attack"','data-reset','data-shop="cash_reserve"'])
    assert.ok(html.indexOf(marker)>advanced,`${marker} stays in the full editor`);
  assert.match(html,/<small data-pending="routines.ad_gems.interval_sec" data-pending-state="override">Default 720 · override<\/small>/);
  assert.match(html,/data-command-action="ad_gems" data-command-only/);
  assert.match(html,/<p class="rw-summary-other" data-other-routines>Rewards on · Abilities on · Rescue off · Repeat on<\/p>/);
  assert.equal(count(html,'data-action="rewards"'),0);
  assert.match(UI.renderHTML(UI.makeModel('live',battle()),{variant:'dashboard',advancedOpen:true}),/<details class="rw-advanced" data-advanced open>/);
});

test('the shopping summary shows its scope, mode, reserve, ordered top three and the full queue, never cash or prices',()=>{
  const runtime={server_time:100,routines:{shopping:{state:'scheduled',server_time:100,last_outcome:{decision:{action:'wait',reason:'reserve_or_no_eligible_upgrades',cash:987654,price:4321},
    last_confirmation:{upgrade:'health',outcome:'confirmed',reason:'price_and_cash_evidence'},observations:{health:{cash:987654,price:4321}},reserve_supported:true,quantity_observation_supported:true}}}};
  const limited=plan();limited.queue[2].tap_limit=1;limited.queue[3].tap_limit=4;limited.queue[4].tap_limit=0;
  const model=UI.makeModel('live',battle({runtime,effective:{routines,shopping_plan:limited}}));
  const html=UI.renderHTML(model,{variant:'dashboard'});
  const summary=html.slice(html.indexOf('data-shopping-summary'),html.indexOf('<details class="rw-advanced"'));
  assert.match(summary,/<header><strong>Shopping priority<\/strong><small class="rw-summary-scope">This battle<\/small><\/header>/);
  assert.match(summary,/<span class="rw-summary-mode">Single focus \(affordable\)<\/span><span class="rw-summary-cadence">Single attempt<\/span><span class="rw-summary-reserve">Keep \$250,000<\/span>/);
  assert.deepEqual([...summary.matchAll(/<li>([^<]+)<\/li>/g)].map(match=>match[1]),['Enemy attack level skip','Enemy health level skip','Death defy']);
  assert.match(summary,/<details class="rw-summary-queue-all" data-queue-all ><summary class="rw-summary-more">All 5 priorities<\/summary><ol class="rw-summary-queue-full">/);
  assert.deepEqual([...summary.matchAll(/<li><span class="rw-queue-name">([^<]+)<\/span> <small class="rw-queue-limit">([^<]+)<\/small><\/li>/g)].map(match=>`${match[1]}: ${match[2]}`),
    ['Enemy attack level skip: no tap cap','Enemy health level skip: no tap cap','Death defy: 1 tap','Damage: 4 taps','Health: 0 taps']);
  assert.doesNotMatch(summary,/\+\d+ more/,'no inert remainder count');
  assert.match(summary,/Last decision: Wait · Reserve or no eligible upgrades <span class="rw-summary-age" data-shopping-age><\/span>/);
  assert.match(summary,/Last confirmation: Health · Confirmed \(Price and cash evidence\)/);
  assert.doesNotMatch(summary,/987|4,?321|afford(?!able\))/i);
  assert.match(UI.renderHTML(model,{variant:'dashboard',queueOpen:true}),/<details class="rw-summary-queue-all" data-queue-all open>/);
  const weighted=UI.renderHTML(UI.makeModel('live',battle({effective:{routines,shopping_plan:plan({queue_mode:'weighted_split'})}})),{variant:'dashboard'});
  assert.match(weighted,/<small class="rw-queue-limit">no tap cap · 1\/turn<\/small>/);
  const reserve=UI.renderHTML(UI.makeModel('live',battle({effective:{routines,shopping_plan:plan({cash_reserve:null,queue:plan().queue.slice(0,2)})},overrides:{shopping_plan:plan({cash_reserve:null})}})),{variant:'dashboard'});
  assert.match(reserve,/No reserve set/);assert.match(reserve,/<small class="rw-summary-scope">This battle<\/small><small class="rw-summary-marker">Override for this battle<\/small>/);
  assert.doesNotMatch(reserve,/data-queue-all/,'three or fewer priorities need no disclosure');
});

test('a collector driver shows only the routines it runs, no shopping summary and no workshop',()=>{
  const html=UI.renderHTML(UI.makeModel('live',battle({capabilities:collectorCaps})),{variant:'dashboard'});
  assert.equal(count(html,'class="rw-summary-routine"'),2);
  assert.doesNotMatch(html,/data-routine="shopping"|data-shop=|data-shopping-summary|Workshop|routines\.rewards\.enabled|data-other-routines|Shopping is not run/);
});

test('a prepared battle shows only the routines every driver runs, read-only, with disabled Run now and no running claims',()=>{
  const html=UI.renderHTML(UI.makeModel('live',battle({status:'prepared',capabilities:{controls:[],actions:[]}})),{variant:'dashboard'});
  assert.doesNotMatch(html,/data-action=|data-countdown=|data-shopping-summary|data-control=|data-routine="shopping"|data-routine-outcome/);
  assert.equal(count(html,'class="rw-summary-routine"'),2);
  assert.match(html,/data-routine="ad_gems"><strong class="rw-summary-name">Ad gems<\/strong><span class="rw-summary-state" data-state="on">On once observed<\/span><span class="rw-summary-interval">Every 10m 00s<\/span><span class="rw-action"><button type="button" class="small ghost" data-idle-action="ad_gems" disabled aria-label="Run now: Ad gems \(unavailable\)">Run now<\/button><\/span><small class="rw-action-reason">Waiting to observe the battle<\/small>/);
  assert.match(html,/data-dashboard-notice/);
});

test('manual action availability always carries a stated reason',()=>{
  const now=1000,fresh={server_time:now};
  const state=(extra={},mutate)=>{const model=UI.makeModel('live',battle({runtime:fresh,...extra}));if(mutate)mutate(model);return UI.actionState(model,'ad_gems',now);};
  assert.deepEqual(state(),{enabled:true,reason:''});
  assert.equal(UI.actionState(UI.makeModel('saved',{blueprint:'farm',settings:{}}),'ad_gems',now).reason,'Needs a tracked battle');
  for(const [expected,extra,mutate] of [
    ['Waiting to observe the battle',{status:'prepared'}],['Battle is not active',{status:'ended'}],['Not supported by this driver',{capabilities:{controls:[],actions:['floating_gems']}}],
    ['Live status unavailable',{},model=>{model.observationUnavailable=true;}],['Battle observation is stale',{runtime:{server_time:now-60}}],
    ['Waiting for a command reply',{},model=>{model.sending=true;}],['Previous command outcome unknown; use Retry',{},model=>{model.uncertain={kind:'action',action:'ad_gems'};}],
    ['Waiting for a fresh battle read',{},model=>{model.awaitRead=0;}],['Fix the invalid value first',{},model=>{model.invalid.add('routines.ad_gems.interval_sec');}],
    ['Waiting for control changes',{},model=>{model.draft['routines.ad_gems.interval_sec']=60;}],['Waiting for the driver to apply changes',{control_revision:2,applied_revision:1}],
    ['Another action is running',{commands:[{id:'c',kind:'action',payload:{action:'floating_gems'},state:'started'}]}]])
    assert.deepEqual(state(extra,mutate),{enabled:false,reason:expected});
});

/* Hosts: the minimum selector surface the controller writes to. */
function blankHost(){
  return {isConnected:true,innerHTML:'',textContent:'',ownerDocument:{activeElement:null},querySelector:()=>null,querySelectorAll:()=>[]};
}
function dashboardHost(){
  const host=blankHost(),nodes={notice:{textContent:'',hidden:true},details:{open:false},
    outcome:{dataset:{routineOutcome:'ad_gems'},textContent:''},feedback:{dataset:{commandAction:'ad_gems',commandOnly:''},textContent:'',hidden:false},
    button:{dataset:{action:'ad_gems'},disabled:false},reason:{dataset:{actionReason:'ad_gems'},textContent:'',hidden:true},clock:{dataset:{countdown:'ad_gems'},textContent:''}};
  host.querySelector=selector=>({'[data-dashboard-notice]':nodes.notice,'[data-advanced]':nodes.details}[selector] || null);
  host.querySelectorAll=selector=>({'[data-routine-outcome]':[nodes.outcome],'[data-command-action]':[nodes.feedback],'[data-action]':[nodes.button],'[data-action-reason]':[nodes.reason],'[data-countdown]':[nodes.clock]}[selector] || []);
  return Object.assign(host,nodes);
}

test('dashboard rows show the recent outcome with its age and keep command feedback to commands',async()=>{
  const at=Date.now()/1000,host=dashboardHost();
  const runtime={server_time:at,routines:{ad_gems:{state:'scheduled',next_due_at:at+43,server_time:at,last_outcome:{confirmed:true,reason:'offer_disappeared',observed_at:at-130}}}};
  const workspace=UI.create({request:async()=>({battle:battle({runtime})})});
  try {
    workspace.attach({live:host,liveVariant:'dashboard'});await settle();
    assert.match(host.outcome.textContent,/^Last result: Claim disappeared; balance total unknown · 2m 1\ds ago$/);
    assert.equal(host.feedback.textContent,'');assert.equal(host.feedback.hidden,true);
    assert.match(host.clock.textContent,/^4\ds$/);assert.equal(host.button.disabled,false);assert.equal(host.reason.hidden,true);
    assert.equal(host.notice.hidden,true);
  } finally {workspace.destroy();}
});

test('dashboard notices explain prepared battles and drivers that do not run a routine',async()=>{
  for(const [extra,expected] of [[{status:'prepared',capabilities:{controls:[],actions:[]}},'Waiting to observe the battle (Started). Routines start when the driver sees a wave.'],
    [{capabilities:collectorCaps},'This driver does not run Shopping.']]){
    const host=dashboardHost();
    const workspace=UI.create({request:async()=>({battle:battle(extra)})});
    try {
      workspace.attach({live:host,liveVariant:'dashboard'});await settle();
      assert.equal(host.notice.textContent,expected);assert.equal(host.notice.hidden,false);
      if(extra.status==='prepared'){assert.equal(host.clock.textContent,'Waiting for battle');assert.equal(host.reason.textContent,'Waiting to observe the battle');}
    } finally {workspace.destroy();}
  }
});

test('the open state of the full editor survives remounts in the same workspace',async()=>{
  const first=dashboardHost(),second=dashboardHost();
  const workspace=UI.create({request:async()=>({battle:battle()})});
  try {
    workspace.attach({live:first,context:'c',liveVariant:'dashboard'});await settle();
    assert.match(first.innerHTML,/data-advanced >/);
    first.details.open=true;first.details.ontoggle();
    workspace.attach({live:second,context:'c',liveVariant:'dashboard'});
    assert.match(second.innerHTML,/<details class="rw-advanced" data-advanced open>/);
  } finally {workspace.destroy();}
});

/* Saved preview. */
const savedSnapshot=(name,interval,extra={})=>({blueprint:name,context:{instance:'main',account:'a',profile:'p'},profile_revision:'r1',
  settings:{routines:{...routines,ad_gems:{...routines.ad_gems,interval_sec:interval}},shopping_plan:plan()},catalog,capabilities:{controls:farmCaps.controls,actions:[]},
  constraints:{},...extra});
function server(){
  const runs={farm:savedSnapshot('farm',720),tour:savedSnapshot('tour',300)};
  const state={log:[],gates:{},fail:{},battle:null,battleError:null,runs};
  state.request=async(url,options)=>{
    const method=options?.method || 'GET';state.log.push({url,method});
    if(url==='/api/battles/active'){if(state.battleError)throw state.battleError;return {battle:state.battle};}
    const parsed=new URL(url,'http://local');
    if(parsed.pathname!=='/api/run-controls')throw new Error(`unexpected ${url}`);
    if(method==='GET') {
      const name=parsed.searchParams.get('blueprint');
      if(state.gates[name])await state.gates[name].promise;
      if(state.fail[name])throw state.fail[name];
      const run=runs[name.replace(/^bp_/,'')];
      if(!run)throw Object.assign(new Error(`Unknown blueprint: ${name}`),{status:400});
      return clone(run);
    }
    const body=JSON.parse(options.body);
    const run=runs[body.blueprint];
    run.settings.routines.ad_gems.interval_sec=body.changes['routines.ad_gems.interval_sec'];run.profile_revision='r2';
    return clone(run);
  };
  return state;
}
const gets=(state,filter='/api/run-controls')=>state.log.filter(entry=>entry.method==='GET' && entry.url.startsWith(filter)).map(entry=>entry.url);
function savedHost(){
  const status={textContent:''},doc={activeElement:null};
  const input={dataset:{control:'routines.ad_gems.interval_sec'},type:'number',value:'720',valueAsNumber:720,ownerDocument:doc,checkValidity:()=>true,closest(selector){return selector==='[data-control]'?this:null;}};
  const host={isConnected:true,innerHTML:'',textContent:'',ownerDocument:doc,status,input,
    querySelector:selector=>selector==='.rw-status'?status:null,querySelectorAll:selector=>selector==='[data-control]'?[input]:[]};
  host.type=value=>{input.value=String(value);input.valueAsNumber=value;doc.activeElement=input;host.oninput({target:input});};
  return host;
}

test('the idle dashboard host shows the saved template read-only, labelled for the next start, and never the Runs-only sentence',async()=>{
  const state=server(),live=blankHost(),saved=blankHost();
  const workspace=UI.create({request:state.request});
  try {
    workspace.attach({live,saved,context:'c',liveVariant:'dashboard'});await settle();
    assert.match(live.innerHTML,/<strong>Next start<\/strong><\/div><span role="status" class="rw-status">No tracked battle<\/span>/);
    assert.match(live.innerHTML,/Select a run to see its saved settings\./);
    assert.doesNotMatch(live.innerHTML+live.textContent,/No active battle/);
    const snapshot=await workspace.preview('bp_farm',{label:'Farm'});
    assert.equal(snapshot.blueprint,'farm');
    assert.deepEqual(gets(state),['/api/run-controls?blueprint=bp_farm']);
    assert.equal(state.log.filter(entry=>entry.method!=='GET').length,0,'preview never writes');
    assert.equal(workspace.selected(),'','the Runs selection is untouched');assert.equal(saved.innerHTML+saved.textContent,'','the Runs editor host is untouched');
    assert.match(live.innerHTML,/<div class="rw-dashboard-title"><strong>Next start · Farm<\/strong><small>Saved settings, planned for the next start — not what is running now<\/small><\/div><a class="rw-edit-link" data-run="bp_farm" href="#runs">Edit in Runs<\/a><span role="status" class="rw-status">No tracked battle<\/span>/);
    assert.match(live.innerHTML,/data-routine="ad_gems"><strong class="rw-summary-name">Ad gems<\/strong><span class="rw-summary-state" data-state="on">On at next start<\/span><span class="rw-summary-interval">Every 12m 00s<\/span><span class="rw-action"><button type="button" class="small ghost" data-idle-action="ad_gems" disabled aria-label="Run now: Ad gems \(unavailable\)">Run now<\/button><\/span><small class="rw-action-reason">Needs a tracked battle<\/small>/);
    assert.deepEqual(values(live.innerHTML,'data-idle-action'),['ad_gems','floating_gems','shopping'],'one placeholder per primary routine the run kind supports');
    assert.match(live.innerHTML,/<small class="rw-summary-scope">Saved template · Farm<\/small>/);assert.match(live.innerHTML,/Keep \$250,000/);
    assert.match(live.innerHTML,/<p class="rw-summary-other">At next start: Rewards on · Abilities on · Rescue off · Repeat on<\/p>/);
    assert.match(live.innerHTML,/<details class="rw-summary-queue-all" data-queue-all ><summary class="rw-summary-more">All 5 priorities<\/summary>/);
    assert.doesNotMatch(live.innerHTML,/data-countdown|data-action=|data-control|<input|data-routine-outcome|Last result|>On<|collecting/i);
  } finally {workspace.destroy();}
});

test('saved placeholders state why Run now is unavailable for the battle state and the run\'s own plan',()=>{
  const snapshot=savedSnapshot('farm',720);
  for(const [battle,reason] of [['none','Needs a tracked battle'],['unavailable','Battle status unavailable'],['loading','Checking for a tracked battle']]){
    const html=UI.previewHTML({battle,error:'offline',preview:{name:'bp_farm',label:'Farm',status:'ready',snapshot}});
    assert.equal(count(html,`<small class="rw-action-reason">${reason}</small>`),3,battle);
  }
  const legacy=UI.previewHTML({battle:'none',preview:{name:'bp_farm',label:'Farm',status:'ready',snapshot:{...snapshot,settings:{...snapshot.settings,shopping_plan:null}}}});
  assert.match(legacy,/data-idle-action="shopping" disabled[^>]*>Run now<\/button><\/span><small class="rw-action-reason">Needs a shopping queue plan<\/small>/);
  const collector=UI.previewHTML({battle:'none',preview:{name:'bp_gems',label:'Gems',status:'ready',snapshot:{...snapshot,capabilities:{controls:collectorCaps.controls,actions:[]}}}});
  assert.deepEqual(values(collector,'data-idle-action'),['ad_gems','floating_gems']);assert.doesNotMatch(collector,/Shopping priority/);
  assert.match(UI.previewHTML({battle:'unavailable',error:'HTTP 502',preview:null}),/<span role="status" class="rw-status">Battle status unavailable: HTTP 502<\/span>/);
});

test('a placeholder Run now has no click path, even on a host that just showed a battle',async()=>{
  const state=server(),live=blankHost();
  state.battle=battle();
  const workspace=UI.create({request:state.request});
  try {
    workspace.attach({live,context:'c',liveVariant:'dashboard'});await settle();
    assert.match(live.innerHTML,/data-action="ad_gems"/);
    await workspace.preview('bp_farm',{label:'Farm'});
    state.battle=null;await workspace.poll();
    assert.match(live.innerHTML,/data-idle-action="ad_gems"/);
    const placeholder={disabled:true,dataset:{idleAction:'ad_gems'}};
    live.onclick({target:{closest:selector=>selector==='[data-idle-action]'?placeholder:null}});
    live.onclick({target:{closest:()=>null}});
    await settle();
    assert.equal(state.log.filter(entry=>entry.method!=='GET').length,0);
    assert.deepEqual([...new Set(state.log.map(entry=>entry.url.split('?')[0]))].sort(),['/api/battles/active','/api/run-controls']);
  } finally {workspace.destroy();}
});

test('the default live variant keeps its idle sentences',async()=>{
  const state=server(),live=blankHost();
  const workspace=UI.create({request:state.request});
  try {
    workspace.attach({live});await settle();
    assert.equal(live.textContent,'No active battle. Saved controls are available in Runs.');
    state.battleError=new Error('offline');await workspace.poll();
    assert.equal(live.textContent,'Live controls unavailable: offline');
  } finally {workspace.destroy();}
});

test('a failed battle read keeps the saved template and says the battle status is unavailable',async()=>{
  const state=server(),live=blankHost();
  const workspace=UI.create({request:state.request});
  try {
    workspace.attach({live,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.preview('bp_farm',{label:'Farm'});
    state.battleError=new Error('offline');await workspace.poll();
    assert.match(live.innerHTML,/<span role="status" class="rw-status">Battle status unavailable: offline<\/span>/);
    assert.match(live.innerHTML,/Every 12m 00s/);assert.match(live.innerHTML,/<small class="rw-action-reason">Battle status unavailable<\/small>/);
  } finally {workspace.destroy();}
});

test('a Runs selection is never changed by a preview of another run',async()=>{
  const state=server(),live=blankHost(),saved=savedHost();
  const workspace=UI.create({request:state.request});
  try {
    workspace.attach({live,saved,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.choose('farm');saved.type(700);
    await workspace.preview('bp_tour',{label:'Tour'});
    assert.equal(workspace.selected(),'farm');
    assert.equal(state.log.filter(entry=>entry.method==='POST').length,0,'the pending Runs draft is not flushed by a preview');
    await debounce();await settle();
    assert.equal(state.log.filter(entry=>entry.method==='POST').length,1,'the draft still saves on its own debounce');
  } finally {workspace.destroy();}
});

test('previews share in-flight and cached reads, and force reads again',async()=>{
  const state=server(),live=blankHost();
  const workspace=UI.create({request:state.request});
  try {
    workspace.attach({live,context:'c',liveVariant:'dashboard'});await settle();
    state.gates.bp_farm=deferred();
    const first=workspace.preview('bp_farm'),second=workspace.preview('bp_farm');
    assert.equal(first,second,'a concurrent read is shared');
    state.gates.bp_farm.resolve();await first;
    await workspace.preview('bp_farm');
    assert.equal(gets(state).length,1,'a cached preview needs no read');
    await workspace.preview('bp_farm',{force:true});
    assert.equal(gets(state).length,2);
  } finally {workspace.destroy();}
});

test('a failed preview shows its own run and error, never the previous run under the new label',async()=>{
  const state=server(),live=blankHost(),seen=[];
  const errors=[];
  const workspace=UI.create({request:state.request,onPreview:(snapshot,info)=>{seen.push([snapshot?.blueprint ?? null,info.status,info.blueprint]);if(info.status==='error')errors.push(info.error);}});
  try {
    workspace.attach({live,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.preview('bp_farm',{label:'Farm'});
    state.fail.bp_tour=new Error('boom');
    state.gates.bp_tour=deferred();
    const pending=workspace.preview('bp_tour',{label:'Tour'});
    assert.match(live.innerHTML,/Loading saved settings for Tour…/);assert.doesNotMatch(live.innerHTML,/Every 12m 00s/);
    state.gates.bp_tour.resolve();
    assert.equal(await pending,null);
    assert.match(live.innerHTML,/<p class="rw-preview-message warn">Saved settings for Tour unavailable: boom<\/p>/);
    assert.doesNotMatch(live.innerHTML,/Every 12m 00s|Farm/);
    state.runs.odd=savedSnapshot('other',100);
    assert.equal(await workspace.preview('bp_odd',{label:'Odd'}),null,'a reply for another run is rejected');
    assert.match(live.innerHTML,/Saved settings for Odd unavailable: Saved settings response did not match the selected run/);
    assert.equal(errors.at(-1),'Saved settings response did not match the selected run');
    assert.deepEqual(seen,[[null,'empty',''],[null,'loading','bp_farm'],['farm','ready','bp_farm'],[null,'loading','bp_tour'],[null,'error','bp_tour'],[null,'loading','bp_odd'],[null,'error','bp_odd']]);
  } finally {workspace.destroy();}
});

test('stale preview replies are ignored after a newer selection or a context change',async()=>{
  const state=server(),live=blankHost(),seen=[];
  const workspace=UI.create({request:state.request,onPreview:(snapshot,info)=>seen.push([snapshot?.blueprint ?? null,info.status,info.blueprint,info.context])});
  try {
    workspace.attach({live,context:'c',liveVariant:'dashboard'});await settle();
    state.gates.bp_farm=deferred();
    const farm=workspace.preview('bp_farm',{label:'Farm'}),tour=workspace.preview('bp_tour',{label:'Tour'});
    assert.equal((await tour).blueprint,'tour');
    state.gates.bp_farm.resolve();assert.equal(await farm,null);
    assert.match(live.innerHTML,/Next start · Tour/);assert.doesNotMatch(live.innerHTML,/Next start · Farm/);
    state.gates.bp_farm=deferred();
    const late=workspace.preview('bp_farm',{label:'Farm',force:true});
    workspace.attach({live,context:'other',liveVariant:'dashboard'});
    state.gates.bp_farm.resolve();assert.equal(await late,null);
    await settle();
    assert.doesNotMatch(live.innerHTML,/Next start · Farm|Every 12m 00s/);
    assert.ok(!seen.some(([blueprint,status,name,context])=>status==='ready' && (name==='bp_farm' || context==='other')),'no stale snapshot is published');
    assert.deepEqual(seen.at(-1),[null,'empty','','other']);
  } finally {workspace.destroy();}
});

test('a preview survives a host remount in the same context without another read',async()=>{
  const state=server(),first=blankHost(),second=blankHost();
  const workspace=UI.create({request:state.request});
  try {
    workspace.attach({live:first,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.preview('bp_farm',{label:'Farm'});
    workspace.attach({live:second,context:'c',liveVariant:'dashboard'});
    assert.match(second.innerHTML,/Next start · Farm/);
    await settle();assert.equal(gets(state).length,1);
  } finally {workspace.destroy();}
});

test('an empty selection clears the preview and may carry a message',async()=>{
  const state=server(),live=blankHost(),seen=[];
  const workspace=UI.create({request:state.request,onPreview:(snapshot,info)=>seen.push([snapshot,info.status,info.blueprint])});
  try {
    workspace.attach({live,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.preview('bp_farm');
    assert.equal(await workspace.preview('',{label:'Combo (day plan)',message:'The day plan picks a run for each block.'}),null);
    assert.match(live.innerHTML,/data-preview-state="empty"/);assert.match(live.innerHTML,/<strong>Next start · Combo \(day plan\)<\/strong><\/div><span role="status"/);
    assert.match(live.innerHTML,/<p class="rw-preview-message">The day plan picks a run for each block\.<\/p>/);
    assert.doesNotMatch(live.innerHTML,/rw-edit-link|Every 12m/);
    assert.deepEqual(seen.at(-1),[null,'empty','']);assert.equal(gets(state).length,1);
  } finally {workspace.destroy();}
});

test('an acknowledged saved write re-reads the preview of the same run only',async()=>{
  const state=server(),live=blankHost(),saved=savedHost(),seen=[];
  const workspace=UI.create({request:state.request,onPreview:(snapshot,info)=>seen.push([snapshot?.settings.routines.ad_gems.interval_sec ?? null,info.status,info.blueprint])});
  try {
    workspace.attach({live,saved,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.choose('farm');
    await workspace.preview('bp_farm',{label:'Farm'});
    saved.type(700);await debounce();await settle();await settle();
    assert.equal(saved.status.textContent,'Saved');
    assert.deepEqual(gets(state,'/api/run-controls?blueprint=bp_farm').length,2,'the displayed preview of the edited run is read again');
    assert.match(live.innerHTML,/Every 11m 40s/);
    assert.deepEqual(seen.slice(-2),[[null,'loading','bp_farm'],[700,'ready','bp_farm']]);
    await workspace.preview('bp_tour',{label:'Tour'});
    const before=gets(state).length;
    saved.type(710);await debounce();await settle();await settle();
    assert.equal(gets(state).length,before,'another run\'s preview is not re-read');
    await workspace.preview('bp_farm',{label:'Farm'});
    assert.equal(gets(state).length,before+1,'the edited run\'s cached preview was dropped');
    assert.match(live.innerHTML,/Every 11m 50s/);
  } finally {workspace.destroy();}
});

test('a failing preview observer is reported but never changes a saved write or the preview',async()=>{
  const state=server(),live=blankHost(),saved=savedHost(),errors=[];
  const workspace=UI.create({request:state.request,onError:error=>errors.push(error.message),onPreview:(snapshot)=>{if(snapshot)throw new Error('observer broke');}});
  try {
    workspace.attach({live,saved,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.choose('farm');
    assert.equal((await workspace.preview('bp_farm',{label:'Farm'})).blueprint,'farm');
    assert.match(live.innerHTML,/Every 12m 00s/);
    saved.type(700);await debounce();await settle();await settle();
    assert.equal(saved.status.textContent,'Saved','the acknowledged write stays saved');
    assert.match(live.innerHTML,/Every 11m 40s/);
    assert.deepEqual(errors,['observer broke','observer broke']);
    await workspace.prepareEntry();
  } finally {workspace.destroy();}
});

test('summary hints carry their marker state and keep it in sync with drafts and overrides',async()=>{
  const html=UI.renderHTML(UI.makeModel('live',battle()),{variant:'dashboard'});
  assert.match(html,/<small data-pending="routines.ad_gems.interval_sec" data-pending-state="override">Default 720 · override<\/small>/);
  assert.match(html,/<small data-pending="routines.ad_gems.enabled" data-pending-state="default">Default true<\/small>/);
  assert.match(html,/<small data-pending="routines.ad_gems.window_sec">Default 60<\/small>/,'the full editor keeps plain hints');
  const doc={activeElement:null},hint={textContent:'',dataset:{pendingState:'default'}};
  const input={dataset:{control:'routines.floating_gems.interval_sec'},type:'number',value:'960',valueAsNumber:960,ownerDocument:doc,checkValidity:()=>true,closest(selector){return selector==='[data-control]'?this:null;}};
  const host={...blankHost(),ownerDocument:doc,querySelector:selector=>selector==='[data-pending="routines.floating_gems.interval_sec"]'?hint:null,querySelectorAll:selector=>selector==='[data-control]'?[input]:[]};
  let snapshot=battle(),release;
  const workspace=UI.create({request:async(url,options)=>{
    if(!options)return {battle:snapshot};
    await new Promise(resolve=>release=resolve);
    return {command:{id:'c',kind:'controls',revision:2,state:'requested'},control_revision:2};
  }});
  try {
    workspace.attach({live:host,liveVariant:'dashboard'});await settle();
    assert.equal(hint.dataset.pendingState,'default');assert.equal(hint.textContent,'Default 960');
    input.value='900';input.valueAsNumber=900;doc.activeElement=input;host.oninput({target:input});
    assert.equal(hint.dataset.pendingState,'pending');assert.equal(hint.textContent,'Pending');
    await debounce();release();await settle();
    snapshot=battle({control_revision:2,applied_revision:2,overrides:{routines:{ad_gems:{interval_sec:600},floating_gems:{interval_sec:900}}}});
    await workspace.poll();
    assert.equal(hint.dataset.pendingState,'override');assert.equal(hint.textContent,'Default 960 · override');
  } finally {workspace.destroy();}
});

test('a failed forced re-read drops the superseded snapshot; returning to the run reads again and never republishes it',async()=>{
  const state=server(),live=blankHost(),seen=[];
  const workspace=UI.create({request:state.request,onPreview:(snapshot,info)=>seen.push([info.status,info.blueprint,snapshot?.settings.routines.ad_gems.enabled ?? null])});
  try {
    workspace.attach({live,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.preview('bp_farm',{label:'Farm'});
    state.runs.farm.settings.routines.ad_gems.enabled=false;
    state.fail.bp_farm=new Error('timeout');
    assert.equal(await workspace.preview('bp_farm',{label:'Farm',force:true}),null);
    assert.match(live.innerHTML,/Saved settings for Farm unavailable: timeout/);assert.doesNotMatch(live.innerHTML,/On at next start/);
    delete state.fail.bp_farm;
    await workspace.preview('bp_tour',{label:'Tour'});
    const before=gets(state).length;
    const back=await workspace.preview('bp_farm',{label:'Farm'});
    assert.equal(gets(state).length,before+1,'the run is read again');
    assert.equal(back.settings.routines.ad_gems.enabled,false);
    const farmReady=seen.filter(([status,name])=>status==='ready' && name==='bp_farm').map(entry=>entry[2]);
    assert.deepEqual(farmReady,[true,false],'the superseded snapshot was published once, before it was superseded');
    assert.deepEqual(seen.at(-1),['ready','bp_farm',false]);
  } finally {workspace.destroy();}
});

function queueDom(){
  const doc={activeElement:null},writes={host:0,section:0};
  const summaryEl={focused:0,focus(){this.focused++;doc.activeElement=summaryEl;},matches:selector=>selector==='[data-queue-all] > summary'};
  const details={open:false};
  const section={dataset:{},_html:'',get innerHTML(){return this._html;},set innerHTML(value){this._html=value;writes.section++;},
    contains:node=>node===summaryEl,querySelector:selector=>selector==='[data-queue-all] > summary'?summaryEl:null};
  const host={isConnected:true,textContent:'',ownerDocument:doc,_html:'',get innerHTML(){return this._html;},set innerHTML(value){this._html=value;writes.host++;},
    contains:node=>node===summaryEl,querySelectorAll:()=>[],
    querySelector:selector=>({'[data-queue-all]':details,'[data-shopping-summary]':section,'[data-queue-all] > summary':summaryEl}[selector] || null)};
  return {doc,writes,summaryEl,details,section,host};
}

test('the live full queue keeps its open state through refreshes, content changes and remounts, per battle',async()=>{
  const dom=queueDom(),at=Date.now()/1000;let snapshot=battle({runtime:{server_time:at}});
  const workspace=UI.create({request:async()=>({battle:snapshot})});
  try {
    workspace.attach({live:dom.host,context:'c',liveVariant:'dashboard'});await settle();
    assert.match(dom.section.innerHTML,/data-queue-all >/);
    dom.details.open=true;dom.details.ontoggle();dom.doc.activeElement=dom.summaryEl;
    const renders=dom.writes.section;
    snapshot=battle({runtime:{server_time:Date.now()/1000}});await workspace.poll();
    assert.equal(dom.writes.section,renders,'opening the queue alone never re-renders it under focus');
    snapshot=battle({runtime:{server_time:Date.now()/1000,routines:{shopping:{state:'scheduled',server_time:Date.now()/1000,last_outcome:{decision:{action:'wait',reason:'unknown_wave'}}}}}});
    await workspace.poll();
    assert.equal(dom.writes.section,renders+1);
    assert.match(dom.section.innerHTML,/data-queue-all open>/);assert.match(dom.section.innerHTML,/Unknown wave/);
    assert.equal(dom.summaryEl.focused,1,'keyboard focus returns to the queue summary');
    const second=queueDom();
    workspace.attach({live:second.host,context:'c',liveVariant:'dashboard'});
    assert.match(second.host.innerHTML,/data-queue-all open>/,'a remount keeps it open');
    await settle();
    snapshot=battle({id:'battle-2',runtime:{server_time:Date.now()/1000}});await workspace.poll();
    assert.match(second.host.innerHTML,/data-queue-all >/,'another battle starts closed');
  } finally {workspace.destroy();}
});

test('the saved template\'s full queue keeps its open state per previewed run without re-rendering under focus',async()=>{
  const state=server(),dom=queueDom();
  const workspace=UI.create({request:state.request});
  try {
    workspace.attach({live:dom.host,context:'c',liveVariant:'dashboard'});await settle();
    await workspace.preview('bp_farm',{label:'Farm'});
    assert.match(dom.host.innerHTML,/data-queue-all >/);
    dom.details.open=true;dom.details.ontoggle();dom.doc.activeElement=dom.summaryEl;
    const renders=dom.writes.host;
    await workspace.poll();await workspace.preview('bp_farm',{label:'Farm'});
    assert.equal(dom.writes.host,renders,'no re-render while nothing changed');
    state.battleError=new Error('offline');await workspace.poll();
    assert.equal(dom.writes.host,renders+1);assert.match(dom.host.innerHTML,/data-queue-all open>/);
    assert.equal(dom.summaryEl.focused,1,'focus returns to the queue summary after a content change');
    await workspace.preview('bp_tour',{label:'Tour'});
    assert.match(dom.host.innerHTML,/data-queue-all >/,'another run starts closed');
    await workspace.preview('bp_farm',{label:'Farm'});
    assert.match(dom.host.innerHTML,/data-queue-all open>/,'returning to the run keeps its open state');
    workspace.attach({live:dom.host,context:'other',liveVariant:'dashboard'});
    assert.doesNotMatch(dom.host.innerHTML,/data-queue-all open/);
  } finally {workspace.destroy();}
});

test('compact summary clocks keep the full state in their title',async()=>{
  const clock={dataset:{countdown:'ad_gems',clockCompact:''},textContent:'',title:''};
  const host={...blankHost(),querySelectorAll:selector=>selector==='[data-countdown]'?[clock]:[]};
  let fail=false;
  const workspace=UI.create({request:async()=>{if(fail)throw new Error('offline');return {battle:battle({runtime:{server_time:Date.now()/1000-60}})};}});
  try {
    workspace.attach({live:host,liveVariant:'dashboard'});await settle();
    assert.equal(clock.textContent,'Stale');assert.equal(clock.title,'Stale observation');
    fail=true;await workspace.poll();
    assert.equal(clock.textContent,'Unavailable');assert.equal(clock.title,'Status unavailable');
  } finally {workspace.destroy();}
});
