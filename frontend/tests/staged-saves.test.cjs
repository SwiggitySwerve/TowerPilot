const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const LearningStore=require('../webui/learning-store.js');
const {section}=require('./helpers.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function page(profile,post){
  const config={active_instance:'emulator-a',active_profile:'profile-a',instances:{'emulator-a':{account:'account-a',serial:'device-a'}}};
  const ctx=vm.createContext({LearningStore,S:{config,profiles:{active:'profile-a'},profile:clone(profile),serverProfile:clone(profile),profileRevision:'rev-1',pending:new Map()},
    post,api:async()=>{throw Error('Unexpected read');},toast(){},esc:String,setTimeout,clearTimeout,
    document:{querySelector:()=>null,querySelectorAll:()=>[]},$:()=>null});
  vm.runInContext(section('async function observeSaveAcknowledgement(', '/* ------------------------------------------------------------- data loads */'),ctx);
  return ctx;
}

test('staged saves are serial, revision-bound, and retain the exact partial failure result',async()=>{
  const calls=[];
  const ctx=page({a:1,b:1},async(path,body)=>{
    calls.push(clone(body));
    if(calls.length===2)throw Object.assign(Error('Conflicting writer'),{status:409});
    return {profile:{a:2,b:1},revision:'rev-2'};
  });
  ctx.queuePatch(['a'],2);ctx.queuePatch(['b'],2);
  assert.equal(await ctx.saveAll(),false);
  assert.deepEqual(calls.map(call=>call.expected_revision),['rev-1','rev-2']);
  assert.deepEqual(Array.from(ctx.S.saveBatch.items,item=>item.state),['saved','conflict']);
  assert.equal(ctx.S.pending.size,1);assert.equal(ctx.S.pending.get('["b"]').blocked,true);
  assert.equal(ctx.S.serverProfile.a,2);assert.equal(ctx.S.profile.b,2);
  await ctx.saveAll();assert.equal(calls.length,2,'a conflict must not silently retry the mutation');
});

test('a confirmed array deletion is not applied to the displayed server profile twice',async()=>{
  const ctx=page({rules:['first','second','third']},async()=>({profile:{rules:['second','third']},revision:'rev-2'}));
  ctx.queuePatch(['rules',0],undefined,'delete');
  assert.equal(await ctx.saveAll(),true);
  assert.deepEqual(clone(ctx.S.profile.rules),['second','third']);assert.equal(ctx.S.pending.size,0);
});

test('new edits made during an accepted save remain staged over confirmed server data',async()=>{
  const gate=deferred();let calls=0;
  const ctx=page({a:1},()=>{calls++;return gate.promise;});
  ctx.queuePatch(['a'],2);const job=ctx.saveAll();ctx.queuePatch(['a'],3);
  const duplicate=ctx.saveAll();assert.equal(calls,1);
  gate.resolve({profile:{a:2},revision:'rev-2'});await Promise.all([job,duplicate]);
  assert.equal(ctx.S.serverProfile.a,2);assert.equal(ctx.S.profile.a,3);assert.equal(ctx.S.pending.size,1);
});

test('a newer draft cannot bypass an unknown result from its in-flight predecessor',async()=>{
  const gate=deferred();let calls=0;
  const ctx=page({a:1},()=>{calls++;return gate.promise;});
  ctx.queuePatch(['a'],2);const job=ctx.saveAll();ctx.queuePatch(['a'],3);
  gate.reject(Error('Lost acknowledgement'));await job;
  const original=ctx.S.saveBatch;
  assert.equal(ctx.S.pending.get('["a"]').blocked,true);
  await ctx.saveAll();assert.equal(ctx.S.saveBatch,original);assert.equal(calls,1);
  ctx.api=async()=>({profile:{a:2},revision:'rev-2'});await ctx.reconcileSavedChanges();
  assert.equal(ctx.S.pending.get('["a"]').blocked,false);assert.equal(ctx.S.profile.a,3);
});

test('unknown save requires readback, clears only the confirmed intent, and preserves newer drafts',async()=>{
  let calls=0;
  const ctx=page({a:1},async()=>{calls++;throw Error('Connection lost');});
  ctx.queuePatch(['a'],2);await ctx.saveAll();
  assert.equal(ctx.S.saveBatch.state,'unknown');assert.equal(calls,1);
  ctx.queuePatch(['a'],3);
  ctx.api=async()=>({profile:{a:2},revision:'rev-2'});
  await ctx.reconcileSavedChanges();
  assert.equal(ctx.S.saveBatch.items[0].state,'saved');assert.equal(ctx.S.pending.size,1);
  assert.equal(ctx.S.pending.get('["a"]').blocked,false);assert.equal(ctx.S.profile.a,3);
  assert.equal(ctx.S.serverProfile.a,2);assert.equal(calls,1,'readback must not mutate');
});

