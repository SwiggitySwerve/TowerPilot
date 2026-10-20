/* Human-readable tracking feedback; no commands, storage or lifecycle decisions. */
(function(root, factory) {
  const api=factory();
  if (typeof module === 'object' && module.exports) module.exports=api;
  else root.LearningView=api;
})(globalThis,function() {
  'use strict';
  const phases={
    confirming:'Awaiting confirmation',checking:'Checking current operation',starting:'Starting',
    waiting_for_worker:'Waiting for worker',running:'Running',applying:'Saving discoveries',
    waiting_to_apply:'Waiting to save',checking_readiness:'Checking run readiness',
    restoration_required:'Equipment restoration required',ready:'Ready',needs_attention:'Needs attention',
    editing_equipment:'Choose equipment',capture_required:'Manual capture needed',
    cancelled:'Cancelled',stopped:'Stopped',failed:'Failed',superseded:'Selection or operation changed',
  };
  function gameHint(phase) {
    if (phase === 'confirming') return 'Game: open at Home, with no battle or tournament running.';
    if (['starting','waiting_for_worker','running','restoration_required'].includes(phase))
      return 'Game: keep it running and leave the emulator untouched.';
    if (phase === 'capture_required') return 'Game: open the requested screen for manual capture.';
    if (['checking','applying','waiting_to_apply','checking_readiness','ready','editing_equipment'].includes(phase))
      return 'Game: not required for this data step. Keep it open if another operation is running.';
    return '';
  }
  function text(snapshot) {
    if (!snapshot?.flow) return '';
    const flow=snapshot.flow === 'learning' ? 'Screen learning' : 'Run preparation';
    const status=phases[snapshot.phase] || snapshot.phase;
    const freshness=snapshot.freshness === 'unavailable' ? 'Status unavailable; showing the last confirmed step.' : '';
    return [flow+' · '+status,snapshot.message,gameHint(snapshot.phase),freshness].filter(Boolean).join(' — ');
  }
  return {text};
});
