const test=require('node:test');
const assert=require('node:assert/strict');
const UI=require('../webui/run-workspace.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const base={routines:{ad_gems:{enabled:false,interval_sec:720,window_sec:60}}};
const context={device_key:'device',instance:'main',account:'account',serial:'fake'};
const battle=(extra={})=>({id:'battle-1',operation_id:'op-1',generation:'driver',status:'active',control_revision:0,applied_revision:0,
  context,envelope:{controls:base},effective:base,overrides:{},capabilities:{controls:['routines.ad_gems.enabled'],actions:['ad_gems']},
  // The driver has just published a status report; tests of a missing or old report pass their own runtime.
  runtime:{server_time:Date.now()/1000},...extra});
function liveHost(){
  const status={textContent:''},feedback={dataset:{commandAction:'ad_gems'},textContent:'',hidden:false};
  const button={dataset:{action:'ad_gems'},disabled:false},retry={hidden:true,disabled:false};
  return {isConnected:true,status,feedback,button,retry,innerHTML:'',textContent:'',ownerDocument:{activeElement:null},
    querySelector(selector){return selector==='.rw-status'?status:selector==='[data-retry-command]'?retry:null;},
    querySelectorAll(selector){return selector==='[data-action]'?[button]:selector==='[data-command-action]'?[feedback]:[];}};
}
const click=(host,selector,node)=>host.onclick({target:{closest:target=>target===selector?node:null}});
function historyHost(){
  const list={innerHTML:''},detail={innerHTML:'',textContent:''},status={textContent:''},filter={value:'',disabled:false};
  const buttons=['refresh','retry','previous','next'].map(kind=>({dataset:{historyCommand:kind},disabled:false,hidden:false}));
  return {list,detail,status,filter,buttons,innerHTML:'',textContent:'',
    querySelector(selector){return {'.rw-history-list':list,'.rw-history-detail':detail,'[data-history-status]':status,'[data-history-filter]':filter}[selector] || null;},
    querySelectorAll(selector){return selector==='[data-history-command]'?buttons:[];}};
}

test('manual pending and active collectors remain visible when automatic collection is off',()=>{
  assert.equal(UI.countdown({manual_pending:true,state:'off',server_time:100},false,102),'Manual request waiting');
  assert.equal(UI.countdown({manual_active:true,state:'active',window_ends_at:110,server_time:100},false,102),'Manual window 8s');
  assert.equal(UI.countdown({manual_active:true,state:'active',server_time:80},false,102),'Stale observation');
  assert.equal(UI.countdown({manual_pending:true,blocker:'waiting_for_game_state',server_time:100},false,102),'Waiting for game state');
});

test('command feedback separates acceptance, waiting, execution and terminal reward evidence',()=>{
  for(const [state,title] of [['requested','Accepted'],['pending','Waiting'],['started','Executing'],['completed','Finished'],['failed','Failed'],['rejected','Rejected'],['expired','Expired']]){
    const model=UI.makeModel('live',battle({commands:[{id:'cmd',kind:'action',payload:{action:'ad_gems'},state,requested_at:90,updated_at:95,reason:'screen_not_owned'}]}));
    const feedback=UI.commandFeedback(model,'ad_gems',true,100);
    assert.match(feedback,new RegExp(`^${title} · 5s ago · Screen not owned`));
    if(state==='completed')assert.match(feedback,/Reward outcome unknown/);
  }
  assert.match(UI.resultText('ad_gems',{confirmed:true}),/Claim disappeared; balance total unknown/);
  assert.equal(UI.resultText('floating_gems',{confirmed:true}),'Balance +2 confirmed');
  assert.match(UI.resultText('ad_gems',{confirmed:false,reason:'timeout'}),/Unconfirmed: Timeout/);
});

test('lost action acknowledgement blocks another action and retries the identical idempotency payload',async()=>{
  const host=liveHost(),writes=[];let fail=true,snapshot=battle();
  const workspace=UI.create({request:async(url,options)=>{
    if(!options)return {battle:snapshot};
    writes.push(JSON.parse(options.body));
    if(fail)throw new Error('response lost');
    return {command:{id:'cmd',state:'requested'}};
  }});
  try {
    workspace.attach({live:host,context:'first'});await settle();
    click(host,'[data-action]',host.button);await settle();
    assert.equal(host.button.disabled,true);assert.equal(host.retry.hidden,false);
    assert.match(host.feedback.textContent,/outcome unknown/);
    click(host,'[data-action]',host.button);await settle();assert.equal(writes.length,1);
    fail=false;click(host,'[data-retry-command]',host.retry);await settle();
    assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);
    assert.match(host.feedback.textContent,/Accepted/);assert.equal(host.button.disabled,true);
    snapshot=battle({commands:[{id:'cmd',state:'completed',kind:'action',payload:{action:'ad_gems'},evidence:{confirmed:false,reason:'timeout'},updated_at:Date.now()/1000}]});
    await workspace.poll();assert.equal(host.button.disabled,false);
    assert.match(host.feedback.textContent,/Finished.*Unconfirmed: Timeout/);
  } finally {workspace.destroy();}
});

test('late action receipt cannot replace a successor battle or leak its result',async()=>{
  const host=liveHost();let release,snapshot=battle();
  const workspace=UI.create({request:async(url,options)=>{
    if(!options)return {battle:snapshot};
    await new Promise(resolve=>release=resolve);
    return {battle:battle(),command:{id:'old',state:'completed',evidence:{confirmed:true}}};
  }});
  try {
    workspace.attach({live:host});await settle();click(host,'[data-action]',host.button);
    snapshot=battle({id:'battle-2',operation_id:'op-2'});await workspace.poll();
    release();await settle();assert.equal(host.feedback.textContent,'');assert.equal(host.button.disabled,false);
  } finally {workspace.destroy();}
});

test('uncertain control acknowledgement retries its exact revision and idempotency key before showing applied',async()=>{
  const host=liveHost(),writes=[];
  const input={dataset:{control:'routines.ad_gems.enabled'},type:'checkbox',checked:false,ownerDocument:host.ownerDocument,closest:selector=>selector==='[data-control]'?input:null};
  const original=host.querySelectorAll.bind(host);
  host.querySelectorAll=selector=>selector==='[data-control]'?[input]:original(selector);
  let snapshot=battle(),fail=true;
  const command={id:'controls',kind:'controls',payload:{routines:{ad_gems:{enabled:true}}},revision:1,state:'applied'};
  const workspace=UI.create({request:async(url,options)=>{
    if(!options)return {battle:snapshot};
    writes.push(JSON.parse(options.body));
    snapshot=battle({control_revision:1,applied_revision:1,effective:{routines:{ad_gems:{enabled:true}}},commands:[command]});
    if(fail)throw new Error('reply lost');
    return {command,battle:snapshot};
  }});
  try {
    workspace.attach({live:host});await settle();
    input.checked=true;host.oninput({target:input});await new Promise(resolve=>setTimeout(resolve,470));
    assert.equal(writes.length,1);assert.equal(host.retry.hidden,false);assert.match(host.status.textContent,/outcome unknown/);
    await workspace.poll();assert.equal(writes.length,1);
    fail=false;click(host,'[data-retry-command]',host.retry);await settle();
    assert.deepEqual(writes[1],writes[0]);assert.equal(host.retry.hidden,true);
    assert.equal(host.status.textContent,'Driver acknowledged');assert.equal(input.checked,true);
  } finally {workspace.destroy();}
});

