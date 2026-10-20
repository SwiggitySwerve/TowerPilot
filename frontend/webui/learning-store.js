/* Context-bound browser records. Worker results remain owned by the backend. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LearningStore = api;
})(globalThis, function() {
  'use strict';
  function context(config={}) {
    const instance = config.active_instance, device = config.instances?.[instance] || {};
    const preparationKey = 'runPreparation:' + JSON.stringify([instance,device.account,device.serial,device.rendering]);
    return Object.freeze({id:JSON.stringify([instance,device.account,device.serial,device.rendering,config.active_profile]),
      instance,account:device.account,serial:device.serial,profile:config.active_profile,rendering:device.rendering,preparationKey});
  }
  const learningKey = scope => 'screenLearning:' + scope.id;
  function create(storage) {
    function read(key) {
      const raw = storage.getItem(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    }
    function pending(scope) {
      const record = read(scope.preparationKey);
      return record && record.context === scope.id ? record : null;
    }
    function learning(scope) {
      const record = read(learningKey(scope));
      return record?.context === scope.id ? record : null;
    }
    function save(scope, flow, record) {
      const saved={...record,context:scope.id};
      storage.setItem(flow === 'learning' ? learningKey(scope) : scope.preparationKey,
        JSON.stringify(saved));
      return saved;
    }
    function replace(scope, flow, expected, record) {
      if (!isCurrent(scope,flow,expected)) return null;
      return save(scope,flow,record);
    }
    function isCurrent(scope, flow, expected) {
      const key=flow === 'learning' ? learningKey(scope) : scope.preparationKey;
      return storage.getItem(key) === JSON.stringify(expected);
    }
    function forgetLater(keys) {
      const saved = keys.map(key=>storage.getItem(key));
      return () => keys.forEach((key,i)=>{
        if (storage.getItem(key) === saved[i]) storage.removeItem(key);
      });
    }
    return {pending,learning,save,replace,isCurrent,forgetLater,
      keys:scope=>[scope.preparationKey,learningKey(scope)],
      hasLegacyLearning:()=>storage.getItem('finishFullSetup') !== null};
  }
  return {context,learningKey,create};
});
