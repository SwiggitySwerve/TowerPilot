const test=require('node:test');
const assert=require('node:assert/strict');
const UI=require('../webui/diagnostics-view.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const coverage={files_scanned:2,bytes_read:200,matched_in_scan:3,returned:1,truncated:true,
  malformed_records:1,errors:[{file:'events_bad.jsonl',error:'denied'}],max_files:8,max_bytes:1000};
const result=()=>({events:[{t:100,kind:'ad_gems_skip',offer_id:'offer-1',reason:'offer_moved',_log:{file:'events.jsonl',offset:20,failure:true}}],coverage:{...coverage}});

test('deep link filters and API queries preserve exact IDs and validate scan limits',()=>{
  const filters=UI.fromHash('#runtime?operation_id=op%2F1&battle_id=b%26x&command_id=command%3A2&offer_id=o%3A1&trace_id=t1&request_id=req&attempt_id=a&window_id=w&kind=ad_gems_skip&instance=emu&failures=1&limit=1000&since=100');
  const params=new URLSearchParams(UI.query(filters));
  assert.equal(params.get('operation_id'),'op/1');assert.equal(params.get('battle_id'),'b&x');
  assert.equal(params.get('offer_id'),'o:1');assert.equal(params.get('failures'),'1');
  assert.equal(params.get('since'),'100');assert.equal(params.get('limit'),'1000');
  assert.equal(params.get('command_id'),'command:2');
  for(const limit of [0,1001,1.5,'bad'])assert.throws(()=>UI.query({limit}),/Limit/);
  assert.throws(()=>UI.query({since:NaN}),/local start time/);
  assert.equal(new URLSearchParams(UI.query({failures:false})).get('failures'),'0');
});

test('writer health explicitly covers only the current dashboard process and exports raw health',()=>{
  const health={pid:123,process_id:'process-1',write_errors:2,last_error:{exception_type:'OSError',message:'disk full',t:100,event_id:'event-2'}};
  const text=UI.writerHealthText(health);
  assert.match(text,/Current dashboard process \(PID 123\): 2 diagnostic write errors/);
  assert.match(text,/OSError: disk full/);
  assert.match(text,/Other processes’ writers are not covered/);
  assert.match(UI.writerHealthText(null),/health unavailable/);
  assert.deepEqual(JSON.parse(UI.exportPayload({...result(),writer_health:health},{},200)).writer_health,health);
});

test('coverage explicitly reports bounds, truncation, malformed records and read errors',()=>{
  const text=UI.coverageText(coverage);
  for(const fragment of ['2 files','200 bytes','3 matches','1 returned','Truncated: yes','Malformed records: 1','Read errors: 1','8 files / 1000 bytes','only the records scanned'])assert.ok(text.includes(fragment),fragment);
  assert.match(UI.eventsHTML([]),/No matching events in this bounded scan/);
  assert.doesNotMatch(text+UI.eventsHTML([]),/no failures/i);
  assert.match(UI.coverageText({}),/unknown/);
});

test('event summaries expose identities and outcomes while raw JSON is escaped and expansion retained',()=>{
  const event={t:100,kind:'<script>',offer_id:'offer<&',claim_attempt_id:'attempt-1',reason:'<unsafe>',
    traceback:'line1\nline2',_log:{file:'file',offset:12,failure:true}};
  const html=UI.eventsHTML([event],new Set(['file:12']));
  assert.match(html,/data-event-key="file:12" open/);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;unsafe&gt;/);assert.match(html,/offer&lt;&amp;/);
  assert.match(html,/attempt-1/);assert.match(html,/diag-failure/);
  assert.ok(html.indexOf('offer&lt;&amp;')<html.indexOf('</summary>'));
  assert.doesNotMatch(html,/<script>/);
});

