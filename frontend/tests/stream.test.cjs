const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {html,section} = require('./helpers.cjs');

function page(storage = new Map()){
  const writes=[], requests=[], listeners={};
  const image={set src(value){writes.push(['src',value]);}};
  const slot={dataset:{},markup:'',get innerHTML(){return this.markup;},
    set innerHTML(value){this.markup=value;writes.push(['html',value]);}};
  const stats={textContent:''};
  const toggle={checked:true};
  const document={hidden:false,addEventListener:(name,fn)=>listeners[name]=fn};
  const state={tab:'overview',status:{online:true},config:{active_instance:'main',instances:{main:{serial:'emulator-5554'}}}};
  const localStorage={getItem:key=>storage.get(key) ?? null,setItem:(key,value)=>storage.set(key,value)};
  const ctx=vm.createContext({S:state,document,Date,localStorage,WorkspaceStatus:{
    connectionState:status=>({online:status.online}),screenPlaceholderHTML:()=>'<p>offline</p>'},
    $:name=>({'#stream-slot':slot,'#stream-slot img':slot.markup.includes('<img')?image:null,
      '#stream-toggle':toggle,'#stream-stats':stats})[name],
    api:async path=>{requests.push(path);return {target_fps:4,actual_fps:1.25,capture_ms:750,encode_ms:12,errors:0,
      width:1080,height:2560,quality:90};}});
  vm.runInContext(section('function stopStream(){','function renderHomeLive('),ctx);
  return {ctx,state,slot,stats,toggle,writes,requests,listeners,document,
    render:()=>vm.runInContext('renderStream()',ctx)};
}

test('stream target control changes the actual image URL and does not restart on unchanged ticks',async()=>{
  const p=page();p.render();
  assert.match(p.slot.innerHTML,/fps=4&scale=1&q=90&/);
  const session=p.state.streamSession;
  p.writes.length=0;
  p.render();await Promise.resolve();
  assert.equal(p.writes.length,0);
  assert.equal(p.state.streamSession,session);
  vm.runInContext('setStreamFps("0.5")',p.ctx);
  assert.match(p.slot.innerHTML,/fps=0.5&/);
  assert.notEqual(p.state.streamSession,session);
  assert.equal(p.writes[0][0],'src');
  assert.match(p.writes[0][1],/^data:image/);
  assert.match(html,/Stream target FPS[\s\S]*id="stream-fps" onchange="setStreamFps\(this.value\)"/);
});

test('quality presets change delivered resolution and JPEG quality without reconnecting on repeated selections',()=>{
  const p=page();p.render();
  const native=p.state.streamSession;
  vm.runInContext('setStreamQuality("balanced")',p.ctx);
  assert.match(p.slot.innerHTML,/scale=0.65&q=85&/);
  assert.notEqual(p.state.streamSession,native);
  assert.match(p.writes.at(-2)[1],/^data:image/);
  const balanced=p.state.streamSession;
  p.writes.length=0;
  vm.runInContext('setStreamQuality("balanced")',p.ctx);
  p.render();
  assert.equal(p.state.streamSession,balanced);
  assert.equal(p.writes.length,0);
  vm.runInContext('setStreamQuality("low")',p.ctx);
  assert.match(p.slot.innerHTML,/scale=0.4&q=70&/);
  assert.match(html,/id="stream-quality" onchange="setStreamQuality\(this.value\)"/);
});

test('FPS and quality preferences survive a new page and invalid selections leave the stream alone',()=>{
  const storage=new Map(), first=page(storage);first.render();
  vm.runInContext('setStreamFps("1");setStreamQuality("balanced")',first.ctx);
  const second=page(storage);second.render();
  assert.match(second.slot.innerHTML,/fps=1&scale=0.65&q=85&/);
  const session=second.state.streamSession;
  second.writes.length=0;
  vm.runInContext('setStreamFps("nan");setStreamFps("12");setStreamQuality("toString")',second.ctx);
  assert.equal(second.state.streamSession,session);
  assert.equal(second.writes.length,0);
  assert.deepEqual(JSON.parse(storage.get('towerpilot.stream')),{fps:1,quality:'balanced'});
});

test('corrupt, stale or unavailable browser storage keeps valid sharp defaults',()=>{
  for(const value of ['{oops','null','{"fps":12,"quality":"toString"}','{"fps":"2","quality":"old"}']){
    const p=page(new Map([['towerpilot.stream',value]]));p.render();
    assert.match(p.slot.innerHTML,/fps=4&scale=1&q=90&/);
  }
  const p=page();
  p.ctx.localStorage={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}};
  p.render();
  assert.match(p.slot.innerHTML,/fps=4&scale=1&q=90&/);
  vm.runInContext('setStreamFps("2");setStreamQuality("low")',p.ctx);
  assert.match(p.slot.innerHTML,/fps=2&scale=0.4&q=70&/);
});

test('stream switches request ownership when active instance or its configured serial changes',()=>{
  const p=page();p.render();
  const before=p.state.streamSession;
  p.state.config.active_instance='second';
  p.state.config.instances.second={serial:'emulator-5556'};
  p.render();assert.match(p.slot.innerHTML,/instance=second&/);
  assert.notEqual(p.state.streamSession,before);
  const second=p.state.streamSession;
  p.state.config.instances.second.serial='emulator-5558';
  p.render();assert.notEqual(p.state.streamSession,second);
});

test('hidden browser tabs, hidden dashboard pages, offline and disabled previews release their request',()=>{
  for(const condition of ['browser','page','offline','toggle']){
    const p=page();p.render();p.writes.length=0;
    if(condition==='browser')p.document.hidden=true;
    if(condition==='page')p.state.tab='runtime';
    if(condition==='offline')p.state.status.online=false;
    if(condition==='toggle')p.toggle.checked=false;
    if(condition==='browser')p.listeners.visibilitychange();else p.render();
    assert.equal(p.state.streamSession,null,condition);
    assert.doesNotMatch(p.slot.innerHTML,/stream.mjpg/,condition);
    assert.match(p.writes[0][1],/^data:image/,condition);
  }
});

test('preview reports measured delivery and capture latency separately from the target',async()=>{
  const p=page();p.render();p.render();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(p.requests[0],/^\/api\/stream\/status\?stream_id=/);
  assert.equal(p.stats.textContent,'1.25 FPS delivered / target 4 FPS · 1080×2560 · JPEG 90 · capture 750 ms · encode 12 ms · 0 errors');
});

test('old metrics responses cannot overwrite a replaced stream',async()=>{
  const p=page();let settle;
  p.ctx.api=()=>new Promise(resolve=>settle=resolve);
  p.render();p.render();
  vm.runInContext('setStreamFps("1")',p.ctx);
  settle({target_fps:4,actual_fps:2,capture_ms:350,encode_ms:4,errors:0});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.stats.textContent,'Connecting · target 1 FPS');
});