test('rejected and expired controls release pending drafts without inventing an applied revision',()=>{
  for(const state of ['rejected','expired']){
    const model=UI.makeModel('live',battle());
    model.pending['routines.ad_gems.enabled']={value:true,revision:1};
    UI.refresh(model,battle({control_revision:1,applied_revision:0,commands:[{kind:'controls',id:'cmd',revision:1,state,reason:'battle_ended'}]}));
    assert.deepEqual(model.pending,{});assert.equal(model.snapshot.applied_revision,0);
    assert.equal(UI.fieldValue(model,'routines.ad_gems.enabled'),false);assert.equal(model.error,'battle_ended');
  }
});

test('history pagination and filtering preserve selected details and last-known records on read failure',async()=>{
  const host=historyHost(),urls=[];let failing=false;
  const workspace=UI.create({request:async url=>{
    urls.push(url);if(failing)throw new Error('offline');
    const parsed=new URL(url,'http://local');
    if(parsed.pathname.startsWith('/api/battles/'))return {battle:battle(),events:[],context};
    const offset=Number(parsed.searchParams.get('offset'));
    return {context,battles:Array.from({length:21},(_,i)=>battle({id:`battle-${offset+i+1}`}))};
  }});
  try {
    workspace.attach({history:host,context:'first'});await workspace.history('main');await workspace.detail('battle-1');
    const originalDetail=host.detail.innerHTML,originalRows=host.list.innerHTML;
    failing=true;await workspace.history('main');
    assert.equal(host.list.innerHTML,originalRows);assert.equal(host.detail.innerHTML,originalDetail);
    assert.match(host.status.textContent,/Last known records retained/);
    await workspace.detail('battle-1');assert.match(host.detail.innerHTML,/Last known detail retained/);assert.ok(host.detail.innerHTML.includes(originalDetail));
    failing=false;click(host,'[data-history-command]',host.buttons.find(b=>b.dataset.historyCommand==='next'));await settle();
    assert.ok(urls.includes('/api/battles?instance=main&limit=21&offset=20'));
    host.filter.value='ended';host.onchange({target:{closest:selector=>selector==='[data-history-filter]'?host.filter:null}});await settle();
    assert.ok(urls.includes('/api/battles?instance=main&limit=21&offset=0&status=ended'));
    assert.ok(urls.includes('/api/battles/battle-1?instance=main'));
  } finally {workspace.destroy();}
});

test('history activity renders string messages and structured observations without object coercion',async()=>{
  const host=historyHost();
  const cases=[
    [{reason:'driver_observation_lost',status:'ignored'},'driver_observation_lost'],
    [{reason:'',status:'started'},'started'],
    [{status:{observation_status:'waiting_for_game_state',observed_wave:null}},'Waiting for game state'],
    [{status:{observation_status:'observing',observed_wave:42}},'Observing · Wave 42'],
    [{status:{observation_status:'observing',observed_wave:0}},'Observing · Wave 0'],
    [{status:{observed_wave:7}},'Wave 7'],
    [{status:{observation_status:'observing',observed_wave:'42'}},'Observing'],
    [{status:{observation_status:'observing',observed_wave:Infinity}},'Observing'],
    [{status:{observation_status:{value:'observing'},observed_wave:NaN}},''],
    [{reason:{detail:'unsupported'},status:{routines:{}}},''],
    [{status:['unsupported']},''],
    [{status:null},''],
    [{reason:'<b>lost & "unknown"</b>'},'&lt;b&gt;lost &amp; &quot;unknown&quot;&lt;/b&gt;'],
    [{status:'<script>alert(1)</script>'},'&lt;script&gt;alert(1)&lt;/script&gt;'],
    [{status:{observation_status:'<img src=x onerror="bad">',observed_wave:1}},'&lt;img src=x onerror=&quot;bad&quot;&gt; · Wave 1']
  ];
  const workspace=UI.create({request:async()=>({battle:battle(),events:cases.map(([event])=>({kind:'status',...event})),context})});
  try {
    workspace.attach({history:host});await workspace.detail('battle-1');
    const activity=host.detail.innerHTML.split('<div class="rw-activity">')[1];
    assert.ok(activity,'recorded activity rendered');
    assert.deepEqual([...activity.matchAll(/<small>(.*?)<\/small>/g)].map(match=>match[1]),cases.map(([,expected])=>expected));
    assert.doesNotMatch(activity,/\[object Object\]|<script>|<img /);
  } finally {workspace.destroy();}
});

test('overlapping detail reads for the same battle retain the newest response',async()=>{
  const host=historyHost(),releases=[];
  const workspace=UI.create({request:()=>new Promise(resolve=>releases.push(resolve))});
  try {
    workspace.attach({history:host});const first=workspace.detail('battle-1'),second=workspace.detail('battle-1');
    releases[1]({battle:battle({label:'newer'}),events:[]});await second;
    releases[0]({battle:battle({label:'older'}),events:[]});await first;
    assert.match(host.detail.innerHTML,/newer/);assert.doesNotMatch(host.detail.innerHTML,/older/);
  } finally {workspace.destroy();}
});

test('history and detail responses cannot cross a changed context even if the host is reused',async()=>{
  const host=historyHost();let release,reads=0;
  const workspace=UI.create({request:async url=>{
    reads++;
    if(reads===1)return {context,battles:[battle()]};
    return new Promise(resolve=>release=resolve);
  }});
  try {
    workspace.attach({history:host,context:'first'});await workspace.history('main');
    const pending=workspace.detail('battle-1');
    workspace.attach({history:host,context:'second'});
    host.detail.innerHTML='replacement context';
    release({context,battle:battle({label:'old context'}),events:[]});await pending;
    assert.equal(host.detail.innerHTML,'replacement context');
  } finally {workspace.destroy();}
});

test('history rejects mismatched account records and keeps the last successful page',async()=>{
  const host=historyHost();let bad=false;
  const workspace=UI.create({request:async()=>({context,battles:[battle(bad?{context:{...context,account:'other'}}:{})]})});
  try {
    workspace.attach({history:host});await workspace.history('main');const rows=host.list.innerHTML;
    bad=true;await workspace.history('main');
    assert.equal(host.list.innerHTML,rows);assert.match(host.status.textContent,/another device context/);
  } finally {workspace.destroy();}
});

test('recorded collection evidence labels its scope and keeps aggregate gem totals unknown',()=>{
  const html=UI.historySummaryHTML(battle({created_at:100,runtime:{collection_evidence:{generation:'driver',started_at:100,coverage:'sampled_driver_observations',ad_claim_confirmations:2,orbit_balance_confirmations:3,orbit_recorded_increase:6}}}));
  assert.match(html,/Ad claims 2.*Orbit \+2 confirmations 3.*recorded increase \+6/);
  assert.match(html,/gaps may exist/);assert.match(html,/not its balance increase/);assert.match(html,/Gem total unknown/);
});

