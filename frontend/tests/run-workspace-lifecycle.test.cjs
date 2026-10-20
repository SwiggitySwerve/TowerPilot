const test=require('node:test');
const assert=require('node:assert/strict');
const UI=require('../webui/run-workspace.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const base={routines:{ad_gems:{enabled:false,interval_sec:720,window_sec:60}}};
const context={device_key:'device',instance:'main',account:'account',serial:'fake'};
const battle=(extra={})=>({id:'battle-1',operation_id:'op-1',generation:'driver',status:'active',control_revision:0,applied_revision:0,
  context,envelope:{controls:base},effective:base,overrides:{},capabilities:{controls:['routines.ad_gems.enabled'],actions:['ad_gems']},...extra});
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
