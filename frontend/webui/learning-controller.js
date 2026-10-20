/* Learning/preparation effects. The page supplies I/O, consent and UI adapters. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory(require('./learning-state.js'),require('./learning-store.js'));
  else root.LearningController = factory(root.LearningState,root.LearningStore);
})(globalThis, function(State, Store) {
  'use strict';
  class Superseded extends Error {}
  function create(io) {
    const now = io.now || Date.now;
    const state = State.create(now), store = Store.create(io.storage);
    let generation=0, command=null, completion=null, waiting=null, operationToken=null;
    const scope = () => Store.context(io.config());
    const snapshot = () => Object.freeze({...state.snapshot(),busy:!!command || !!completion});
    const publish = () => { io.changed?.(snapshot()); return snapshot(); };
    function move(phase, changes={}) { state.transition(phase,changes); return publish(); }
    function begin(flow, context, preset) {
      generation++;
      state.begin(flow,context.id,preset);
      operationToken={generation,scope:context,flow,preset};
      return operationToken;
    }
    const current = token => token.generation === generation && token.scope.id === scope().id;
    function ensure(token) {
      const ref=token.flow === 'learning' ? store.learning(token.scope) : store.pending(token.scope);
      if (token.operationId && ref?.operationId && token.operationId !== ref.operationId) throw new Superseded('A newer operation replaced this one.');
      if (!current(token)) throw new Superseded('The selected profile or operation changed.'); }
    async function effect(token, fn) { ensure(token); const result=await fn(); ensure(token); return result; }
    function fail(token, error, prefix='') {
      if (error instanceof Superseded || !current(token)) {
        if (token.generation === generation) move('superseded',{message:'',reason:'context_changed'});
        return;
      }
      move('failed',{message:prefix+error.message,reason:error.message});
    }
    function matches(record, pending) {
      return !!record?.id && !!pending && (record.id === pending.operationId || !pending.operationId && record.idempotency_key === pending.idempotencyKey);
    }
    const applicationSucceeded = record => (record?.result_refs?.apply_status ?? (record?.status === 'succeeded' ? 'succeeded' : null)) === 'succeeded';
    function bind(context, flow, intent, record) {
      if (!store.isCurrent(context,flow,intent)) return null;
      if (record.revision < (intent.revision || 0)) return null;
      return store.replace(context,flow,intent,{...intent,operationId:record.id,revision:record.revision,outcome:record.status,applied:applicationSucceeded(record)});
    }
    const recordOf = observed => observed.operation;
    function validContext(record, context) {
      const target=record?.context;
      return !!target && ['instance','account','serial','profile','rendering'].every(key=>
        JSON.stringify(target[key] ?? null) === JSON.stringify(context[key] ?? null));
    }
    function supersede(token, reason) {

      waiting=null;
      generation++;
      operationToken=null;
      move('superseded',{message:'',reason});
    }
    async function launch(token, before, body) {
      const previous=token.flow === 'learning' ? store.learning(token.scope) : store.pending(token.scope);
      const key=io.key?.() || globalThis.crypto?.randomUUID?.() || String(now())+'-'+Math.random().toString(36).slice(2);
      const intent=store.save(token.scope,token.flow,{preset:token.preset,idempotencyKey:key});
      try {
        const response=await effect(token,()=>io.start({...body,expected_context:Object.fromEntries(['instance','account','serial','rendering','profile'].map(name=>[name,token.scope[name] ?? null])),idempotency_key:key,selected_run:token.preset}));
        const record=response.operation;
        if (!record?.id || !Number.isInteger(record.revision) || !validContext(record,token.scope))
          throw new Error('Preparation acceptance did not include a valid operation target.');
        const bound=store.replace(token.scope,token.flow,intent,{...intent,operationId:record.id,revision:record.revision,outcome:record.status});
        if (!bound) throw new Superseded('A newer request replaced this one.');
        token.operationId=record.id; token.revision=record.revision;
        return bound;
      } catch(error) {
        if (Number.isFinite(error.status) && error.status < 500 && store.isCurrent(token.scope,token.flow,intent)) {
          store.forgetLater([token.flow === 'learning' ? Store.learningKey(token.scope) : token.scope.preparationKey])();
          if (previous) store.save(token.scope,token.flow,previous);
        }
        throw error;
      }
    }
    async function apply(token, record, wording='learning') {
      token.operationId=record?.id; token.revision=record?.revision;
      move('applying',{operationId:record?.id,revision:record?.revision,
        message:'Saving discoveries to this profile…',reason:null});
      try {
        const response=await effect(token,()=>io.apply(record?.id ? {operation_id:record.id,expected_revision:record.revision} : {saved_observations:true}));
        if (record?.id) {
          if (response?.operation?.id !== record.id || !applicationSucceeded(response.operation))
            throw new Error('Application was not confirmed by the operation.');
          token.revision=response.operation.revision;
          const saved=token.flow === 'learning' ? store.learning(token.scope) : store.pending(token.scope);
          if (matches(record,saved)) bind(token.scope,token.flow,saved,response.operation);
        }
      } catch(error) {
        if (current(token) && error.status === 409 && error.message.startsWith('Another action is in progress')) {
          waiting=token;
          move('waiting_to_apply',{message:'Waiting for another dashboard action to finish before saving discoveries…',reason:'dashboard_busy'});
          return false;
        }
        throw error;
      }
      io.applied?.();
      move('checking_readiness',{message:'Discoveries saved. Checking this run…'});
      const result=await effect(token,()=>io.readiness(token.preset));
      token.forgetReviewedLegacy?.(); waiting=null;
      const ready=result.ready === true;
      move(ready ? 'ready' : 'needs_attention',{reason:ready ? null : result.next_action || 'readiness_unconfirmed',
        message:ready ? wording === 'preparation' ? 'Ready. You can start this run from Overview.' : 'Discoveries saved. The selected run is ready; start it from Overview.'
          : (wording === 'preparation' ? 'Discoveries saved. ' : 'Screens saved. ') + (result.message || 'A required control still needs verification.')});
      await effect(token,()=>io.completed?.(wording));
      return true;
    }
    function startCommand(flow, preset, run) {
      if (command || completion) return Promise.resolve(false);
      const token=begin(flow,scope(),preset);
      command=token;
      const job=(async()=>{
        try { return await run(token); }
        catch(error) { fail(token,error); if (!(error instanceof Superseded) && current(token)) io.error?.(error); return false; }
        finally { if (command === token) command=null; publish(); }
      })();
      return job;
    }
    function learn() {
      return startCommand('learning',io.selectedRun?.() || 'bp_coin_default',async token=>{
        move('confirming',{message:'Waiting for permission to learn screens.'});
        if (!await effect(token,()=>io.confirm('learning'))) {
          move('cancelled',{message:'Screen learning has not started.'}); return false;
        }
        move('checking',{message:'Checking for an existing operation…'});
        const before=await effect(token,()=>io.status(token.operationId)); state.observation();
        if (before.running) throw new Error('A scan is already running. Let it finish first.');
        if (before.restore_pending) {
          move('restoration_required',{message:'Restore the saved module setup before learning screens.',reason:'restore_pending'}); return false;
        }
        move('starting',{message:'Learning screens: extract artwork, verify Home, then follow the screen manifest…'});
        io.launching?.();
        await launch(token,before,{bootstrap:true,flows:true,phases:'c,m',fresh:true,overwrite:false,allow_navigation:true});
        move('waiting_for_worker',{message:'Learning requested. Waiting for the worker to report its start.'});
        return true;
      });
    }
    function prepare(preset) {
      if (!preset) { io.error?.(new Error('Choose a run first.')); return Promise.resolve(false); }
      return startCommand('preparation',preset,async token=>{
        move('checking',{message:'Checking the current scan…'});
        const before=await effect(token,()=>io.status(token.operationId)); state.observation();
        if (before.running) throw new Error('A scan is already running. Let it finish first.');
        if (before.restore_pending) {
          move('restoration_required',{message:'Restore the saved module setup before preparing a run.',reason:'restore_pending'}); return false;
        }
        if (before.operation?.status === 'awaiting_apply' && validContext(before.operation,token.scope)) {
          store.save(token.scope,'preparation',{preset,operationId:before.operation.id,revision:before.operation.revision,outcome:before.operation.status});
          return apply(token,before.operation,'preparation');
        }
        if (!before.operation && Object.keys(before.state?.player || {}).length) {
          move('applying',{message:'Using your completed scan…'});
          await effect(token,()=>io.applySaved({saved_observations:true}));
        }
        waiting=null;
        move('checking_readiness',{message:'Checking this run’s requirements…'});
        let result=await effect(token,()=>io.readiness(preset));
        if (result.ready === true) {
          move('ready',{message:'Ready. You can start this run from Overview.'});
          await effect(token,()=>io.completed?.('preparation')); return true;
        }
        if (result.next_action === 'edit_run') {
          move('editing_equipment',{message:result.message,reason:'edit_run'});
          await effect(token,()=>io.editRun?.(preset)); return false;
        }
        if (result.next_action === 'crop_image') {
          move('capture_required',{message:result.message,reason:'crop_image'}); return false;
        }
        if (typeof result.ready !== 'boolean') {
          move('needs_attention',{message:'Readiness was not confirmed. Check this run again before preparing battle controls.',reason:'readiness_unknown'}); return false;
        }
        move('confirming',{message:'Waiting for permission to prepare missing battle controls.'});
        if (!await effect(token,()=>io.confirm('preparation'))) {
          move('cancelled',{message:'Discoveries saved. Battle preparation has not started.'}); return false;
        }
        move('starting',{message:'Preparing recognition automatically…'});
        const intent=await launch(token,before,{bootstrap:true,flows:true,battle_only:true,phases:'c,m',overwrite:false,allow_navigation:true});
        io.preparing?.(preset);
        move('waiting_for_worker',{message:'Preparation requested. Waiting for its worker…'});
        const launched=now();
        let observations=0;
        while (now()-launched < 3600000 && observations++ < 3000) {
          await effect(token,()=>io.wait(1200));
          let observed;
          try { observed=await effect(token,()=>io.status(token.operationId)); state.observation(); }
          catch(error) {
            if (error instanceof Superseded) throw error;
            state.observation(error); publish();
            return false;
          }
          const record=recordOf(observed);
          if (record && record.id !== intent.operationId) throw new Superseded();
          if (!matches(record,intent)) {
            if (now()-launched > 30000) throw new Error('The scan did not start. Please try Prepare this run again.');
            continue;
          }
          if (record.revision < (intent.revision || 0)) continue;
          if (!validContext(record,token.scope)) throw new Superseded('Operation target changed.');
          const bound=bind(token.scope,'preparation',intent,record);
          if (!bound) throw new Superseded('A newer preparation request replaced this one.');
          Object.assign(intent,bound);
          token.operationId=record.id; token.revision=record.revision;
          if (observed.restore_pending || record.status === 'restoration_required') {
            move('restoration_required',{operationId:record.id,revision:record.revision,message:'Equipment restoration must finish before discoveries can be applied.',reason:'restore_pending'});
            return false;
          }
          if (observed.running || ['accepted','running','cancelling','applying'].includes(record.status)) {
            move('running',{operationId:record.id,revision:record.revision,message:record.message || 'Battle preparation is running.'}); continue;
          }
          if (!['awaiting_apply','succeeded'].includes(record.status)) {
            move('stopped',{operationId:record.id,revision:record.revision,message:'Preparation stopped. See the latest scan step for the reason.',reason:record.status}); return false;
          }
          await apply(token,record,'preparation');
          return true;
        }
        state.observation(new Error('Preparation is still unconfirmed. Status polling will reconnect to this operation.')); publish();
        return false;
      });
    }
    function review() {
      return startCommand('learning',io.selectedRun?.() || 'bp_coin_default',async token=>{
        move('checking',{message:'Checking the saved discoveries before applying them…'});
        const reviewedId=io.activeOperation?.();
        const observed=await effect(token,()=>io.status(reviewedId)); state.observation();
        if (observed.running) throw new Error('A scan is already running. Let it finish first.');
        if (observed.restore_pending) {
          move('restoration_required',{message:'Restore the saved module setup before applying discoveries.',reason:'restore_pending'});
          return false;
        }
        const record=recordOf(observed);
        if ((reviewedId && (record?.id !== reviewedId || io.activeOperation?.() !== reviewedId)) || (record && !validContext(record,token.scope)))
          throw new Superseded('The operation being reviewed changed.');
        if (record && validContext(record,token.scope)) store.save(token.scope,'learning',{preset:token.preset,operationId:record.id,revision:record.revision,outcome:record.status});
        token.forgetReviewedLegacy=store.forgetLater(['finishFullSetup']);
        return apply(token,recordOf(observed));
      });
    }
    function observe(observed) {
      const context=scope(), record=recordOf(observed);
      if (operationToken && !current(operationToken)) { waiting=null; generation++; operationToken=null; move('superseded',{message:'',reason:'context_changed'}); }
      if (!record?.id || !Number.isInteger(record.revision) || !validContext(record,context)) return Promise.resolve();
      let pending=store.pending(context), learning=store.learning(context);
      const resumed=matches(record,pending), full=matches(record,learning);
      if (!resumed && !full) {
        if (operationToken?.operationId && operationToken.operationId !== record.id && io.activeOperation?.() === record.id) supersede(operationToken,'operation_replaced');
        return Promise.resolve();
      }
      const intent=resumed ? pending : learning, flow=resumed ? 'preparation' : 'learning';
      if (state.snapshot().phase === 'ready' && state.snapshot().operationId === record.id && record.revision <= (operationToken?.revision || 0)) return Promise.resolve();
      if (record.revision < (intent.revision || 0)) return Promise.resolve();
      if (operationToken && current(operationToken) && operationToken.operationId === record.id &&
          record.revision < (operationToken.revision || 0)) return Promise.resolve();
      state.observation();
      if (command || completion) {
        const token=command || operationToken;
        if (token?.operationId && token.operationId !== record.id) supersede(token,'operation_replaced');
        return Promise.resolve();
      }
      let token=waiting || operationToken;
      if (token?.operationId && token.operationId !== record.id) { supersede(token,'operation_replaced'); token=null; }
      if (!token || !current(token) || state.isTerminal()) token=begin(flow,context,intent.preset);
      const bound=bind(context,flow,intent,record);
      if (!bound) { supersede(token,'request_replaced'); return Promise.resolve(); }
      token.operationId=record.id; token.revision=record.revision;
      state.observation();
      const fields={operationId:record.id,revision:record.revision,outcome:record.status};
      if (applicationSucceeded(record)) {
        if (state.snapshot().phase === 'ready' && state.snapshot().operationId === record.id) return Promise.resolve();
        completion=(async()=>{
          try {
            move('checking_readiness',{...fields,message:'Checking this run again after reconnecting.'});
            const result=await effect(token,()=>io.readiness(token.preset));
            move(result.ready === true ? 'ready' : 'needs_attention',{reason:result.ready === true ? null : 'readiness_unconfirmed',message:result.message || (result.ready === true ? 'Ready. You can start this run from Overview.' : 'Readiness was not confirmed.')});
          } catch(error) { fail(token,error); } finally { completion=null; publish(); }
        })();
        return completion;
      }
      if (observed.restore_pending || record.status === 'restoration_required') {
        waiting=token; move('restoration_required',{...fields,message:'Restore the saved equipment before applying discoveries.',reason:'restore_pending'}); return Promise.resolve();
      }
      if (['accepted','running','cancelling','applying'].includes(record.status)) {
        waiting=token;
        move(record.status === 'accepted' ? 'waiting_for_worker' : 'running',{...fields,message:record.message || 'The preparation operation is running.'});
        return Promise.resolve();
      }
      if (['failed','interrupted','cancelled'].includes(record.status)) {
        waiting=null; move('stopped',{...fields,message:record.error?.message || 'Preparation stopped. Review its last confirmed step.',reason:record.status}); return Promise.resolve();
      }
      if (record.status !== 'awaiting_apply') return Promise.resolve();
      completion=(async()=>{
        try { await apply(token,record,flow); }
        catch(error) { fail(token,error,'Setup could not finish: '); }
        finally { completion=null; publish(); }
      })();
      return completion;
    }
    function unavailable(error) { state.observation(error); return publish(); }
    return {learn,prepare,review,observe,unavailable,snapshot,
      pending:()=>store.pending(scope()),reference:()=>store.pending(scope()) || store.learning(scope()),preparationKey:()=>scope().preparationKey,
      settled:()=>completion || Promise.resolve()};
  }
  return {create};
});