test('history never displays malformed or cross-segment confirmation totals',()=>{
  const evidence={generation:'driver',started_at:100,coverage:'sampled_driver_observations',ad_claim_confirmations:2,orbit_balance_confirmations:3,orbit_recorded_increase:6};
  for(const change of [{generation:'older'}, {started_at:99}, {ad_claim_confirmations:-1}, {orbit_recorded_increase:8}]){
    const html=UI.historySummaryHTML(battle({created_at:100,runtime:{collection_evidence:{...evidence,...change}}}));
    assert.match(html,/Not recorded/);assert.doesNotMatch(html,/Ad claims 2/);
  }
});

/* Live command outcomes. The transport mirrors index.html api(): a server
   refusal is an Error carrying the HTTP status; a lost reply has none. */
const httpError=(status,message)=>Object.assign(new Error(message),status===undefined?{}:{status});
const debounce=()=>new Promise(resolve=>setTimeout(resolve,470));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const controlBase={routines:{ad_gems:{enabled:true,interval_sec:720,window_sec:60}}};
const controlled=(extra={})=>battle({envelope:{controls:controlBase},effective:controlBase,overrides:{routines:{ad_gems:{enabled:true}}},
  capabilities:{controls:['routines.ad_gems.enabled','routines.ad_gems.interval_sec'],actions:['ad_gems']},...extra});
function controlHost(){
  const host=liveHost(),reset={disabled:false},control={dataset:{commandControl:'routines.ad_gems.interval_sec'},textContent:''};
  const input={dataset:{control:'routines.ad_gems.interval_sec'},type:'number',value:'720',valueAsNumber:720,ownerDocument:host.ownerDocument,
    checkValidity:()=>true,closest(selector){return selector==='[data-control]'?this:null;}};
  const query=host.querySelector.bind(host),queryAll=host.querySelectorAll.bind(host);
  host.querySelector=selector=>selector==='[data-reset]'?reset:query(selector);
  host.querySelectorAll=selector=>selector==='[data-control]'?[input]:selector==='[data-command-control]'?[control]:queryAll(selector);
  host.ownerDocument.activeElement=input;
  return Object.assign(host,{reset,control,input,type(value){input.value=String(value);input.valueAsNumber=value;host.oninput({target:input});}});
}
function transport(state){
  return async(url,options)=>{
    if(!options){
      state.reads=(state.reads || 0)+1;
      if(state.readGate)await state.readGate.promise;
      if(state.readError)throw state.readError;
      return {battle:state.snapshot};
    }
    const body=JSON.parse(options.body);state.writes.push({url,body});
    const reply=state.replies.shift();
    if(reply instanceof Promise)return reply;
    if(reply instanceof Error)throw reply;
    if(typeof reply==='function')return reply(body);
    return reply;
  };
}

for(const [status,message] of [[400,'Unsupported controls: routines.ad_gems.interval_sec'],[404,'Unknown battle or operation'],[409,'Control revision changed']])
test(`a ${status} control refusal records nothing, restores observed values and releases the panel`,async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[()=>{state.snapshot=controlled({control_revision:3,applied_revision:3});throw httpError(status,message);},
    body=>({command:{id:'accepted',kind:'controls',revision:4,state:'requested'},control_revision:4})]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    assert.equal(state.writes.length,1);
    assert.equal(host.status.textContent,`Refused: ${message}. Nothing was recorded.`);
    assert.doesNotMatch(host.status.textContent,/outcome unknown/);
    assert.equal(String(host.input.value),'720','the focused field shows the observed value, not the refused one');
    assert.equal(host.control.textContent,`Refused · ${message}`);
    assert.equal(host.retry.hidden,true);
    assert.equal(host.reset.disabled,false);assert.equal(host.button.disabled,false);
    click(host,'[data-retry-command]',host.retry);await settle();
    for(let i=0;i<2;i++)await workspace.poll();
    assert.equal(state.writes.length,1,'a refusal is never resent');
    assert.match(host.status.textContent,/^Refused: /);
    host.type(90);assert.equal(host.status.textContent,'Pending');await debounce();
    assert.equal(state.writes.length,2);
    assert.equal(state.writes[1].body.expected_revision,3,'the next send uses the revision read after the refusal');
    assert.deepEqual(state.writes[1].body.changes,{'routines.ad_gems.interval_sec':90});
    assert.notEqual(state.writes[1].body.idempotency_key,state.writes[0].body.idempotency_key);
  } finally {workspace.destroy();}
});

for(const status of [undefined,500,502,408,429])
test(`a ${status ?? 'lost'} control reply stays outcome unknown with an identical retry`,async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(status,'reply unavailable'),{command:{id:'c',kind:'controls',revision:1,state:'requested'},control_revision:1}]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    for(let i=0;i<2;i++)await workspace.poll();
    assert.equal(host.status.textContent,'Command acknowledgement unavailable; outcome unknown: reply unavailable');
    assert.equal(host.control.textContent,'Acknowledgement unavailable · outcome unknown');
    assert.equal(host.retry.hidden,false);assert.equal(host.reset.disabled,true);assert.equal(host.button.disabled,true);
    assert.equal(state.writes.length,1);
    click(host,'[data-retry-command]',host.retry);await settle();
    assert.deepEqual(state.writes[1],state.writes[0]);
    assert.equal(host.retry.hidden,true);assert.equal(host.status.textContent,'Pending');
  } finally {workspace.destroy();}
});

for(const [status,message,expected] of [[409,'Battle has ended','Retry refused: Battle has ended. Whether the first attempt was recorded is unknown.'],
  [404,'Unknown battle or operation','Retry refused: Unknown battle or operation. Whether the first attempt was recorded is unknown.'],
  [400,'Unsupported controls: routines.ad_gems.interval_sec','Refused: Unsupported controls: routines.ad_gems.interval_sec. Nothing was recorded.']])
test(`a ${status} refused control retry reports what the retry proves`,async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(undefined,'socket closed'),httpError(status,message)]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    click(host,'[data-retry-command]',host.retry);await settle();await settle();
    assert.deepEqual(state.writes[1],state.writes[0]);
    assert.equal(host.status.textContent,expected);
    assert.equal(host.control.textContent,status===400?`Refused · ${message}`:'Retry refused · first attempt unconfirmed');
    assert.equal(host.retry.hidden,true);assert.equal(String(host.input.value),'720');
    await workspace.poll();assert.equal(state.writes.length,2);assert.equal(host.status.textContent,expected);
  } finally {workspace.destroy();}
});

test('a refused manual action is reported as refused and a new click is a new command',async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(409,'Another manual action is pending or active'),{command:{id:'second',state:'requested'}}]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    click(host,'[data-action]',host.button);await settle();await settle();
    assert.equal(host.feedback.textContent,'Refused · Another manual action is pending or active');
    assert.equal(host.status.textContent,'Refused: Another manual action is pending or active. Nothing was recorded.');
    assert.equal(host.retry.hidden,true);assert.equal(host.button.disabled,false);
    click(host,'[data-retry-command]',host.retry);await settle();assert.equal(state.writes.length,1);
    click(host,'[data-action]',host.button);await settle();
    assert.equal(state.writes.length,2);assert.notEqual(state.writes[1].body.idempotency_key,state.writes[0].body.idempotency_key);
    assert.match(host.feedback.textContent,/^Accepted/);assert.equal(host.button.disabled,true);
  } finally {workspace.destroy();}
});

