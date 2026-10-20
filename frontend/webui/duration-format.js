/* One duration helper for every seconds input; values remain stored in seconds. */
(function(root,factory) {
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.TowerDuration=api;
})(typeof globalThis==='object'?globalThis:this,function() {
  'use strict';
  function format(value) {
    if(typeof value!=='number' || !Number.isFinite(value) || value<=60)return '';
    const fraction=String(value).match(/^\d+\.(\d+)$/)?.[1];
    const seconds=String(Math.floor(value)%60).padStart(2,'0');
    return `${Math.floor(value/60)}m ${seconds}${fraction?'.'+fraction:''}s`;
  }
  return {format};
});