function fakeHost(){
  const fields=['instance','operation_id','battle_id','trace_id','request_id','attempt_id','window_id','offer_id','kind','limit','failures'].map(key=>({dataset:{diagFilter:key},value:key==='limit'?'250':'',type:key==='failures'?'checkbox':'text',checked:false}));
  const status={textContent:''},coverage={textContent:''},raw={textContent:''},button={disabled:true},since={value:''};
  const rows={innerHTML:'',querySelectorAll:()=>[],contains:()=>false};
  return {isConnected:true,hidden:false,renderCount:0,fields,status,rows,button,since,
    set innerHTML(value){this.markup=value;this.renderCount++;},get innerHTML(){return this.markup;},
    closest(){return this.hidden?{}:null;},
    querySelector(selector){return {'[data-diag-status]':status,'[data-diag-coverage]':coverage,'[data-diag-coverage-raw]':raw,'[data-diag-events]':rows,'[data-diag-export]':button,'[data-diag-since]':since}[selector] || null;},
    querySelectorAll(selector){return selector==='[data-diag-filter]'?fields:[];}};
}
function harness(request,extra={}){
  const h=fakeHost(),doc={visibilityState:'visible',activeElement:null};let tick,cleared=0;
  const ui=UI.create({request,document:doc,setInterval:fn=>{tick=fn;return 7;},clearInterval:id=>{assert.equal(id,7);cleared++;},...extra});
  return {h,doc,ui,tick:()=>tick(),cleared:()=>cleared};
}

test('auto refresh runs only on mounted visible panel and leaves filter edits intact',async()=>{
  const requests=[],x=harness(async url=>{requests.push(url);return result();});
  x.ui.mount(x.h,{instance:'emu',filters:{offer_id:'offer-1',since:100}});await settle();
  assert.equal(requests.length,1);assert.match(requests[0],/offer_id=offer-1/);
  const input=x.h.fields.find(el=>el.dataset.diagFilter==='offer_id');input.value='draft-offer';
  x.doc.activeElement=input;x.h.oninput({target:{closest:()=>input}});
  const renderCount=x.h.renderCount;x.tick();await settle();
  assert.equal(requests.length,2);assert.match(requests[1],/offer_id=offer-1/);
  assert.equal(input.value,'draft-offer');assert.equal(x.h.renderCount,renderCount);assert.equal(x.doc.activeElement,input);
  assert.match(x.h.status.textContent,/Filters changed/);
  x.h.hidden=true;x.tick();await settle();assert.equal(requests.length,2);
  x.h.hidden=false;x.doc.visibilityState='hidden';x.tick();await settle();assert.equal(requests.length,2);
  x.ui.unmount();assert.equal(x.cleared(),1);assert.equal(x.h.onclick,null);
});

test('out-of-range since deep link mounts safely and reports invalid time without querying',async()=>{
  let requests=0;
  const filters=UI.fromHash('#runtime?since=1e300&trace_id=trace-1');
  assert.doesNotThrow(()=>UI.renderHTML(filters));
  assert.throws(()=>UI.query(filters),/valid local start time/);
  const x=harness(async()=>{requests++;return result();});
  assert.doesNotThrow(()=>x.ui.mount(x.h,{filters}));
  await settle();
  assert.equal(requests,0);
  assert.match(x.h.status.textContent,/Diagnostics unavailable: Choose a valid local start time/);
  assert.equal(x.h.button.disabled,true);
  assert.equal(x.h.rows.innerHTML,'');
  x.ui.destroy();
});

test('applying local time filters refreshes exact query and browser export contains scan coverage',async()=>{
  const requests=[],exports=[],x=harness(async url=>{requests.push(url);return result();},{onExport:text=>exports.push(JSON.parse(text))});
  x.ui.mount(x.h);await settle();
  x.h.fields.find(el=>el.dataset.diagFilter==='battle_id').value='battle-2';
  x.h.fields.find(el=>el.dataset.diagFilter==='limit').value='100';
  x.h.fields.find(el=>el.dataset.diagFilter==='failures').checked=true;
  x.h.since.value='2026-10-19T12:34';
  x.h.onsubmit({preventDefault(){}});await settle();
  const params=new URLSearchParams(requests.at(-1).split('?')[1]);
  assert.equal(params.get('battle_id'),'battle-2');assert.equal(params.get('limit'),'100');assert.equal(params.get('failures'),'1');
  assert.equal(Number(params.get('since')),new Date('2026-10-19T12:34').getTime()/1000);
  x.h.onclick({target:{closest:selector=>selector==='[data-diag-export]'?{}:null}});
  assert.equal(exports.length,1);assert.equal(exports[0].filters.battle_id,'battle-2');
  assert.deepEqual(exports[0].coverage,coverage);assert.equal(exports[0].events[0].offer_id,'offer-1');
  assert.equal(x.h.button.disabled,false);x.ui.destroy();
});