test('a refused manual action retry releases the panel without claiming the first click failed',async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(undefined,'socket closed'),httpError(409,'Driver operation is not active')]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    click(host,'[data-action]',host.button);await settle();
    assert.equal(host.feedback.textContent,'Acknowledgement unavailable · outcome unknown');
    click(host,'[data-retry-command]',host.retry);await settle();await settle();
    assert.deepEqual(state.writes[1],state.writes[0]);
    assert.equal(host.feedback.textContent,'Retry refused · first attempt unconfirmed');
    assert.equal(host.status.textContent,'Retry refused: Driver operation is not active. Whether the first attempt was recorded is unknown.');
    assert.equal(host.retry.hidden,true);assert.equal(host.button.disabled,false);
  } finally {workspace.destroy();}
});

test('an edit typed during a refused send is kept and sent only after a read requested after the refusal',async()=>{
  const host=controlHost(),inflight=deferred(),state={snapshot:controlled(),writes:[],replies:[inflight.promise,body=>({command:{id:'next',kind:'controls',revision:3,state:'requested'},control_revision:3})]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();assert.equal(state.writes.length,1);
    host.type(90);await debounce();assert.equal(state.writes.length,1);
    state.readGate=deferred();const earlier=workspace.poll();await settle();
    state.snapshot=controlled({control_revision:2,applied_revision:2});
    inflight.reject(httpError(409,'Control revision changed'));await settle();await settle();
    assert.equal(host.status.textContent,'Refused: Control revision changed. Nothing was recorded.');
    assert.equal(host.input.value,'90','the newer focused edit is not replaced');
    assert.equal(host.button.disabled,true);assert.equal(host.reset.disabled,true);
    const gate=state.readGate;state.readGate=null;gate.resolve();await earlier;await settle();
    assert.equal(state.writes.length,1,'a read started before the refusal cannot release the held edit');
    await workspace.poll();await settle();
    assert.equal(state.writes.length,2);
    assert.equal(state.writes[1].body.expected_revision,2);
    assert.deepEqual(state.writes[1].body.changes,{'routines.ad_gems.interval_sec':90});
    assert.equal(host.status.textContent,'Pending');assert.equal(host.input.value,'90');
  } finally {workspace.destroy();}
});

test('a refusal for a replaced battle cannot change the successor panel',async()=>{
  const host=controlHost(),inflight=deferred(),state={snapshot:controlled(),writes:[],replies:[inflight.promise,{command:{id:'successor',kind:'controls',revision:1,state:'requested'},control_revision:1}]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();
    state.snapshot=controlled({id:'battle-2',operation_id:'op-2',generation:'successor'});await workspace.poll();
    inflight.reject(httpError(409,'Stale battle driver or operation'));await settle();await settle();
    assert.equal(host.status.textContent,'Driver acknowledged');assert.equal(host.control.textContent,'');
    assert.equal(host.retry.hidden,true);assert.equal(host.button.disabled,false);
    host.type(75);await debounce();
    assert.equal(state.writes.length,2);assert.equal(state.writes[1].url,'/api/operations/op-2/live-controls');
    assert.equal(state.writes[1].body.battle_id,'battle-2');assert.equal(state.writes[1].body.expected_revision,0);
  } finally {workspace.destroy();}
});

for(const kind of ['action','controls'])test(`an unknown ${kind} outcome survives live read failure and recovery`,async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(undefined,'socket closed'),{command:{id:'retried',kind,revision:1,state:'requested'},control_revision:1}]};
  const workspace=UI.create({request:transport(state)});
  const unknown='Command acknowledgement unavailable; outcome unknown: socket closed';
  try {
    workspace.attach({live:host});await settle();
    if(kind==='action'){click(host,'[data-action]',host.button);await settle();}
    else {host.type(60);await debounce();await settle();}
    assert.equal(host.status.textContent,unknown);
    state.readError=new Error('timeout');await workspace.poll();await workspace.poll();
    assert.equal(host.status.textContent,`${unknown} · Live observation unavailable: timeout`);
    assert.equal(host.retry.hidden,false);assert.equal(host.retry.disabled,true);
    state.readError=null;await workspace.poll();
    assert.equal(host.status.textContent,unknown);
    assert.equal(host.retry.hidden,false);assert.equal(host.retry.disabled,false);assert.equal(host.button.disabled,true);
    click(host,'[data-retry-command]',host.retry);await settle();
    assert.deepEqual(state.writes[1],state.writes[0]);assert.equal(host.retry.hidden,true);
  } finally {workspace.destroy();}
});

for(const [status,message] of [[409,'Saved run changed; refresh before editing again'],[400,'Interval must be at least 5']])
test(`saved run controls keep their ${status} error and draft behavior`,async()=>{
  const host=controlHost(),urls=[],writes=[];let fail=true;
  const workspace=UI.create({request:async(url,options)=>{
    urls.push(url);
    if(!options)return {blueprint:'farm',context:{instance:'i',account:'a',profile:'p'},profile_revision:'r1',settings:controlBase,capabilities:controlled().capabilities};
    const body=JSON.parse(options.body);writes.push(body);
    if(fail)throw httpError(status,message);
    return {blueprint:'farm',profile_revision:'r2',settings:{routines:{ad_gems:{...controlBase.routines.ad_gems,...{interval_sec:body.changes['routines.ad_gems.interval_sec']}}}}};
  }});
  try {
    workspace.attach({saved:host});await workspace.choose('farm');
    host.type(60);await debounce();await settle();
    assert.equal(host.status.textContent,message,'saved errors keep the server message verbatim');
    assert.equal(host.input.value,'60','the saved draft is retained for another attempt');
    assert.ok(!urls.includes('/api/battles/active'),'a saved refusal never reads live battle state');
    fail=false;host.type(61);await debounce();
    assert.equal(writes.length,2);assert.equal(writes[1].expected_revision,'r1');
    assert.deepEqual(writes[1].changes,{'routines.ad_gems.interval_sec':61});
    assert.equal(host.status.textContent,'Saved');
  } finally {workspace.destroy();}
});

/* Request-scoped outcomes (ui-dashboard-live-independent-r1 R1-R8, browser
   F1/O2-O4). Each case mirrors a reproduced probe; the transport mirrors
   index.html api(), which copies the JSON body's code onto the Error. */
const lockError=()=>Object.assign(httpError(409,'Another action is in progress; wait for its result'),{code:'action_lock'});
function withReason(host){
  const reason={dataset:{actionReason:'ad_gems'},textContent:'',hidden:true},all=host.querySelectorAll.bind(host);
  host.querySelectorAll=selector=>selector==='[data-action-reason]'?[reason]:all(selector);
  return Object.assign(host,{reason});
}
function withHint(host){
  const hint={textContent:''},one=host.querySelector.bind(host);
  host.querySelector=selector=>selector==='[data-pending="routines.ad_gems.interval_sec"]'?hint:one(selector);
  return Object.assign(host,{hint});
}
function withClock(host){
  const clock={dataset:{countdown:'ad_gems'},textContent:''},all=host.querySelectorAll.bind(host);
  host.querySelectorAll=selector=>selector==='[data-countdown]'?[clock]:all(selector);
  return Object.assign(host,{clock});
}
const accepted=(revision=1,id='accepted')=>({command:{id,kind:'controls',revision,state:'requested'},control_revision:revision});

