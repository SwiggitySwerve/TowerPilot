/* Flow state and legal transitions; no I/O or presentation. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LearningState = api;
})(globalThis, function() {
  'use strict';
  const terminal = new Set(['ready','needs_attention','editing_equipment','capture_required','cancelled','stopped','failed','superseded']);
  const edges = {
    idle:['checking_readiness','confirming','checking','running','applying','waiting_for_worker','restoration_required','stopped','needs_attention'],
    confirming:['checking','starting','cancelled'],
    checking:['starting','applying','checking_readiness','restoration_required'],
    starting:['waiting_for_worker','running','restoration_required'],
    waiting_for_worker:['checking_readiness','running','applying','stopped','restoration_required'],
    running:['checking_readiness','waiting_for_worker','applying','stopped','restoration_required'],
    applying:['waiting_to_apply','checking_readiness'],
    waiting_to_apply:['checking_readiness','running','waiting_for_worker','applying','stopped','restoration_required'],
    checking_readiness:['ready','needs_attention','editing_equipment','capture_required','confirming'],
    restoration_required:['checking_readiness','running','waiting_for_worker','applying','stopped'],
  };
  function create(now = () => Date.now()) {
    let state = {flow:null,phase:'idle',context:null,preset:null,operationId:null,revision:null,message:'',reason:null,
      freshness:'unknown',checkedAt:null,history:[]};
    const snapshot = () => Object.freeze({...state,history:Object.freeze(state.history.map(row=>Object.freeze({...row})))});
    function begin(flow, context, preset=null) {
      if (!['learning','preparation'].includes(flow)) throw new Error('Unknown learning flow: ' + flow);
      state = {flow,phase:'idle',context,preset,operationId:null,revision:null,message:'',reason:null,
        freshness:'unknown',checkedAt:null,history:[]};
      return snapshot();
    }
    function transition(phase, changes={}) {
      if (state.flow !== 'preparation' && ['editing_equipment','capture_required'].includes(phase))
        throw new Error('Only run preparation can require equipment or a manual capture');
      if (phase !== state.phase && !['failed','superseded'].includes(phase) && !(edges[state.phase] || []).includes(phase))
        throw new Error(`Invalid ${state.flow} transition: ${state.phase} -> ${phase}`);
      const entry = {from:state.phase,to:phase,at:now(),reason:changes.reason || null};
      const changed = phase !== state.phase || changes.reason !== undefined && changes.reason !== state.reason;
      state = {...state,...changes,phase,history:changed ? [...state.history,entry].slice(-40) : state.history};
      return snapshot();
    }
    function observation(error=null) {
      state = {...state,freshness:error ? 'unavailable' : 'confirmed',
        checkedAt:error ? state.checkedAt : now(),observationError:error ? error.message : null};
      return snapshot();
    }
    return {snapshot,begin,transition,observation,isTerminal:()=>terminal.has(state.phase)};
  }
  return {create};
});
