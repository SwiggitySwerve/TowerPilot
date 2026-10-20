const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {section}=require('./helpers.cjs');

test('API errors carry the exact request ID sent to the server and one diagnostic',async()=>{
  const requests=[],events=[];
  const ctx=vm.createContext({crypto:{randomUUID:()=> 'test-request-id'},reportDiagnostic:(...args)=>events.push(args),
    fetch:async(path,opts)=>{requests.push({path,opts});return {ok:false,status:409,json:async()=>({error:'state changed'})};}});
  vm.runInContext(section('async function api(', 'const post = '),ctx);
  await assert.rejects(ctx.api('/api/run-controls',{method:'POST',headers:{'Content-Type':'application/json'}}),
    {message:'state changed',status:409,requestId:'test-request-id'});
  assert.equal(requests[0].opts.headers['X-Request-ID'],'test-request-id');
  assert.equal(requests[0].opts.headers['Content-Type'],'application/json');
  assert.equal(events.length,1);
  assert.equal(events[0][1].request_id,'test-request-id');
});
test('network and malformed successful responses are observable failures',async()=>{
  for(const fetch of [async()=>{throw Error('offline');},async()=>({ok:true,status:200,json:async()=>{throw Error('not json');}})]){
    const events=[],ctx=vm.createContext({fetch,reportDiagnostic:(...args)=>events.push(args)});
    vm.runInContext(section('async function api(', 'const post = '),ctx);
    await assert.rejects(ctx.api('/api/status'));
    assert.equal(events.length,1);assert.equal(events[0][0],'api_error');
  }
});
test('diagnostic transport failure does not recursively report itself',async()=>{
  let calls=0;
  const ctx=vm.createContext({location:{hash:'#runtime'},window:{addEventListener(){}},
    fetch:async()=>{calls++;throw Error('offline');}});
  vm.runInContext(section('function reportDiagnostic(', 'function toast('),ctx);
  ctx.reportDiagnostic('api_error',{message:'failure'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
});