test('command outcome classification covers first attempts, retries and the request lock',()=>{
  for(const [error,retry,expected] of [[httpError(400,'x'),false,'refused'],[httpError(404,'x'),false,'refused'],[httpError(409,'x'),false,'refused'],[lockError(),false,'refused'],
    [httpError(500,'x'),false,'unknown'],[httpError(undefined,'x'),false,'unknown'],[httpError(400,'x'),true,'refused'],[httpError(404,'x'),true,'retry_refused'],
    [httpError(409,'x'),true,'retry_refused'],[lockError(),true,'unknown'],[httpError(502,'x'),true,'unknown'],[httpError(undefined,'x'),true,'unknown']])
    assert.equal(UI.commandOutcome(error,retry),expected,`${error.status ?? 'lost'}${error.code?'+'+error.code:''} ${retry?'retry':'first'}`);
});

test('a later unknown outcome outranks an earlier refusal in the headline (R1, controls)',async()=>{
  const host=controlHost(),inflight=deferred(),state={snapshot:controlled(),writes:[],replies:[inflight.promise,httpError(undefined,'socket closed')]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();host.type(90);await debounce();
    assert.equal(state.writes.length,1);
    inflight.reject(httpError(409,'Control revision changed'));await settle();await settle();await settle();
    assert.equal(state.writes.length,2,'the read requested after the refusal drains the newer edit');
    assert.deepEqual(state.writes[1].body.changes,{'routines.ad_gems.interval_sec':90});
    assert.equal(host.status.textContent,'Command acknowledgement unavailable; outcome unknown: socket closed');
    assert.equal(host.control.textContent,'Acknowledgement unavailable · outcome unknown');
    assert.equal(host.retry.hidden,false);
  } finally {workspace.destroy();}
});

test('Run now after a refusal supersedes it, so a lost action reply reads as unknown (R1, action)',async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(400,'Unsupported controls: routines.ad_gems.interval_sec'),httpError(undefined,'socket closed')]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();await settle();
    assert.match(host.status.textContent,/^Refused: Unsupported controls/);assert.equal(host.button.disabled,false);
    click(host,'[data-action]',host.button);await settle();await settle();
    assert.equal(state.writes[1].url,'/api/operations/op-1/actions');
    assert.equal(host.status.textContent,'Command acknowledgement unavailable; outcome unknown: socket closed');
    assert.equal(host.feedback.textContent,'Acknowledgement unavailable · outcome unknown');
    assert.equal(host.control.textContent,'','the earlier refusal no longer describes the panel');
    assert.equal(host.retry.hidden,false);
  } finally {workspace.destroy();}
});

test('a retry refused by the request lock stays unknown and keeps the identical Retry (R2)',async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(undefined,'socket closed'),lockError(),accepted()]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    click(host,'[data-retry-command]',host.retry);await settle();await settle();
    assert.deepEqual(state.writes[1],state.writes[0]);
    assert.equal(host.status.textContent,'Command acknowledgement unavailable; outcome unknown: Another action is in progress; wait for its result');
    assert.equal(host.control.textContent,'Acknowledgement unavailable · outcome unknown');
    assert.equal(host.retry.hidden,false);assert.equal(host.button.disabled,true);
    for(let i=0;i<2;i++)await workspace.poll();
    assert.equal(state.writes.length,2,'nothing is retried automatically');
    click(host,'[data-retry-command]',host.retry);await settle();
    assert.equal(state.writes.length,3);assert.deepEqual(state.writes[2],state.writes[0]);
    assert.equal(host.retry.hidden,true);assert.equal(host.status.textContent,'Pending');
  } finally {workspace.destroy();}
});

for(const kind of ['controls','action'])
test(`a first ${kind} attempt refused by the request lock is a refusal and is never resubmitted (R2)`,async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[lockError()]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    if(kind==='action'){click(host,'[data-action]',host.button);await settle();await settle();}
    else {host.type(60);await debounce();await settle();await settle();}
    assert.equal(host.status.textContent,'Refused: Another action is in progress; wait for its result. Nothing was recorded.');
    assert.equal(host.retry.hidden,true);
    if(kind==='controls')assert.equal(String(host.input.value),'720','the refused value is not restored as a draft');
    for(let i=0;i<3;i++)await workspace.poll();
    assert.equal(state.writes.length,1);
  } finally {workspace.destroy();}
});

/* Exact request identity (independent r3 R3-1). The server lists every
   idempotency key recorded for a command (request_keys, action aliases
   included); only a row carrying this request's own key, battle, generation and
   operation is evidence about it. */
const keyed=(body,extra={})=>({id:'first',kind:'controls',payload:{routines:{ad_gems:{interval_sec:60}}},revision:body.expected_revision+1,state:'applied',
  battle_id:body.battle_id,operation_id:'op-1',generation:body.generation,request_keys:[body.idempotency_key],requested_at:Date.now()/1000,updated_at:Date.now()/1000,...extra});
const appliedAt60=(rows)=>controlled({control_revision:1,applied_revision:1,effective:{routines:{ad_gems:{enabled:true,interval_sec:60,window_sec:60}}},
  overrides:{routines:{ad_gems:{enabled:true,interval_sec:60}}},commands:rows});
const RETRY_UNKNOWN='Retry refused: Battle has ended. Whether the first attempt was recorded is unknown.';

test('a refused retry is resolved by the first attempt\'s own recorded row (R3-1, positive)',async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[body=>{state.snapshot=appliedAt60([keyed(body)]);throw httpError(undefined,'socket closed');},httpError(409,'Battle has ended')]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    click(host,'[data-retry-command]',host.retry);await settle();await settle();await settle();
    assert.deepEqual(state.writes[1],state.writes[0],'the retry body stayed frozen');
    assert.equal(host.status.textContent,'Driver acknowledged');
    assert.match(host.control.textContent,/^First attempt recorded · Applied · \d+s ago$/);
    assert.equal(String(host.input.value),'60');assert.equal(host.retry.hidden,true);
  } finally {workspace.destroy();}
});

for(const [name,row] of [
  ['an older server row without request keys',body=>{const {request_keys,...rest}=keyed(body);return rest;}],
  ['another client\'s identical edit at the same revision',body=>keyed(body,{id:'other-tab',request_keys:['other-client-key']})],
  ['an old row for the same field',body=>keyed(body,{id:'old',revision:body.expected_revision,request_keys:['earlier-key'],requested_at:Date.now()/1000-600,updated_at:Date.now()/1000-600})],
  ['this key on another battle generation',body=>keyed(body,{generation:'older-driver'})],
  ['this key under another operation',body=>keyed(body,{operation_id:'op-2'})]])