test('different saved readback retains the conflict and draft without claiming persistence',async()=>{
  const ctx=page({a:1},async()=>{throw Object.assign(Error('Conflict'),{status:409});});
  ctx.queuePatch(['a'],2);await ctx.saveAll();ctx.api=async()=>({profile:{a:7},revision:'rev-7'});
  await ctx.reconcileSavedChanges();
  assert.equal(ctx.S.pending.get('["a"]').blocked,true);assert.equal(ctx.S.profile.a,2);
  assert.match(ctx.S.savedReview.message,/differs/);assert.equal(ctx.S.saveBatch.items[0].state,'conflict');
  ctx.discardAll();assert.equal(ctx.S.profile.a,7);assert.equal(ctx.S.profileRevision,'rev-7');
});

test('dismissal cannot remove an unresolved save intent or its readback recovery',async()=>{
  const ctx=page({a:1},async()=>{throw Error('Lost acknowledgement');});
  ctx.queuePatch(['a'],2);await ctx.saveAll();ctx.queuePatch(['a'],3);
  const batch=ctx.S.saveBatch;
  ctx.dismissSaveFeedback();
  assert.equal(ctx.S.saveBatch,batch);
  assert.match(ctx.saveFeedbackHTML(),/Read saved result/);
  ctx.api=async()=>({profile:{a:2},revision:'rev-2'});
  await ctx.reconcileSavedChanges();
  assert.equal(ctx.S.pending.get('["a"]').blocked,false);
  assert.equal(ctx.S.profile.a,3);
  ctx.dismissSaveFeedback();
  assert.equal(ctx.S.saveBatch,null);
});

test('explicitly discarded edits allow the unresolved result to be dismissed',async()=>{
  const ctx=page({a:1},async()=>{throw Error('Lost acknowledgement');});
  ctx.queuePatch(['a'],2);await ctx.saveAll();
  assert.equal(ctx.hasUnresolvedSave(),true);
  ctx.discardAll();
  assert.equal(ctx.hasUnresolvedSave(),false);
  ctx.dismissSaveFeedback();
  assert.equal(ctx.S.saveBatch,null);
});

test('late saved results cannot replace a newly selected account or profile',async()=>{
  const gate=deferred();const ctx=page({a:1},()=>gate.promise);
  ctx.queuePatch(['a'],2);const job=ctx.saveAll();
  ctx.S.config.active_profile='profile-b';ctx.S.profiles.active='profile-b';ctx.S.profile={a:8};ctx.S.serverProfile={a:8};
  gate.resolve({profile:{a:2},revision:'rev-2'});await job;
  assert.equal(ctx.S.profile.a,8);assert.equal(ctx.S.serverProfile.a,8);assert.equal(ctx.S.pending.size,1);
  assert.equal(ctx.S.saveBatch.state,'unknown');
});

test('save observation timeout never retries or aborts the original mutation',async()=>{
  const gate=deferred();let fire,calls=0;
  const ctx=page({a:1},()=>{calls++;return gate.promise;});
  ctx.setTimeout=callback=>{fire=callback;return 1;};ctx.clearTimeout=()=>{};
  ctx.queuePatch(['a'],2);const job=ctx.saveAll();await flush();fire();await job;
  assert.equal(ctx.S.saveBatch.state,'unknown');assert.equal(calls,1);
  gate.resolve({profile:{a:2},revision:'rev-2'});await flush();
  assert.equal(ctx.S.serverProfile.a,1,'only explicit readback may establish a timed-out save');
  await ctx.saveAll();assert.equal(calls,1);
});

test('equipment readback ignores object key ordering but preserves the exact saved values',async()=>{
  const ctx=page({},async()=>{throw Error('Unexpected mutation');});
  ctx.L2={name:'equipment-a',context:LearningStore.context(ctx.S.config).id,draft:{modules:['one','two'],cards:'cards-a'},blocked:true};
  ctx.loRender=()=>{};ctx.renderLoadouts=()=>{};
  ctx.api=async()=>({...ctx.S.config,config_revision:'config-2',loadouts:{'equipment-a':{cards:'cards-a',modules:['one','two']}}});
  vm.runInContext(section('async function loReadSaved(){','/* ---------------------------------------------------- behavior library */'),ctx);
  await ctx.loReadSaved();assert.equal(ctx.L2.result.state,'saved');assert.equal(ctx.L2.blocked,false);
  ctx.L2.blocked=true;ctx.L2.draft.modules.reverse();await ctx.loReadSaved();
  assert.equal(ctx.L2.result.state,'conflict');assert.equal(ctx.L2.blocked,true);
});
