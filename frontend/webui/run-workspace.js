/* Shared saved/live run controls. Server snapshots, drafts and acknowledgements
   stay separate; polling never replaces an input the person is editing. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunWorkspace = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const get = (value, path) => path.split('.').reduce((v,k) => v?.[k], value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const label = value => String(value).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const identity = battle => battle ? [battle.id, battle.operation_id, battle.generation].join(':') : '';
  const savedIdentity = snapshot => JSON.stringify([snapshot.blueprint,snapshot.context?.instance,snapshot.context?.account,snapshot.context?.profile]);
  function durationHint(value) {
    if(!numeric(value) || value<=60)return '';
    // Keep decimal digits from the input's numeric representation: subtracting
    // minutes introduces floating-point tails, while rounding changes durations.
    const fraction=String(value).match(/^\d+\.(\d+)$/)?.[1];
    const seconds=String(Math.floor(value)%60).padStart(2,'0');
    return `${Math.floor(value/60)}m ${seconds}${fraction?'.'+fraction:''}s`;
  }
  function flatOverrides(value,prefix='') {
    const result={};
    for(const [key,item] of Object.entries(value || {})) {
      const path=prefix?`${prefix}.${key}`:key;
      if(item && typeof item==='object' && !Array.isArray(item) && path!=='shopping_plan')Object.assign(result,flatOverrides(item,path));
      else result[path]=item;
    }
    return result;
  }
  function effective(base, overrides) {
    const result = clone(base || {});
    for (const [path,value] of Object.entries(flatOverrides(overrides))) {
      if (value === null) continue;
      const parts = path.split('.'); let node = result;
      for (const key of parts.slice(0,-1)) node = node[key] ||= {};
      node[parts.at(-1)] = clone(value);
    }
    return result;
  }
  function countdown(runtime, enabled, now = Date.now()/1000) {
    if (enabled === false) return 'Off';
    if (!runtime) return 'Timing unknown';
    const state = runtime.state || runtime.status;
    if(runtime.blocker)return label(runtime.blocker);
    if (['blocked','paused','off','condition','waiting_condition','busy'].includes(state))
      return runtime.blocked_reason || runtime.condition || label(state);
    const observed=runtime.observed_at ?? runtime.server_time;
    if (!numeric(observed) || now-observed > 15) return 'Stale observation';
    if(numeric(runtime.window_ends_at))return `Window ${Math.max(0,Math.ceil(runtime.window_ends_at-now))}s`;
    if(['active','running'].includes(state))return label(state);
    const deadline = runtime.deadline ?? runtime.next_due_at;
    if (!numeric(deadline)) return 'Timing unknown';
    const seconds = Math.max(0, Math.ceil(deadline-now));
    return seconds ? `${seconds}s` : 'Due · awaiting driver';
  }
  function makeModel(scope, snapshot) {
    return {scope, key:scope === 'live' ? identity(snapshot) : savedIdentity(snapshot),
      snapshot:clone(snapshot), draft:{}, pending:{}, invalid:new Set(), sending:false, error:'', request:0};
  }
  function refresh(model, snapshot) {
    const key = model.scope === 'live' ? identity(snapshot) : savedIdentity(snapshot);
    if (key !== model.key) return false;
    if (model.scope === 'live' && (snapshot.control_revision < model.snapshot.control_revision || snapshot.applied_revision < model.snapshot.applied_revision)) return false;
    model.snapshot = clone(snapshot);
    const applied = snapshot.applied_revision;
    for (const [path,item] of Object.entries(model.pending)) {
      if (numeric(applied) && numeric(item.revision) && applied >= item.revision) delete model.pending[path];
    }
    return true;
  }
  function settings(model) {
    const s = model.snapshot;
    return model.scope === 'saved' ? s.settings || {} : s.effective || effective(s.envelope?.controls || s.settings || {}, s.overrides);
  }
  function fieldValue(model,path) {
    if (Object.hasOwn(model.draft,path)) return model.draft[path] === null ? get(model.snapshot.envelope?.controls,path) : model.draft[path];
    if (model.pending[path]) return model.pending[path].value === null ? get(model.snapshot.envelope?.controls,path) : model.pending[path].value;
    return get(settings(model),path);
  }
  function command(model, extra) {
    const s = model.snapshot;
    return {battle_id:s.id,generation:s.generation,expected_revision:s.control_revision,
      idempotency_key:globalThis.crypto?.randomUUID?.() || `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`,...extra};
  }
  const routineFields = {
    ad_gems:{interval_sec:'Every',window_sec:'Window'},
    floating_gems:{interval_sec:'Every',window_sec:'Window',tap_interval_sec:'Tap every'},
    shopping:{interval_sec:'Every'},rewards:{},abilities:{},rescue:{},repeat:{}
  };
  function allowed(model,path,action=false) {
    const caps = model.snapshot.capabilities;
    return Array.isArray(caps?.[action?'actions':'controls']) && caps[action?'actions':'controls'].includes(path);
  }
  function inputHTML(model,path,title,options={}) {
    const value = fieldValue(model,path);
    const pending = Object.hasOwn(model.draft,path) || !!model.pending[path];
    const support = allowed(model,path);
    const constraint = model.snapshot.constraints?.[path] || {};
    const base = get(model.snapshot.envelope?.controls,path);
    const overridden = Object.hasOwn(flatOverrides(model.snapshot.overrides),path) || pending;
    const attrs = `data-control="${esc(path)}" ${support?'':'disabled'} title="${esc(support?title:'Unavailable in this driver')}"`;
    const control = options.boolean
      ? `<input type="checkbox" ${attrs} ${value===true?'checked':''}>`
      : `<input type="number" ${attrs} value="${esc(value)}" ${constraint.min!==undefined?`min="${esc(constraint.min)}"`:''} ${constraint.max!==undefined?`max="${esc(constraint.max)}"`:''} step="${esc(constraint.step ?? 'any')}" ${options.inherit?'placeholder="Inherit"':''}>`;
    const duration=!options.boolean && path.endsWith('_sec')?durationHint(value):'';
    const hint=!options.boolean && path.endsWith('_sec')?`<small class="rw-duration-hint" data-duration="${esc(path)}" ${duration?'':'hidden'}>${esc(duration)}</small>`:'';
    return `<label class="rw-field ${options.boolean?'rw-toggle':''}"><span>${esc(title)}</span>${control}${hint}<small data-pending="${esc(path)}">${pending?'Pending':model.scope==='live'?`Default ${esc(base ?? 'unknown')}${overridden?' · override':''}`:options.inherit?'Blank inherits':''}</small></label>`;
  }
  function actionHTML(model,action,title='Run now') {
    return model.scope !== 'live' ? '' : `<button type="button" class="small ghost" data-action="${esc(action)}" aria-label="${esc(title==='▶'?`Try once: ${label(action.split(':').at(-1))}`:title+': '+label(action.split(':').at(-1)))}" ${allowed(model,action,true)&&!model.sending?'':'disabled'}>${esc(title)}</button>`;
  }
  function routinesHTML(model) {
    return `<div class="rw-routines">${Object.entries(settings(model).routines || {}).map(([name,values]) =>
      `<section class="rw-routine" data-routine="${esc(name)}"><div class="rw-routine-title"><strong>${esc(label(name))}</strong><span data-countdown="${esc(name)}" class="rw-clock"></span>${actionHTML(model,name)}</div><div class="rw-fields">${inputHTML(model,`routines.${name}.enabled`,'On',{boolean:true})}${Object.entries(routineFields[name]||{}).filter(([key])=>Object.hasOwn(values,key)).map(([key,title])=>inputHTML(model,`routines.${name}.${key}`,`${title} (s)`)).join('')}</div></section>`).join('')}</div>`;
  }
  function shoppingHTML(model) {
    const plan=fieldValue(model,'shopping_plan');
    if(!plan) {
      const conversion=model.snapshot.legacy_conversion;
      return `<p class="muted">No queue plan is configured. Existing shopping policy is retained.</p>${conversion?conversionHTML(model):allowed(model,'shopping_plan')?'<button class="small ghost" data-new-plan>Create workshop queue</button>':''}`;
    }
    if(plan.version!==2 || !Array.isArray(plan.queue))return '<p class="muted">Legacy shopping policy requires review in the existing editor.</p>';
    const catalog=model.snapshot.catalog;
    if(!catalog)return '<p class="muted">Upgrade catalog unavailable. Existing settings are retained.</p>';
    const entries=Array.isArray(catalog)?catalog:catalog.upgrades || [];
    const supported=allowed(model,'shopping_plan');
    const number=(path,value,title,inherit=false)=>`<label class="rw-field"><span>${esc(title)}</span><input type="number" min="${title.includes('wave') || path.endsWith('.weight')?1:0}" step="1" ${path.endsWith('.weight')?'max="100"':''} data-shop="${esc(path)}" value="${esc(value)}" ${inherit?'placeholder="No limit"':'required'} ${supported?'':'disabled'}><small>${inherit?'Blank = no limit':''}</small></label>`;
    const chipNumber=(path,value,name,weight=false)=>`<input class="rw-chip-number" type="number" min="${weight?1:0}" step="1" ${weight?'max="100"':''} data-shop="${esc(path)}" value="${esc(value)}" aria-label="${esc(weight?'Per turn: '+name:'Tap limit: '+name)}" title="${esc(weight?'Purchases per turn in Weighted split':'Tap limit; blank means unlimited')}" ${weight?'required':'placeholder="∞"'} ${supported?'':'disabled'}>`;
    const queue=plan.queue;
    const selectors = `<div class="rw-selector-pages"><p class="muted rw-plan-note">Select upgrades by workshop page. Game order is provisional where unverified. Selected upgrades enter one shared queue.</p>${['attack','defense','utility'].map(sid=>`<section class="rw-section rw-${sid}"><div class="rw-section-title"><strong>${esc(label(sid))}</strong><span data-countdown="shopping:${sid}" class="rw-clock"></span>${actionHTML(model,`shopping:${sid}`)}</div><ul class="know-grid rw-upgrades">${entries.filter(u=>(u.section || u.tab)===sid).sort((a,b)=>(a.game_order ?? a.order)-(b.game_order ?? b.order)).map(entry=> {
      const item=queue.find(u=>u.id===entry.id);const selected=item?.enabled===true && !(plan.excluded_upgrades || []).includes(entry.id);
      const unavailable=entry.recognition==='unsupported';
      const path=`queue.${entry.id}`;
      const hint=[entry.label,unavailable?'Recognition unavailable':entry.order_verified?'Game order verified':'Game order unverified',entry.excluded_by_default?(entry.exclusion_reason || 'Excluded by default'):''].filter(Boolean).join(' · ');
      const play=model.scope==='live'?actionHTML(model,`shopping:${sid}:${entry.id}`,'\u25b6'):`<button class="small ghost" type="button" disabled aria-label="Try once: ${esc(entry.label)}" title="Available in the current battle">\u25b6</button>`;
      return `<li class="chip rw-upgrade ${selected?'on':''}" data-upgrade="${esc(entry.id)}" draggable="${supported&&!unavailable}" title="${esc(hint)}"><button class="rw-chip-toggle" type="button" data-shop-toggle="${path}.enabled" aria-pressed="${selected}" aria-label="${esc(entry.label)}" aria-description="${esc(hint)}" ${supported&&!unavailable?'':'disabled'}><span class="know-name">${esc(entry.label)}</span><span class="know-marks"><span aria-label="${selected?'active':'unselected'}">${selected?'\u2713':'\u25cb'}</span>${unavailable?'<span aria-label="unsupported">?</span>':''}</span></button><div class="rw-chip-controls" ${selected?'':'hidden'}>${chipNumber(`${path}.tap_limit`,item?.tap_limit,entry.label)}<span data-weight-field ${plan.queue_mode==='weighted_split'?'':'hidden'}><span aria-hidden="true">×</span>${chipNumber(`${path}.weight`,item?.weight ?? 1,entry.label,true)}</span>${play}</div></li>`;
    }).join('')}</ul></section>`).join('')}</div>`;
    return `<div class="rw-queue-layout"><section class="rw-global-queue"><header><strong>Global priority queue</strong></header><div class="rw-fields">${number('cash_reserve',plan.cash_reserve,'Keep cash ($)')}<label class="rw-field"><span>Purchase pattern</span><select data-shop="queue_mode" ${supported?'':'disabled'}><option value="round_robin" ${plan.queue_mode==='round_robin'?'selected':''}>Round robin</option><option value="highest_affordable" ${plan.queue_mode==='highest_affordable'?'selected':''}>Single focus (affordable)</option><option value="weighted_split" ${plan.queue_mode==='weighted_split'?'selected':''}>Weighted split</option></select></label></div><p class="muted rw-plan-note">Single focus selects the highest priority affordable upgrade. Round robin rotates through eligible upgrades. Weighted split uses each upgrade's per-turn amount. Purchases wait when reserve, quantity or available cash cannot be verified.</p><ol class="rw-queue" data-queue>${queueHTML(model)}</ol></section>${selectors}</div>`;
  }
  function conversionHTML(model) {
    const conversion=model.snapshot.legacy_conversion;
    const plan=model.conversionDraft || conversion.plan;
    const catalog=model.snapshot.catalog;
    const entries=Array.isArray(catalog)?catalog:catalog?.upgrades || [];
    const queue=(plan.queue || []).filter(item=>item.enabled && !(plan.excluded_upgrades || []).includes(item.id));
    const patterns={highest_affordable:'Single focus (affordable)',round_robin:'Round robin',weighted_split:'Weighted split'};
    const support=allowed(model,'shopping_plan');
    return `<details class="rw-conversion"><summary>Review shopping conversion · ${queue.length} selected upgrades</summary><p class="muted rw-plan-note">Preview only. Choose a reserve and review the proposed tap limits before applying.</p><div class="rw-fields"><label class="rw-field"><span>Keep cash ($)</span><input type="number" min="0" step="any" required data-conversion="cash_reserve" value="${esc(plan.cash_reserve)}" ${support?'':'disabled'}></label><label class="rw-field"><span>Purchase pattern</span><select data-conversion="queue_mode" ${support?'':'disabled'}>${Object.entries(patterns).map(([key,title])=>`<option value="${key}" ${plan.queue_mode===key?'selected':''}>${title}</option>`).join('')}</select></label></div><ol class="know-grid rw-conversion-preview">${queue.map((item,index)=> {
      const entry=entries.find(e=>e.id===item.id);
      return `<li class="rw-${esc(entry?.section || '')}"><span class="know-name">${index+1}. ${esc(entry?.label || label(item.id))}</span><small>${item.tap_limit===null?'No tap cap':`${esc(item.tap_limit)} taps`}${plan.queue_mode==='weighted_split'?` · ${esc(item.weight ?? 1)}/turn`:''}</small></li>`;
    }).join('')}</ol><details><summary>Conversion notes (${(conversion.warnings || []).length})</summary><ul class="rw-conversion-notes">${(conversion.warnings || []).map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details><details><summary>Raw configuration</summary><pre>${esc(JSON.stringify(plan,null,2))}</pre></details>${support?`<button class="small" data-convert-plan ${!numeric(plan.cash_reserve)||plan.cash_reserve<0?'disabled':''}>Use reviewed queue</button>`:''}</details>`;
  }
  function historySummaryHTML(battle) {
    const runtime=battle.runtime || {};
    const capture=runtime.stats_capture || battle.stats_capture;
    const duration=runtime.observed_duration_sec;
    const elapsed=numeric(duration)?`${Math.floor(duration/60)}m ${Math.floor(duration%60)}s observed`:'Unknown';
    const wave=battle.final_wave ?? battle.boundary_evidence?.last_observed_wave ?? runtime.observed_wave;
    const captureState=capture?.status?label(capture.status):'Unknown';
    return `<div class="rw-history-summary"><span>Last observed wave <strong>${esc(wave ?? 'unknown')}</strong></span><span>Observed duration <strong>${esc(elapsed)}</strong></span><span>Stats capture <strong>${esc(captureState)}</strong>${capture?.verified===true?' · verified':capture?.verified===false?' · unverified':''}</span><span>Gems <strong>unknown</strong></span></div>${capture?.reason || capture?.error?`<p class="muted rw-plan-note">${esc(capture.reason || capture.error)}</p>`:''}`;
  }
  function queueHTML(model) {
    const plan=fieldValue(model,'shopping_plan');
    const catalog=model.snapshot.catalog;
    const entries=Array.isArray(catalog)?catalog:catalog?.upgrades || [];
    const rows=(plan?.queue || []).filter(item=>item.enabled && !(plan.excluded_upgrades || []).includes(item.id)).map((item,index)=> {
      const entry=entries.find(e=>e.id===item.id);
      return `<li draggable="${allowed(model,'shopping_plan')}" data-queue-id="${esc(item.id)}" class="rw-queue-item rw-${esc(entry?.section || '')}" title="${esc(entry?.label || item.id)}"><span aria-hidden="true">&#8942;&#8942;</span><strong>${index+1}. ${esc(entry?.label || item.id)}${entry?'':' · catalog entry unknown'}</strong><button class="small ghost" type="button" data-move="${esc(item.id)}" data-direction="-1" aria-label="Move ${esc(entry?.label || item.id)} up" ${allowed(model,'shopping_plan')?'':'disabled'}>&#8593;</button><button class="small ghost" type="button" data-move="${esc(item.id)}" data-direction="1" aria-label="Move ${esc(entry?.label || item.id)} down" ${allowed(model,'shopping_plan')?'':'disabled'}>&#8595;</button></li>`;
    }).join('');
    return rows+(allowed(model,'shopping_plan')?'<li class="rw-queue-end" data-queue-end>Drop here to add to the end · or select an upgrade</li>':'');
  }
  function editPlan(plan,path,value) {
    const result=clone(plan);const parts=path.split('.');
    if(parts[0]==='queue') {
      const id=parts[1];let item=result.queue.find(u=>u.id===id);
      if(!item){item={id,enabled:true,tap_limit:null,from_wave:1,until_wave:null,weight:1};result.queue.push(item);}
      const wasSelected=item.enabled && !(result.excluded_upgrades || []).includes(id);
      item[parts[2]]=value;
      if(parts[2]==='enabled' && value===true){
        result.excluded_upgrades=(result.excluded_upgrades || []).filter(x=>x!==id);
        if(!wasSelected){result.queue=result.queue.filter(u=>u.id!==id);result.queue.push(item);}
      }
    } else result[path]=value;
    return result;
  }
  function moveQueue(plan,id,targetId) {
    const result=clone(plan);const from=result.queue.findIndex(u=>u.id===id);const to=result.queue.findIndex(u=>u.id===targetId);
    if(from<0 || to<0 || from===to)return result;
    const [item]=result.queue.splice(from,1);result.queue.splice(to,0,item);return result;
  }
  function dropInQueue(plan,id,targetId=null) {
    const result=editPlan(plan,`queue.${id}.enabled`,true);
    if(id===targetId)return result;
    const from=result.queue.findIndex(item=>item.id===id);
    const [item]=result.queue.splice(from,1);
    const target=result.queue.findIndex(item=>item.id===targetId);
    result.queue.splice(target<0?result.queue.length:target,0,item);
    return result;
  }
  function renderHTML(model) {
    return `<div class="rw-workspace" data-scope="${model.scope}"><div class="rw-toolbar"><div><strong>${model.scope==='live'?'Current battle':'Saved run controls'}</strong><small>${model.scope==='live'?'Applies to this battle · frozen defaults are retained':'Autosaved for future battles'}</small></div>${model.scope==='live'?'<button class="small ghost" data-reset>Reset live overrides</button>':''}<span role="status" class="rw-status"></span></div>${model.snapshot.notice?`<p class="muted rw-plan-note">${esc(model.snapshot.notice)}</p>`:''}${routinesHTML(model)}<section class="rw-shopping"><header><strong>Workshop</strong></header><p data-shopping-warning class="warn" hidden></p>${shoppingHTML(model)}</section></div>`;
  }
  function create(options) {
    const {request,onError=()=>{}} = options;
    let liveHost=null, savedHost=null, historyHost=null, live=null, saved=null;
    let selected='', epoch=0, pollBusy=false, historyKey='', historyRequest=0, context='';
    const timers = new Map();
    const bindings = new WeakMap();
    const clockTimer=globalThis.document?setInterval(()=>{if(liveHost?.isConnected && live)clocks(liveHost,live);},1000):null;
    const current = (host,model) => host && bindings.get(host)===model && (model.scope==='live'?host===liveHost && model===live:host===savedHost && model===saved);
    const unacknowledged = model => model.scope==='live' && numeric(model.snapshot.control_revision) && (!numeric(model.snapshot.applied_revision) || model.snapshot.applied_revision<model.snapshot.control_revision);
    const actionBusy = model => {
      const commands=model.snapshot.commands || [];
      const values=Array.isArray(commands)?commands:Object.values(commands);
      return !!model.actionPending || values.some(c=>['requested','pending','started','running','executing'].includes(c.state || c.status));
    };
    const fetchJSON = (url,body) => request(url,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    function status(host,model) {
      if (!current(host,model)) return;
      const el=host.querySelector('.rw-status');
      if (el) el.textContent=model.error || (model.invalid.size?'Enter a valid value':model.sending || Object.keys(model.draft).length || Object.keys(model.pending).length || unacknowledged(model) || actionBusy(model) ? 'Pending' : model.scope==='live'?'Driver acknowledged':'Saved');
      host.querySelectorAll('[data-control]').forEach(input=> {
        const path=input.dataset.control;
        if (input!==input.ownerDocument.activeElement && !model.invalid.has(path) && !Object.hasOwn(model.draft,path)) {
          const value=fieldValue(model,path);
          if (input.type==='checkbox') input.checked=value===true;
          else input.value=value ?? '';
        }
        const hint=host.querySelector(`[data-pending="${path}"]`);
        if (hint && (model.pending[path] || Object.hasOwn(model.draft,path))) hint.textContent='Pending';
        else if (hint && hint.textContent==='Pending') hint.textContent=model.scope==='live'?`Default ${get(model.snapshot.envelope?.controls,path) ?? 'unknown'}`:'Saved';
        const duration=host.querySelector(`[data-duration="${path}"]`);
        if(duration){duration.textContent=durationHint(input.value===''?null:Number(input.value));duration.hidden=!duration.textContent;}
      });
      const plan=fieldValue(model,'shopping_plan');
      host.querySelectorAll('[data-weight-field]').forEach(field=>field.hidden=plan?.queue_mode!=='weighted_split');
      const shopping=model.snapshot.runtime?.routines?.shopping?.last_outcome;
      const warning=host.querySelector('[data-shopping-warning]');
      if(warning){
        warning.hidden=!(model.scope==='live' && shopping && (shopping.reserve_supported===false || shopping.quantity_observation_supported===false));
        warning.textContent=shopping?.reserve_supported===false?'Legacy shopping does not protect a cash reserve. Review and convert the saved shopping policy before relying on reserve enforcement.':shopping?.quantity_observation_supported===false?'Shopping is waiting for verified purchase quantity; reserve protection cannot be confirmed.':'';
      }
      host.querySelectorAll('[data-shop]').forEach(input=> {
        if(input===input.ownerDocument.activeElement || model.invalid.has(input.dataset.shop) || !plan)return;
        const parts=input.dataset.shop.split('.');
        const value=parts[0]==='queue'?plan.queue?.find(u=>u.id===parts[1])?.[parts[2]]:plan[parts[0]];
        if(input.type==='checkbox')input.checked=value===true;
        else input.value=value ?? '';
      });
      host.querySelectorAll('[data-shop-toggle]').forEach(button=> {
        if(!plan)return;
        const id=button.dataset.shopToggle.split('.')[1];
        const selected=plan.queue?.some(u=>u.id===id && u.enabled) && !(plan.excluded_upgrades || []).includes(id);
        button.setAttribute('aria-pressed',String(!!selected));
        const mark=button.querySelector('.know-marks')?.firstElementChild;
        if(mark){mark.textContent=selected?'\u2713':'\u25cb';mark.setAttribute('aria-label',selected?'active':'unselected');}
        const chip=button.closest('.rw-upgrade');
        if(chip){chip.classList.toggle('on',!!selected);chip.querySelector('.rw-chip-controls').hidden=!selected;}
      });
      const queue=host.querySelector('[data-queue]');
      const signature=JSON.stringify(plan?.queue);
      if(queue && queue.dataset.signature!==signature && !queue.contains(queue.ownerDocument.activeElement)) {queue.innerHTML=queueHTML(model);queue.dataset.signature=signature;}
      host.querySelectorAll('[data-action]').forEach(button=>button.disabled=model.sending || model.observationUnavailable || model.invalid.size>0 || actionBusy(model) || unacknowledged(model) || !allowed(model,button.dataset.action,true) || Object.keys(model.pending).length>0 || Object.keys(model.draft).length>0 || !['active','running'].includes(model.snapshot.status));
      const reset=host.querySelector('[data-reset]');
      if(reset) reset.disabled=model.sending || actionBusy(model) || !Object.keys(flatOverrides(model.snapshot.overrides)).length;
      clocks(host,model);
    }
    function clocks(host,model) {
      if(!current(host,model))return;
      const now=Date.now()/1000+(model.clockOffset || 0);
      host?.querySelectorAll('[data-countdown]').forEach(el=> {
        el.textContent=model.scope==='live'?countdown(model.snapshot.runtime?.routines?.[el.dataset.countdown],fieldValue(model,`routines.${el.dataset.countdown}.enabled`),now):'';
      });
    }
    function mount(host,model) {
      bindings.set(host,model);
      host.innerHTML=renderHTML(model);
      host.oninput=event=> {
        const preview=event.target.closest('[data-conversion]');
        if(preview){
          model.conversionDraft ||= clone(model.snapshot.legacy_conversion.plan);
          const value=preview.tagName==='SELECT'?preview.value:preview.value===''?null:preview.valueAsNumber;
          model.conversionDraft[preview.dataset.conversion]=value;
          const button=host.querySelector('[data-convert-plan]');
          if(button)button.disabled=!preview.checkValidity() || !numeric(model.conversionDraft.cash_reserve) || model.conversionDraft.cash_reserve<0;
          const raw=host.querySelector('.rw-conversion pre');if(raw)raw.textContent=JSON.stringify(model.conversionDraft,null,2);
          return;
        }
        const shop=event.target.closest('[data-shop]');
        if(shop) {
          clearTimeout(timers.get(model));
          if(!allowed(model,'shopping_plan'))return;
          if(!shop.checkValidity()){model.invalid.add(shop.dataset.shop);status(host,model);return;}
          model.invalid.delete(shop.dataset.shop);
          const value=shop.type==='checkbox'?shop.checked:shop.tagName==='SELECT'?shop.value:shop.value===''?null:shop.valueAsNumber;
          model.draft.shopping_plan=editPlan(fieldValue(model,'shopping_plan'),shop.dataset.shop,value);
          model.error='';status(host,model);
          clearTimeout(timers.get(model));timers.set(model,setTimeout(()=>flush(host,model),450));return;
        }
        const input=event.target.closest('[data-control]'); if(!input)return;
        const path=input.dataset.control;
        if(!allowed(model,path))return;
        clearTimeout(timers.get(model));
        if(input.type!=='checkbox' && (input.value==='' || !input.checkValidity() || !Number.isFinite(input.valueAsNumber))){model.invalid.add(path);status(host,model);return;}
        model.invalid.delete(path);
        model.draft[path]=input.type==='checkbox'?input.checked:input.value===''?null:input.valueAsNumber;
        model.error=''; status(host,model);
        clearTimeout(timers.get(model)); timers.set(model,setTimeout(()=>flush(host,model),450));
      };
      host.onclick=event=> {
        const convert=event.target.closest('[data-convert-plan]');
        if(convert && !convert.disabled && allowed(model,'shopping_plan') && model.snapshot.legacy_conversion?.plan) {
          model.draft.shopping_plan=clone(model.conversionDraft || model.snapshot.legacy_conversion.plan);mount(host,model);flush(host,model);return;
        }
        const move=event.target.closest('[data-move]');
        if(move && !move.disabled) {
          const plan=fieldValue(model,'shopping_plan');const queue=plan.queue.filter(u=>u.enabled && !(plan.excluded_upgrades || []).includes(u.id));
          const index=queue.findIndex(u=>u.id===move.dataset.move);const target=queue[index+Number(move.dataset.direction)];
          if(target){model.draft.shopping_plan=moveQueue(plan,move.dataset.move,target.id);publishQueue(host,model);host.querySelector(`[data-move="${move.dataset.move}"][data-direction="${move.dataset.direction}"]`)?.focus();}
          return;
        }
        const add=event.target.closest('[data-new-plan]');
        if(add && allowed(model,'shopping_plan')) {
          model.draft.shopping_plan={version:2,enabled:true,interval_sec:5,cash_reserve:null,queue_mode:'highest_affordable',queue:[],excluded_upgrades:['defense_absolute']};
          mount(host,model);flush(host,model);return;
        }
        const toggle=event.target.closest('[data-shop-toggle]');
        if(toggle && !toggle.disabled) {
          const enabled=toggle.getAttribute('aria-pressed')!=='true';
          model.draft.shopping_plan=editPlan(fieldValue(model,'shopping_plan'),toggle.dataset.shopToggle,enabled);
          toggle.setAttribute('aria-pressed',String(enabled));
          toggle.querySelector('.know-marks').innerHTML=`<span aria-label="${enabled?'active':'unselected'}">${enabled?'✓':'○'}</span>`;
          const chip=toggle.closest('.rw-upgrade');chip.classList.toggle('on',enabled);chip.querySelector('.rw-chip-controls').hidden=!enabled;
          publishQueue(host,model);return;
        }
        const reset=event.target.closest('[data-reset]');
        if(reset) {
          for(const path of Object.keys(flatOverrides(model.snapshot.overrides))) model.draft[path]=null;
          flush(host,model); return;
        }
        const button=event.target.closest('[data-action]');
        if(button && !button.disabled) runAction(host,model,button.dataset.action);
      };
      host.ondragstart=event=> {
        const row=event.target.closest('[data-queue-id], [data-upgrade]');
        if(!row || row.getAttribute('draggable')!=='true' || !allowed(model,'shopping_plan') || event.target.closest('input,select,[data-action]')){event.preventDefault();return;}
        model.draggingUpgrade=row.dataset.queueId || row.dataset.upgrade;
        event.dataTransfer.setData('text/plain',model.draggingUpgrade);event.dataTransfer.effectAllowed='move';
      };
      const clearDrop=()=>host.querySelectorAll('.is-drop-target,.is-drag-over').forEach(element=>element.classList.remove('is-drop-target','is-drag-over'));
      host.ondragover=event=> {
        const queue=event.target.closest('[data-queue]');
        if(!queue || !model.draggingUpgrade || !allowed(model,'shopping_plan'))return;
        event.preventDefault();event.dataTransfer.dropEffect='move';clearDrop();queue.classList.add('is-drag-over');
        event.target.closest('[data-queue-id],[data-queue-end]')?.classList.add('is-drop-target');
      };
      host.ondragend=()=>{delete model.draggingUpgrade;clearDrop();};
      host.ondrop=event=> {
        const queue=event.target.closest('[data-queue]');if(!queue || !model.draggingUpgrade || !allowed(model,'shopping_plan'))return;
        event.preventDefault();const id=event.dataTransfer.getData('text/plain');
        if(id!==model.draggingUpgrade){host.ondragend();return;}
        const target=event.target.closest('[data-queue-id]')?.dataset.queueId;
        model.draft.shopping_plan=dropInQueue(fieldValue(model,'shopping_plan'),id,target);
        host.ondragend();publishQueue(host,model);
      };
      status(host,model);
    }
    function publishQueue(host,model) {
      const queue=host.querySelector('[data-queue]');if(queue)queue.innerHTML=queueHTML(model);
      model.error='';status(host,model);clearTimeout(timers.get(model));timers.set(model,setTimeout(()=>flush(host,model),450));
    }
    async function flush(host,model) {
      if(!current(host,model) || model.sending || model.invalid.size || unacknowledged(model) || !Object.keys(model.draft).length)return;
      const changes={...model.draft}; model.draft={}; model.sending=true; model.error='';
      const key=model.key;
      for(const [path,value] of Object.entries(changes))model.pending[path]={value,revision:null};
      status(host,model);
      try {
        const result=await fetchJSON(model.scope==='live'?`/api/operations/${encodeURIComponent(model.snapshot.operation_id)}/live-controls`:'/api/run-controls',model.scope==='live'?command(model,{changes}):{blueprint:model.snapshot.blueprint,context:model.snapshot.context,expected_revision:model.snapshot.profile_revision,changes});
        if(model.key!==key || !current(host,model))return;
        if(model.scope==='saved') {
          if(!result.settings)throw new Error('Saved settings were not returned; refresh before editing again.');
          refresh(model,{...model.snapshot,...result});
          for(const path of Object.keys(changes))delete model.pending[path];
        } else {
          const revision=result.control_revision ?? result.battle?.control_revision;
          for(const path of Object.keys(changes))model.pending[path].revision=revision;
          if(result.battle)refresh(model,{...model.snapshot,...result.battle});
          else if(numeric(revision))model.snapshot.control_revision=revision;
        }
      } catch(error) {
        model.error=error.message;
        for(const [path,value] of Object.entries(changes)) { delete model.pending[path]; if(!Object.hasOwn(model.draft,path))model.draft[path]=value; }
        onError(error);
      } finally {
        model.sending=false; status(host,model);
        if(current(host,model) && !model.error && Object.keys(model.draft).length)flush(host,model);
        for(const resolve of model.waiters || [])resolve();model.waiters=[];
      }
    }
    async function runAction(host,model,action) {
      if(model.sending || actionBusy(model) || unacknowledged(model) || Object.keys(model.draft).length || Object.keys(model.pending).length)return;
      model.sending=true; model.error=''; status(host,model);
      try {
        const result=await fetchJSON(`/api/operations/${encodeURIComponent(model.snapshot.operation_id)}/actions`,command(model,{action}));
        if(result.battle)refresh(model,{...model.snapshot,...result.battle});
        model.actionPending=['applied','rejected','failed','completed','expired'].includes(result.command?.state)?null:result.command?.id || result.command_id || action;
      } catch(error) {model.error=error.message;onError(error);}
      finally {model.sending=false;status(host,model);}
    }
    async function choose(blueprint) {
      selected=blueprint; const token=++epoch;
      if(!savedHost)return;
      try {
        if(saved)await settleSaved(saved);
        if(token!==epoch)return;
        savedHost.textContent='Loading saved controls…';
        const snapshot=await fetchJSON(`/api/run-controls?blueprint=${encodeURIComponent(blueprint)}`);
        if(token!==epoch || !savedHost)return;
        saved=makeModel('saved',snapshot);mount(savedHost,saved);
      } catch(error) {
        if(token!==epoch)return;
        if(saved){selected=saved.snapshot.blueprint;saved.error=error.message;status(savedHost,saved);}
        else savedHost.textContent=error.message;
        onError(error);
      }
    }
    async function settleSaved(model) {
      clearTimeout(timers.get(model));
      if(model.invalid.size)throw new Error('Finish the invalid saved control before opening another run.');
      if(model.sending){await new Promise(resolve=>(model.waiters ||= []).push(resolve));return settleSaved(model);}
      if(model.error)throw new Error(model.error);
      if(Object.keys(model.draft).length){if(!current(savedHost,model))throw new Error('Saved editor changed; reopen the run before editing.');await flush(savedHost,model);return settleSaved(model);}
      return true;
    }
    async function poll() {
      if(pollBusy || !liveHost?.isConnected)return;
      pollBusy=true;
      const target=liveHost, targetContext=context;
      try {
        const response=await fetchJSON('/api/battles/active');
        if(target!==liveHost || targetContext!==context)return;
        const battle=response.battle;
        if(!battle) {live=null;liveHost.textContent='No active battle. Saved controls are available in Runs.';return;}
        const snapshot={...battle,catalog:response.catalog ?? battle.catalog,capabilities:response.capabilities ?? battle.capabilities,constraints:response.constraints ?? battle.constraints};
        const awaitingAcknowledgement=live && unacknowledged(live);
        if(!live || identity(battle)!==live.key) {live=makeModel('live',snapshot);mount(liveHost,live);}
        else refresh(live,snapshot);
        live.observationUnavailable=false;
        if(live.error.startsWith('Live observation unavailable:'))live.error='';
        const commands=Array.isArray(snapshot.commands)?snapshot.commands:Object.values(snapshot.commands || {});
        const finished=commands.find(c=>(c.id===live.actionPending || c.action===live.actionPending) && ['applied','rejected','failed','completed','expired'].includes(c.state || c.status));
        if(live.actionPending && finished){live.actionPending=null;if(['rejected','failed','expired'].includes(finished.state || finished.status))live.error=finished.reason || finished.error || 'Action was rejected by the driver';}
        if(numeric(response.server_time))live.clockOffset=response.server_time-Date.now()/1000;
        status(liveHost,live);
        if(awaitingAcknowledgement && !unacknowledged(live) && !live.error)flush(liveHost,live);
      } catch(error) {
        if(target!==liveHost || targetContext!==context)return;
        if(live){live.observationUnavailable=true;live.error=`Live observation unavailable: ${error.message}`;status(liveHost,live);}
        else liveHost.textContent=`Live controls unavailable: ${error.message}`;
      } finally {pollBusy=false;}
    }
    async function history(instance='') {
      if(!historyHost)return;
      const token=++historyRequest;
      historyHost.textContent='Loading battle history…';
      try {
        const result=await fetchJSON(`/api/battles?instance=${encodeURIComponent(instance)}`);
        if(token!==historyRequest || !historyHost)return;
        historyHost.innerHTML=`<div class="rw-history-list">${(result.battles || []).map(b=>`<button class="ghost rw-history-row" data-battle="${esc(b.id)}"><strong>${esc(b.label || b.blueprint || b.id)}</strong><span>${esc(b.status ?? 'Unknown status')}</span><span>Tier ${esc(b.tier ?? 'unknown')} · wave ${esc(b.wave ?? b.final_wave ?? 'unknown')}</span><small>${esc(b.started_at ? new Date(b.started_at*1000).toLocaleString():'Start time unknown')}</small></button>`).join('') || '<p>No recorded battles.</p>'}</div><div class="rw-history-detail"></div>`;
        historyHost.onclick=event=> {const row=event.target.closest('[data-battle]');if(row)detail(row.dataset.battle);};
      } catch(error) {if(token===historyRequest)historyHost.textContent=error.message;}
    }
    async function detail(id) {
      historyKey=id;
      const target=historyHost?.querySelector('.rw-history-detail');if(!target)return;
      target.textContent='Loading battle…';
      try {
        const result=await fetchJSON(`/api/battles/${encodeURIComponent(id)}`);if(historyKey!==id)return;
        const battle=result.battle;
        target.innerHTML=`<article><header>${esc(battle.label || battle.blueprint || battle.id)}</header><p>${esc(battle.status ?? 'Unknown status')} · tier ${esc(battle.tier ?? 'unknown')}</p><p>Result: ${esc(battle.result ?? battle.outcome ?? 'unknown')} · end reason: ${esc(battle.end_reason ?? battle.reason ?? 'unknown')}</p>${historySummaryHTML(battle)}<details><summary>Configuration snapshot</summary><pre>${esc(JSON.stringify(battle.envelope ?? {status:'Configuration was not recorded'},null,2))}</pre></details><details open><summary>Recorded activity</summary><div class="rw-activity">${(result.events || []).map(e=>`<p><time>${esc(e.t ? new Date(e.t*1000).toLocaleTimeString():'Time unknown')}</time> ${esc(e.kind || e.action || 'Activity')}<small>${esc(e.reason || e.status || '')}</small></p>`).join('') || '<p>Activity was not recorded.</p>'}</div></details></article>`;
      } catch(error) {if(historyKey===id)target.textContent=error.message;}
    }
    return {
      attach(hosts) {
        const incoming=hosts.context || '';
        if(context!==incoming){
          if(saved)clearTimeout(timers.get(saved));
          saved=null;live=null;epoch++;historyRequest++;historyKey='';
        }
        context=incoming;
        liveHost=hosts.live;savedHost=hosts.saved;historyHost=hosts.history;
        if(live && liveHost)mount(liveHost,live);
        if(saved && savedHost)mount(savedHost,saved);
        poll();if(selected)choose(selected);
      },
      choose,poll,history,detail,
      async prepareEntry(){if(saved)await settleSaved(saved);return true;},
      tick(){if(live)clocks(liveHost,live);},
      selected:()=>selected,
      destroy(){if(clockTimer)clearInterval(clockTimer);for(const timer of timers.values())clearTimeout(timer);liveHost=null;savedHost=null;historyHost=null;epoch++;historyRequest++;}
    };
  }
  return {create,makeModel,refresh,effective,settings,fieldValue,countdown,durationHint,command,identity,renderHTML,allowed,editPlan,moveQueue,dropInQueue,conversionHTML,historySummaryHTML};
});