test(`a refused retry stays unknown given ${name} (R3-1, negative)`,async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[body=>{state.snapshot=appliedAt60([row(body)]);throw httpError(undefined,'socket closed');},httpError(409,'Battle has ended')]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    click(host,'[data-retry-command]',host.retry);await settle();await settle();await settle();
    await workspace.poll();
    assert.equal(host.status.textContent,RETRY_UNKNOWN);
    assert.equal(host.control.textContent,'Retry refused · first attempt unconfirmed','no other row is shown as this request\'s outcome');
    assert.equal(state.writes.length,2);
  } finally {workspace.destroy();}
});

test('a read listing the request\'s own key settles an unknown control outcome without a retry',async()=>{
  const host=controlHost();let lost;
  const state={snapshot:controlled(),writes:[],replies:[body=>{lost=body;throw httpError(500,'reply lost after commit');}]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    assert.equal(host.retry.hidden,false);
    state.snapshot=controlled({control_revision:1,applied_revision:0,commands:[keyed(lost,{state:'requested'})]});
    await workspace.poll();
    assert.equal(host.retry.hidden,true);assert.equal(host.status.textContent,'Pending');
    assert.match(host.control.textContent,/^Accepted/);
    state.snapshot=appliedAt60([keyed(lost)]);await workspace.poll();
    assert.equal(host.status.textContent,'Driver acknowledged');assert.equal(state.writes.length,1,'nothing was resent');
  } finally {workspace.destroy();}
});

test('another client\'s identical edit never settles an unknown control outcome',async()=>{
  const host=controlHost();let lost;
  const state={snapshot:controlled(),writes:[],replies:[body=>{lost=body;throw httpError(undefined,'socket closed');}]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    state.snapshot=appliedAt60([keyed(lost,{id:'other-tab',request_keys:['other-client-key']})]);
    for(let i=0;i<2;i++)await workspace.poll();
    assert.equal(host.status.textContent,'Command acknowledgement unavailable; outcome unknown: socket closed');
    assert.equal(host.control.textContent,'Acknowledgement unavailable · outcome unknown');
    assert.equal(host.retry.hidden,false);assert.equal(state.writes.length,1);
  } finally {workspace.destroy();}
});

const actionRow=(extra={})=>({id:'pending-action',kind:'action',payload:{action:'ad_gems'},revision:0,state:'started',battle_id:'battle-1',operation_id:'op-1',generation:'driver',
  request_keys:['earlier-click'],requested_at:Date.now()/1000-3,updated_at:Date.now()/1000-1,...extra});

test('an action request that joined a pending action is settled through its alias key',async()=>{
  const host=controlHost();let lost;
  const state={snapshot:controlled(),writes:[],replies:[body=>{lost=body;throw httpError(undefined,'socket closed');}]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    click(host,'[data-action]',host.button);await settle();
    assert.equal(host.retry.hidden,false);
    state.snapshot=controlled({commands:[actionRow({request_keys:['earlier-click',lost.idempotency_key]})]});
    await workspace.poll();
    assert.equal(host.retry.hidden,true);assert.equal(host.button.disabled,true);
    assert.match(host.feedback.textContent,/^Executing/);
    state.snapshot=controlled({commands:[actionRow({state:'completed',evidence:{confirmed:true,reason:'offer_disappeared'},request_keys:['earlier-click',lost.idempotency_key]})]});
    await workspace.poll();
    assert.equal(host.button.disabled,false);assert.match(host.feedback.textContent,/^Finished.*Claim disappeared/);
    assert.equal(state.writes.length,1);
  } finally {workspace.destroy();}
});

test('a refused action retry is resolved only by a row carrying its key',async()=>{
  for(const own of [true,false]){
    const host=controlHost();let lost;
    const state={snapshot:controlled(),writes:[],replies:[body=>{lost=body;throw httpError(undefined,'socket closed');},httpError(409,'Battle has ended')]};
    const workspace=UI.create({request:transport(state)});
    try {
      workspace.attach({live:host});await settle();
      click(host,'[data-action]',host.button);await settle();
      click(host,'[data-retry-command]',host.retry);await settle();await settle();
      state.snapshot=controlled({commands:[actionRow({state:'completed',evidence:{confirmed:true},request_keys:own?[lost.idempotency_key]:['earlier-click'],
        requested_at:Date.now()/1000-900,updated_at:Date.now()/1000-890})]});
      await workspace.poll();
      if(own){assert.equal(host.status.textContent,'Driver acknowledged');assert.match(host.feedback.textContent,/^First attempt recorded · Finished/);}
      else {assert.equal(host.status.textContent,RETRY_UNKNOWN);assert.equal(host.feedback.textContent,'Retry refused · first attempt unconfirmed');}
    } finally {workspace.destroy();}
  }
});

test('the server\'s command_outcome_unknown answer is an unknown outcome',()=>{
  assert.equal(UI.commandOutcome(Object.assign(httpError(500,'Read-back failed'),{code:'command_outcome_unknown'}),false),'unknown');
});

test('a focused refused field follows the read requested after the refusal (R4)',async()=>{
  const host=controlHost(),changed={routines:{ad_gems:{enabled:true,interval_sec:300,window_sec:60}}};
  const state={snapshot:controlled(),writes:[],replies:[()=>{state.snapshot=controlled({control_revision:1,applied_revision:1,effective:changed,overrides:{routines:{ad_gems:{enabled:true,interval_sec:300}}}});throw httpError(409,'Control revision changed');}]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    state.readGate=deferred();
    host.type(60);await debounce();await settle();await settle();
    assert.equal(String(host.input.value),'720','until the new read lands the field shows the last observed value');
    const gate=state.readGate;state.readGate=null;gate.resolve();await settle();await settle();
    assert.equal(host.ownerDocument.activeElement,host.input);
    assert.equal(String(host.input.value),'300');
  } finally {workspace.destroy();}
});

test('a draft held after a refusal drains even while an unrelated driver rejection is shown (R5)',async()=>{
  const host=controlHost(),inflight=deferred();
  const state={snapshot:controlled(),writes:[],replies:[{command:{id:'act',kind:'action',payload:{action:'ad_gems'},state:'requested'}},inflight.promise,accepted()]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    click(host,'[data-action]',host.button);await settle();await settle();
    host.type(60);await debounce();host.type(90);await debounce();
    assert.equal(state.writes.length,2);
    state.snapshot=controlled({commands:[{id:'act',kind:'action',payload:{action:'ad_gems'},state:'rejected',reason:'screen_not_owned'}]});
    await workspace.poll();await settle();
    assert.equal(host.status.textContent,'screen_not_owned');
    inflight.reject(httpError(409,'Control revision changed'));await settle();await settle();await settle();
    assert.equal(state.writes.length,3);
    assert.deepEqual(state.writes[2].body.changes,{'routines.ad_gems.interval_sec':90});
  } finally {workspace.destroy();}
});

test('a refusal without a newer edit holds Run now, with its reason, until a read requested afterwards (R7)',async()=>{
  const host=withReason(controlHost()),inflight=deferred(),state={snapshot:controlled(),writes:[],replies:[inflight.promise]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();
    state.readGate=deferred();const earlier=workspace.poll();await settle();
    inflight.reject(httpError(409,'Control revision changed'));await settle();await settle();
    assert.equal(host.button.disabled,true);
    assert.equal(host.reason.textContent,'Waiting for a fresh battle read');assert.equal(host.reason.hidden,false);
    const gate=state.readGate;state.readGate=null;gate.resolve();await earlier;await settle();
    assert.equal(host.button.disabled,true,'a read started before the refusal cannot release it');
    await workspace.poll();await settle();
    assert.equal(host.button.disabled,false);assert.equal(host.reason.hidden,true);
    assert.equal(state.writes.length,1);
  } finally {workspace.destroy();}
});