test('invalid filters make no request and failure retains previous result with explicit error',async()=>{
  let calls=0;const x=harness(async()=>{calls++;if(calls>1)throw Error('trace request-42');return result();});
  x.ui.mount(x.h);await settle();const original=x.h.rows.innerHTML;
  x.h.fields.find(el=>el.dataset.diagFilter==='limit').value='1001';
  x.h.onsubmit({preventDefault(){}});await settle();assert.equal(calls,1);assert.match(x.h.status.textContent,/Limit/);
  await x.ui.refresh();assert.equal(calls,2);assert.match(x.h.status.textContent,/Diagnostics unavailable: trace request-42/);
  assert.equal(x.h.rows.innerHTML,original);x.ui.destroy();
});

test('late request cannot replace diagnostics for a different selected instance',async()=>{
  let release;const requests=[],x=harness(url=>{requests.push(url);return requests.length===1?new Promise(resolve=>release=resolve):Promise.resolve({...result(),events:[{kind:'new_instance'}]});});
  x.ui.mount(x.h,{instance:'first'});x.ui.mount(x.h,{instance:'second'});
  release(result());await settle();await settle();
  assert.equal(requests.length,2);assert.equal(new URLSearchParams(requests[1].split('?')[1]).has('instance'),false);
  assert.match(x.h.rows.innerHTML,/new_instance/);assert.doesNotMatch(x.h.rows.innerHTML,/offer_moved/);
  x.ui.destroy();
});

test('default trace query joins dashboard and emulator sources while an explicit instance narrows them',async()=>{
  const records=[
    {kind:'request_finished',trace_id:'trace-both',_log:{file:'_dashboard/events.jsonl',offset:0}},
    {kind:'capture_end',trace_id:'trace-both',instance:'emu',_log:{file:'emu/events.jsonl',offset:0}},
    {kind:'unrelated',trace_id:'other',instance:'emu',_log:{file:'emu/events.jsonl',offset:100}}
  ];
  const requests=[],x=harness(async url=>{
    requests.push(url);const params=new URLSearchParams(url.split('?')[1]);
    const events=records.filter(row=>row.trace_id===params.get('trace_id') && (!params.has('instance') || row.instance===params.get('instance')));
    return {events,coverage:{...coverage,returned:events.length}};
  });
  x.ui.mount(x.h,{instance:'emu',filters:{trace_id:'trace-both'}});await settle();
  assert.equal(new URLSearchParams(requests[0].split('?')[1]).has('instance'),false);
  assert.match(x.h.rows.innerHTML,/request_finished/);assert.match(x.h.rows.innerHTML,/capture_end/);
  assert.doesNotMatch(x.h.rows.innerHTML,/unrelated/);
  assert.match(x.h.innerHTML,/data-diag-filter="instance" value=""/);
  x.ui.mount(x.h,{instance:'emu',filters:{trace_id:'trace-both',instance:'emu'}});await settle();
  assert.equal(new URLSearchParams(requests.at(-1).split('?')[1]).get('instance'),'emu');
  assert.doesNotMatch(x.h.rows.innerHTML,/request_finished/);assert.match(x.h.rows.innerHTML,/capture_end/);
  x.ui.destroy();
});

test('export after a failed filter change identifies the filters used by retained results',async()=>{
  let calls=0;const exports=[],x=harness(async()=>{if(++calls>1)throw Error('unavailable');return result();},{onExport:text=>exports.push(JSON.parse(text))});
  x.ui.mount(x.h,{filters:{offer_id:'original'}});await settle();
  x.h.fields.find(el=>el.dataset.diagFilter==='offer_id').value='replacement';
  x.h.onsubmit({preventDefault(){}});await settle();
  x.h.onclick({target:{closest:selector=>selector==='[data-diag-export]'?{}:null}});
  assert.equal(exports[0].filters.offer_id,'original');x.ui.destroy();
});