test('a remount before the debounce fires still sends the draft and renders into the current host (R8)',async()=>{
  const first=controlHost(),second=controlHost(),state={snapshot:controlled(),writes:[],replies:[accepted()]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:first,context:'same'});await settle();
    first.type(60);
    workspace.attach({live:second,context:'same'});await settle();
    await debounce();await settle();
    assert.equal(state.writes.length,1);
    assert.deepEqual(state.writes[0].body.changes,{'routines.ad_gems.interval_sec':60});
    assert.match(second.control.textContent,/^Accepted/);assert.equal(second.status.textContent,'Pending');
  } finally {workspace.destroy();}
});

test('a remount during a request applies its refusal in the current host (R8)',async()=>{
  const first=controlHost(),second=controlHost(),inflight=deferred(),state={snapshot:controlled(),writes:[],replies:[inflight.promise]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:first,context:'same'});await settle();
    first.type(60);await debounce();
    workspace.attach({live:second,context:'same'});await settle();
    inflight.reject(httpError(409,'Control revision changed'));await settle();await settle();await settle();
    assert.equal(second.status.textContent,'Refused: Control revision changed. Nothing was recorded.');
    assert.equal(String(second.input.value),'720');
    assert.equal(second.button.disabled,false,'the read requested after the refusal released Run now');
    assert.equal(state.writes.length,1);
  } finally {workspace.destroy();}
});

test('a context replacement drops the replaced model\'s debounce timer (R8)',async()=>{
  const first=controlHost(),second=controlHost(),state={snapshot:controlled(),writes:[],replies:[accepted()]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:first,context:'first'});await settle();
    first.type(60);
    workspace.attach({live:second,context:'second'});await settle();
    await debounce();await settle();
    assert.equal(state.writes.length,0);
    second.type(75);await debounce();
    assert.equal(state.writes.length,1);assert.deepEqual(state.writes[0].body.changes,{'routines.ad_gems.interval_sec':75});
  } finally {workspace.destroy();}
});

test('a context replacement ignores late replies for the replaced model (R8)',async()=>{
  const first=controlHost(),second=controlHost(),inflight=deferred(),state={snapshot:controlled(),writes:[],replies:[inflight.promise]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:first,context:'first'});await settle();
    first.type(60);await debounce();
    workspace.attach({live:second,context:'second'});await settle();
    inflight.reject(httpError(undefined,'socket closed'));await settle();await settle();
    assert.equal(second.retry.hidden,true);assert.equal(second.status.textContent,'Driver acknowledged');
    assert.equal(second.control.textContent,'');assert.equal(second.button.disabled,false);
  } finally {workspace.destroy();}
});

test('refusal feedback is not shown beside a newer draft of the same control (O2)',async()=>{
  const host=controlHost(),inflight=deferred(),state={snapshot:controlled(),writes:[],replies:[inflight.promise]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();host.type(90);
    state.readGate=deferred();
    inflight.reject(httpError(409,'Control revision changed'));await settle();await settle();
    assert.equal(host.control.textContent,'');
    assert.equal(host.status.textContent,'Refused: Control revision changed. Nothing was recorded.');
    assert.equal(host.input.value,'90');
  } finally {workspace.destroy();}
});

test('invalid input guidance is added to a refusal rather than hidden by it (O3)',async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(409,'Control revision changed')]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();await settle();
    host.input.value='';host.input.valueAsNumber=NaN;host.oninput({target:host.input});
    assert.equal(host.status.textContent,'Refused: Control revision changed. Nothing was recorded. · Enter a valid value');
    await workspace.poll();assert.equal(state.writes.length,1);
  } finally {workspace.destroy();}
});

test('the default hint keeps its override marker for live overrides after mount (F1)',async()=>{
  const host=withHint(controlHost()),applied={routines:{ad_gems:{enabled:true,interval_sec:960,window_sec:60}}};
  const state={snapshot:controlled(),writes:[],replies:[accepted()]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    assert.equal(host.hint.textContent,'Default 720');
    host.type(960);assert.equal(host.hint.textContent,'Pending');
    await debounce();await settle();
    state.snapshot=controlled({control_revision:1,applied_revision:1,effective:applied,overrides:{routines:{ad_gems:{enabled:true,interval_sec:960}}},
      commands:[{id:'accepted',kind:'controls',payload:{routines:{ad_gems:{interval_sec:960}}},revision:1,state:'applied'}]});
    await workspace.poll();
    assert.equal(host.hint.textContent,'Default 720 · override');
    state.snapshot=controlled({control_revision:2,applied_revision:2,effective:controlBase,overrides:{routines:{ad_gems:{enabled:true}}}});
    await workspace.poll();
    assert.equal(host.hint.textContent,'Default 720','a removed override drops the marker');
  } finally {workspace.destroy();}
});

test('keyboard focus moves to the status line when a focused Retry hides (O4)',async()=>{
  const host=controlHost(),state={snapshot:controlled(),writes:[],replies:[httpError(undefined,'socket closed'),accepted()]};
  host.status.focus=()=>{host.ownerDocument.activeElement=host.status;};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();await settle();
    host.ownerDocument.activeElement=host.retry;
    click(host,'[data-retry-command]',host.retry);await settle();
    assert.equal(host.retry.hidden,true);
    assert.equal(host.ownerDocument.activeElement,host.status);assert.equal(host.status.tabIndex,-1);
  } finally {workspace.destroy();}
});

/* Freshness (independent r3 FR-1/FR-2): report freshness (15 s on the report
   timestamp) gates clocks, inputs and Run now; a collector's stale_after_sec
   applies only to its last_observed_at, as in interactions/ad_gems.py. */
test('report freshness and observation freshness are separate rules with inclusive limits',()=>{
  assert.equal(UI.fresh({server_time:100},115),true);assert.equal(UI.fresh({server_time:100},115.01),false);
  assert.equal(UI.fresh({observed_at:110,server_time:90},120),true,'observed_at is the report time when present');
  assert.equal(UI.fresh({},100),false);assert.equal(UI.fresh(null,100),false);
  const ad={state:'scheduled',next_due_at:150,server_time:100,stale_after_sec:8,last_observed_at:100,visibility:'absent'};
  assert.equal(UI.observationFresh(ad,108),true);assert.equal(UI.observationFresh(ad,108.01),false);
  assert.equal(UI.observationFresh({...ad,stale_after_sec:undefined},115),true,'without a published limit the report limit applies');
  assert.equal(UI.countdown(ad,true,112),'38s','an observation older than stale_after_sec does not stale the countdown');
  assert.match(UI.observationValues(ad,112).freshness,/stale or unavailable/);
  assert.equal(UI.observationValues(ad,112).visibility,'Unknown (stale observation)');
  assert.equal(UI.countdown(ad,true,115.5),'Stale observation');
});

function freshnessHost(){
  const host=controlHost(),reason={dataset:{actionReason:'ad_gems'},textContent:'',hidden:true},clock={dataset:{countdown:'ad_gems'},textContent:''},notice={textContent:'',hidden:true};
  const one=host.querySelector.bind(host),all=host.querySelectorAll.bind(host);
  host.querySelector=selector=>selector==='[data-dashboard-notice]'?notice:one(selector);
  host.querySelectorAll=selector=>selector==='[data-action-reason]'?[reason]:selector==='[data-countdown]'?[clock]:all(selector);
  return Object.assign(host,{reason,clock,notice});
}
const reportAged=(age,extra={})=>{const at=Date.now()/1000-age;return {server_time:at,routines:{ad_gems:{state:'scheduled',next_due_at:at+100,server_time:at,stale_after_sec:8,last_observed_at:at,visibility:'absent',...extra}}};};

test('clock, Run now and input agree while an observation is 8-15 s old',async()=>{
  for(const [age,stale] of [[12,false],[16,true]]){
    const host=freshnessHost(),state={snapshot:controlled({runtime:reportAged(age)}),writes:[],replies:[]};
    const workspace=UI.create({request:transport(state)});
    try {
      workspace.attach({live:host,liveVariant:'dashboard'});await settle();
      if(stale){
        assert.equal(host.clock.textContent,'Stale observation');assert.equal(host.button.disabled,true);
        assert.equal(host.reason.textContent,'Battle observation is stale');assert.equal(host.input.disabled,true);assert.equal(host.notice.hidden,false);
      } else {
        assert.match(host.clock.textContent,/^\d+s$/);assert.equal(host.button.disabled,false);
        assert.equal(host.reason.hidden,true);assert.equal(host.input.disabled,false);assert.equal(host.notice.hidden,true);
      }
    } finally {workspace.destroy();}
  }
});

test('a stale routine report under a fresh battle report gates that routine only',async()=>{
  const host=freshnessHost(),at=Date.now()/1000;
  const runtime={server_time:at,routines:{ad_gems:{state:'scheduled',next_due_at:at+100,server_time:at-40},floating_gems:{state:'scheduled',next_due_at:at+50,server_time:at}}};
  const snapshot=controlled({runtime,capabilities:{controls:['routines.ad_gems.interval_sec','routines.floating_gems.interval_sec'],actions:['ad_gems','floating_gems']}});
  const workspace=UI.create({request:transport({snapshot,writes:[],replies:[]})});
  try {
    workspace.attach({live:host});await settle();
    assert.equal(host.clock.textContent,'Stale observation');assert.equal(host.button.disabled,true);
    assert.equal(host.reason.textContent,'Battle observation is stale');assert.equal(host.input.disabled,true);
    const model=UI.makeModel('live',snapshot);
    assert.deepEqual(UI.actionState(model,'floating_gems',at),{enabled:true,reason:''});
    assert.equal(UI.actionState(model,'ad_gems',at).reason,'Battle observation is stale');
  } finally {workspace.destroy();}
});

test('freshness follows the server clock, not a skewed browser clock',async()=>{
  for(const withServerTime of [true,false]){
    const host=freshnessHost(),serverNow=Date.now()/1000-3600;
    const runtime={server_time:serverNow-2,routines:{ad_gems:{state:'scheduled',next_due_at:serverNow+30,server_time:serverNow-2}}};
    const workspace=UI.create({request:async()=>({battle:controlled({runtime}),...(withServerTime?{server_time:serverNow}:{})})});
    try {
      workspace.attach({live:host});await settle();
      if(withServerTime){assert.match(host.clock.textContent,/^(29|30)s$/);assert.equal(host.button.disabled,false);}
      else {assert.equal(host.clock.textContent,'Stale observation');assert.equal(host.button.disabled,true);}
    } finally {workspace.destroy();}
  }
});

test('before the driver\'s first report, Run now and changes wait with a stated reason',async()=>{
  for(const runtime of [undefined,{},{setup:{state:'verified'}},{routines:{ad_gems:{state:'scheduled',next_due_at:Date.now()/1000+60}}}]){
    const model=UI.makeModel('live',controlled({runtime}));
    assert.deepEqual(UI.actionState(model,'ad_gems'),{enabled:false,reason:'Waiting for the driver\'s first report'});
  }
  const host=freshnessHost(),state={snapshot:controlled({runtime:{}}),writes:[],replies:[{command:{id:'c',kind:'controls',revision:1,state:'requested'},control_revision:1}]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host,liveVariant:'dashboard'});await settle();
    assert.equal(host.clock.textContent,'Waiting for first report');assert.equal(host.button.disabled,true);
    assert.equal(host.reason.textContent,'Waiting for the driver\'s first report');assert.equal(host.input.disabled,true);
    assert.match(host.notice.textContent,/Waiting for the driver's first report/);assert.equal(host.notice.hidden,false);
    host.type(60);await debounce();
    assert.equal(state.writes.length,0,'a change is held, not sent');
    assert.equal(host.status.textContent,'Change held until the driver reports');
    state.snapshot=controlled({runtime:reportAged(0)});await workspace.poll();await settle();
    assert.equal(state.writes.length,1,'the held change drains once the driver reports');
    assert.deepEqual(state.writes[0].body.changes,{'routines.ad_gems.interval_sec':60});
    assert.equal(host.input.disabled,false);assert.equal(host.button.disabled,true,'Run now waits for the change');
  } finally {workspace.destroy();}
});

test('a stale driver report stops the clock, input and Run now with a stated reason',async()=>{
  const host=withReason(withClock(controlHost())),at=Date.now()/1000;
  const runtime=age=>({server_time:at-age,routines:{ad_gems:{state:'scheduled',next_due_at:at+100,server_time:at-age}}});
  const state={snapshot:controlled({runtime:runtime(60)}),writes:[],replies:[]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    assert.equal(host.clock.textContent,'Stale observation');
    assert.equal(host.input.disabled,true);assert.equal(host.button.disabled,true);
    assert.equal(host.reason.textContent,'Battle observation is stale');
    state.snapshot=controlled({runtime:runtime(0)});await workspace.poll();
    assert.match(host.clock.textContent,/^\d+s$/);
    assert.equal(host.input.disabled,false);assert.equal(host.button.disabled,false);assert.equal(host.reason.hidden,true);
  } finally {workspace.destroy();}
});

test('a drained newer edit supersedes the earlier refusal while it is in flight (R1, O2)',async()=>{
  const host=controlHost(),first=deferred(),second=deferred(),state={snapshot:controlled(),writes:[],replies:[first.promise,second.promise]};
  const workspace=UI.create({request:transport(state)});
  try {
    workspace.attach({live:host});await settle();
    host.type(60);await debounce();host.type(90);await debounce();
    first.reject(httpError(409,'Control revision changed'));await settle();await settle();await settle();
    assert.equal(state.writes.length,2);
    assert.equal(host.status.textContent,'Pending','the earlier refusal no longer heads the panel');
    assert.equal(host.control.textContent,'');
    second.resolve(accepted());await settle();
    assert.match(host.control.textContent,/^Accepted/);
  } finally {workspace.destroy();}
});
