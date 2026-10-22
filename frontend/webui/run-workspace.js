/* Shared saved/live run controls. Server snapshots, drafts and acknowledgements
   stay separate; polling never replaces an input the person is editing. */
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./duration-format.js') : root.TowerDuration);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunWorkspace = api;
})(typeof globalThis === 'object' ? globalThis : this, function(Duration) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const get = (value, path) => path.split('.').reduce((v,k) => v?.[k], value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const label = value => String(value).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const identity = battle => battle ? [battle.id, battle.operation_id, battle.generation].join(':') : '';
  const savedIdentity = snapshot => JSON.stringify([snapshot.blueprint,snapshot.context?.instance,snapshot.context?.account,snapshot.context?.profile]);
  const durationHint=Duration.format;
  const terminalCommand = command => ['applied','completed','failed','rejected','expired'].includes(command?.state || command?.status);
  const commandAction = command => command?.payload?.action || command?.action;
  /* Live command outcomes (frontend/dashboard.py api_battle_command,
     control/battles.py command, towerpilot_workflows/battles.py). In the backend
     this module was written against, the admission path raises its 400, 404 and
     409 before the command transaction commits, so a first attempt refused with
     one of them recorded nothing; another build or a proxy in between could
     answer differently, so this classification is only as good as that
     contract. A retried idempotency key replays its recorded command before the
     revision, capability and pending checks: a retried 400 comes from body
     validation and stays definite, but a 404 or 409 can come from driver or
     battle fencing that runs before replay, so a refused retry does not prove
     the first attempt was never recorded. The dashboard's request lock answers
     with 409 and code 'action_lock' before any handler runs: a first attempt
     refused by it recorded nothing (and is not resent), while a retry refused by
     it proves nothing about the first attempt, so that outcome stays unknown and
     Retry stays offered. Lost replies, read failures and every other status
     (including the 500 with code 'command_outcome_unknown' that a failed read-back
     after commit returns) leave the outcome unknown until a retry answers or a
     read lists the request's own key (settleRecorded). */
  const REFUSED_STATUSES=[400,404,409];
  function commandOutcome(error,retry) {
    if(!REFUSED_STATUSES.includes(error?.status))return 'unknown';
    if(retry && error.code==='action_lock')return 'unknown';
    return retry && error.status!==400?'retry_refused':'refused';
  }
  function commandRows(model) {
    const rows=model.snapshot.commands || [];
    const result=new Map((Array.isArray(rows)?rows:Object.values(rows)).map(row=>[row.id,row]));
    for(const row of Object.values(model.receipts || {})) {
      const observed=result.get(row.id);
      if(!observed || (!terminalCommand(observed) && (terminalCommand(row) || (row.updated_at || 0)>(observed.updated_at || 0))))result.set(row.id,row);
      else result.set(row.id,{...row,...observed});
    }
    return [...result.values()];
  }
  function resultText(action, evidence) {
    if(action?.startsWith('shopping')) {
      const sweep=evidence?.last_sweep || evidence;
      const reason=sweep?.reason || evidence?.outcome?.reason;
      return numeric(sweep?.confirmed_purchases)?`Verified purchases ${sweep.confirmed_purchases}${reason?` · ${label(reason)}`:''}`:reason?`${label(reason)}; purchase outcome unknown`:'Purchase outcome unknown';
    }
    if(evidence?.confirmed===true)return action==='floating_gems'?'Balance +2 confirmed':action==='ad_gems'?'Claim disappeared; balance total unknown':'Confirmation recorded';
    if(evidence?.confirmed===false)return `Unconfirmed${evidence.reason?`: ${label(evidence.reason)}`:''}`;
    return evidence?.reason?`${label(evidence.reason)}; reward unknown`:'Reward outcome unknown';
  }
  function commandRowText(row,target,action,now) {
    const state=row.state || row.status;
    const title={requested:'Accepted',pending:'Waiting',started:'Executing',running:'Executing',executing:'Executing',applied:'Applied',completed:'Finished',failed:'Failed',rejected:'Rejected',expired:'Expired'}[state] || label(state || 'Unknown');
    const at=row.updated_at ?? row.requested_at;
    const age=numeric(at)?` · ${Math.max(0,Math.floor(now-at))}s ago`:'';
    const reason=row.reason?` · ${label(row.reason)}`:'';
    const result=action && state==='completed'?` · ${resultText(target,row.evidence)}`:'';
    return title+age+reason+result;
  }
  /* A command row is evidence about one request only when the server lists that
     request's own idempotency key on it (request_keys, alias keys included) for
     the same battle, driver generation and operation. Rows without request_keys
     (an older server) and rows for other requests never match, however similar
     their payload or action: the outcome then stays unknown. */
  function requestRow(model,request) {
    const body=request?.body, key=body?.idempotency_key;
    if(typeof key!=='string' || !key)return null;
    return commandRows(model).find(row=>Array.isArray(row.request_keys) && row.request_keys.includes(key)
      && row.battle_id===body.battle_id && row.generation===body.generation && row.operation_id===request.operation) || null;
  }
  /* Feedback for one control or action. Each outcome belongs to the request that
     produced it: an unknown outcome names its own targets, a refusal stops
     describing a control the person has typed again since, and a refused retry
     reports a recorded command only when that row carries the retried request's
     own key. No other row is presented as a request's outcome. */
  function commandFeedback(model, target, action=false, now=Date.now()/1000) {
    const uncertain=model.uncertain;
    if(uncertain && (action?uncertain.action===target:Object.hasOwn(uncertain.changes || {},target)))return 'Acknowledgement unavailable · outcome unknown';
    const refusal=model.refusal;
    if(refusal && (action?refusal.action===target:Object.hasOwn(refusal.changes || {},target) && !Object.hasOwn(model.draft || {},target))) {
      const recorded=refusal.retried?requestRow(model,refusal):null;
      return recorded?`First attempt recorded · ${commandRowText(recorded,target,action,now)}`:refusal.feedback;
    }
    const rows=commandRows(model).filter(row=>action?commandAction(row)===target:row.kind==='controls' && Object.hasOwn(flatOverrides(row.payload),target));
    const row=rows.sort((a,b)=>(b.requested_at || b.updated_at || 0)-(a.requested_at || a.updated_at || 0)).at(0);
    return row?commandRowText(row,target,action,now):'';
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
  const REPORT_STALE_SEC=15;
  /* Two freshness questions, kept apart as the backend keeps them.
     Report freshness: is the driver still publishing? A status report (a record's
     observed_at, else its server_time) is fresh while it is at most 15 s old. It
     decides countdowns, Run now, control input and notices.
     Observation freshness: is a collector's own sighting recent? A collector that
     publishes stale_after_sec applies it to last_observed_at
     (interactions/ad_gems.py _expire_observation); only the observation text
     uses that limit. */
  function reportFresh(record, now=Date.now()/1000) {
    const at=record?.observed_at ?? record?.server_time;
    return numeric(at) && now-at<=REPORT_STALE_SEC;
  }
  function observationFresh(record, now=Date.now()/1000) {
    const limit=numeric(record?.stale_after_sec)?record.stale_after_sec:REPORT_STALE_SEC;
    return numeric(record?.last_observed_at) && now-record.last_observed_at<=limit;
  }
  function countdown(runtime, enabled, now = Date.now()/1000) {
    const manual=runtime?.manual_active || runtime?.manual_pending;
    if (enabled === false && !manual) return 'Off';
    if (!runtime) return 'Timing unknown';
    const state = runtime.state || runtime.status;
    if(runtime.blocker)return label(runtime.blocker);
    if (['blocked','paused','condition','waiting_condition','busy'].includes(state) || (state==='off' && !manual))
      return runtime.blocked_reason || runtime.condition || label(state);
    if (!reportFresh(runtime,now)) return 'Stale observation';
    if(runtime.manual_pending)return 'Manual request waiting';
    if(numeric(runtime.window_ends_at))return `${runtime.manual_active?'Manual window':'Window'} ${Math.max(0,Math.ceil(runtime.window_ends_at-now))}s`;
    if(runtime.manual_active)return 'Manual collection active';
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
    prunePending(model);
    return true;
  }
  /* Pending control values leave once the driver applied their revision, or
     with the reason once their command was rejected or expired. */
  function prunePending(model) {
    const applied = model.snapshot.applied_revision;
    for (const [path,item] of Object.entries(model.pending)) {
      if (numeric(applied) && numeric(item.revision) && applied >= item.revision) delete model.pending[path];
      const ended=commandRows(model).find(row=>row.kind==='controls' && row.revision===item.revision && ['rejected','expired'].includes(row.state));
      if(ended){delete model.pending[path];model.error=ended.reason || `Controls ${ended.state}`;}
    }
  }
  /* A read listing this request's own key settles its unknown outcome: the
     request was recorded, so it proceeds as an acknowledged command and its
     frozen retry body is released. Without that exact row it stays unknown. */
  function settleRecorded(model) {
    const uncertain=model.uncertain;
    if(!uncertain || model.sending)return false;
    const row=requestRow(model,uncertain);
    if(!row)return false;
    model.uncertain=null;
    if(uncertain.kind==='controls') {
      for(const path of Object.keys(uncertain.changes || {}))if(model.pending[path])model.pending[path].revision=row.revision;
      prunePending(model);
    } else if(terminalCommand(row)) {
      model.actionPending=null;
      if(['rejected','failed','expired'].includes(row.state || row.status))model.error=row.reason || row.error || 'Action was rejected by the driver';
    } else model.actionPending=row.id;
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
  /* The hint under a control: pending while a draft or request owns it,
     otherwise the frozen default and whether this battle overrides it. Used at
     render time and on every status pass so a later override keeps its marker. */
  function hintState(model,path) {
    if(Object.hasOwn(model.draft,path) || model.pending[path])return 'pending';
    return model.scope==='live' && Object.hasOwn(flatOverrides(model.snapshot.overrides),path)?'override':'default';
  }
  function hintText(model,path,options={}) {
    if(Object.hasOwn(model.draft,path) || model.pending[path])return 'Pending';
    if(model.scope!=='live')return options.inherit?'Blank inherits':'';
    const base=get(model.snapshot.envelope?.controls,path);
    return `Default ${base ?? 'unknown'}${Object.hasOwn(flatOverrides(model.snapshot.overrides),path)?' · override':''}`;
  }
  function inputHTML(model,path,title,options={}) {
    const value = fieldValue(model,path);
    const support = allowed(model,path);
    const constraint = model.snapshot.constraints?.[path] || {};
    const attrs = `data-control="${esc(path)}" ${support?'':'disabled'} title="${esc(support?title:'Unavailable in this driver')}"`;
    const control = options.boolean
      ? `<input type="checkbox" ${attrs} ${value===true?'checked':''}>`
      : `<input type="number" ${attrs} value="${esc(value)}" ${constraint.min!==undefined?`min="${esc(constraint.min)}"`:''} ${constraint.max!==undefined?`max="${esc(constraint.max)}"`:''} step="${esc(constraint.step ?? 'any')}" ${options.inherit?'placeholder="Inherit"':''}>`;
    const duration=!options.boolean && path.endsWith('_sec')?durationHint(value):'';
    const hint=!options.boolean && path.endsWith('_sec')?`<small class="rw-duration-hint" data-duration="${esc(path)}" ${duration?'':'hidden'}>${esc(duration)}</small>`:'';
    return `<label class="rw-field ${options.boolean?'rw-toggle':''}${options.className?` ${esc(options.className)}`:''}"><span>${esc(title)}</span>${control}${hint}<small data-pending="${esc(path)}"${options.markState?` data-pending-state="${hintState(model,path)}"`:''}>${esc(hintText(model,path,options))}</small>${model.scope==='live'?`<small class="rw-command" data-command-control="${esc(path)}"></small>`:''}</label>`;
  }
  function actionHTML(model,action,title='Run now',options={}) {
    return model.scope !== 'live' ? '' : `<span class="rw-action"><button type="button" class="small ghost" data-action="${esc(action)}" aria-label="${esc(title==='▶'?`Try once: ${label(action.split(':').at(-1))}`:title+': '+label(action.split(':').at(-1)))}" ${allowed(model,action,true)&&!model.sending?'':'disabled'}>${esc(title)}</button><small class="rw-command" data-command-action="${esc(action)}"${options.commandOnly?' data-command-only':''}></small></span>`;
  }
  function inspectLink(battle, runtime={}) {
    const query=new URLSearchParams();
    for(const [key,value] of Object.entries({battle_id:battle.id,operation_id:battle.operation_id,
      offer_id:runtime.offer_id,
      since:numeric(runtime.first_seen_at)?Math.max(0,runtime.first_seen_at-60):undefined})) {
      if(value!==undefined && value!==null && value!=='')query.set(key,value);
    }
    return '#runtime?'+query.toString();
  }
  function observationValues(runtime, now=Date.now()/1000, unavailable=false) {
    const r=runtime || {}, age=value=>numeric(value)?`${Math.max(0,Math.floor(now-value))}s ago`:'unknown';
    const local=value=>numeric(value)?new Date(value*1000).toLocaleString():'unknown';
    const due=value=>numeric(value)?value>now?`in ${Math.ceil(value-now)}s`:'due; awaiting driver':'unknown';
    const fresh=observationFresh(r,now);
    const visible=!unavailable && fresh && r.visibility==='visible';
    const visibility=visible?'Visible on last battle frame':!unavailable && fresh && r.visibility==='absent'?
      'Absent on last battle frame':`Unknown${unavailable?' (live status unavailable)':!fresh && numeric(r.last_observed_at)?' (stale observation)':r.visibility_reason?` (${label(r.visibility_reason)})`:''}`;
    const first=numeric(r.first_seen_at)?`${local(r.first_seen_at)} (${age(r.first_seen_at)})`:'Not observed';
    const appearance=numeric(r.appearance_after_at) && numeric(r.first_seen_at)?
      `After ${local(r.appearance_after_at)}, by ${local(r.first_seen_at)} (${Math.max(0,r.first_seen_at-r.appearance_after_at).toFixed(1)}s observation interval)`:
      'Appearance time unknown; first observation is not spawn time';
    let timing;
    if(numeric(r.window_ends_at)) {
      timing=numeric(r.response_due_at)?`Response ${due(r.response_due_at)}; window closes ${due(r.window_ends_at)}`:
        `Collection window closes ${due(r.window_ends_at)}`;
    } else timing=`Scheduled window ${due(r.next_due_at)}`;
    if(r.enabled===false && !r.manual_active && !r.manual_pending)timing='Collection off';
    if(unavailable)timing='Last reported: '+timing;
    const failed=r.last_failed_attempt;
    const counts=r.counters || {}, count=key=>numeric(counts[key])?counts[key]:'?';
    const durations=r.durations || {}, seconds=key=>numeric(durations[key])?`${durations[key]}s`:'unknown';
    return {visibility,first_seen:first,appearance,
      freshness:numeric(r.last_observed_at)?`Last battle observation ${age(r.last_observed_at)}${fresh && !unavailable?'':' (stale or unavailable)'}`:'No battle observation',
      timing,next_check:`Passive check ${due(r.next_check_at)}`,
      failure:failed?`${label(failed.reason || failed.outcome || 'Unknown failure')} · ${local(failed.observed_at)} (${age(failed.observed_at)})`:'No failed attempt recorded in this collector',
      counters:`Attempts ${count('attempts')} · confirmed ${count('confirmed')} · skips ${count('skips')} · missed windows ${count('windows_missed')}`,
      durations:`Last timing: schedule wait ${seconds('scheduling_wait_sec')} · response delay ${seconds('response_delay_sec')} · verification ${seconds('verification_sec')}`};
  }
  function observationHTML(model,name) {
    if(model.scope!=='live')return '';
    const fields=name==='ad_gems'?`<dl class="rw-observation" data-observation="ad_gems">${[
      ['visibility','Offer'],['first_seen','First observed'],['appearance','Appearance bounds'],
      ['freshness','Freshness'],['timing','Collection'],['next_check','Observation'],
      ['failure','Latest failed attempt'],['counters','Counts'],['durations','Timing evidence']
    ].map(([key,title])=>`<div><dt>${title}</dt><dd data-observation-field="${key}">Unknown</dd></div>`).join('')}</dl>`:name==='floating_gems'?'<p class="rw-command" data-orbit-refusal>No refusal recorded</p>':'';
    return `${fields}<details class="rw-observation-details"><summary>Observation details</summary><a class="rw-inspect" data-inspect="${esc(name)}" href="${esc(inspectLink(model.snapshot))}">Inspect events</a><pre data-runtime-raw="${esc(name)}">Observation unavailable</pre></details>`;
  }
  function routinesHTML(model) {
    return `<div class="rw-routines">${Object.entries(settings(model).routines || {}).map(([name,values]) =>
      `<section class="rw-routine" data-routine="${esc(name)}"><div class="rw-routine-title"><strong>${esc(label(name))}</strong><span data-countdown="${esc(name)}" class="rw-clock"></span>${actionHTML(model,name)}</div><div class="rw-fields">${inputHTML(model,`routines.${name}.enabled`,'On',{boolean:true})}${Object.entries(routineFields[name]||{}).filter(([key])=>Object.hasOwn(values,key)).map(([key,title])=>inputHTML(model,`routines.${name}.${key}`,`${title} (s)`)).join('')}</div>${observationHTML(model,name)}</section>`).join('')}</div>`;
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
    return `<div class="rw-queue-layout"><section class="rw-global-queue"><header><strong>Global priority queue</strong></header><div class="rw-fields">${number('cash_reserve',plan.cash_reserve,'Keep cash ($)')}<label class="rw-field"><span>Purchase pattern</span><select data-shop="queue_mode" ${supported?'':'disabled'}><option value="round_robin" ${plan.queue_mode==='round_robin'?'selected':''}>Round robin</option><option value="highest_affordable" ${plan.queue_mode==='highest_affordable'?'selected':''}>Single focus (affordable)</option><option value="weighted_split" ${plan.queue_mode==='weighted_split'?'selected':''}>Weighted split</option></select></label></div><label class="rw-field rw-cadence"><span>Shopping cadence</span><select data-shop="cadence" ${supported?'':'disabled'}><option value="single_attempt" ${(plan.cadence || 'single_attempt')==='single_attempt'?'selected':''}>Single attempt</option><option value="while_affordable" ${plan.cadence==='while_affordable'?'selected':''}>While affordable</option></select></label><p class="muted rw-plan-note">While affordable uses fresh price and balance evidence after each confirmed purchase, yielding between actions. Each continuation window allows at most 4 purchases or 20 seconds; refusals and unknown results wait for the normal interval.</p><p class="muted rw-plan-note">Single focus selects the highest priority affordable upgrade. Round robin rotates through eligible upgrades. Weighted split uses each upgrade's per-turn amount. Purchases wait when reserve, quantity or available cash cannot be verified.</p><ol class="rw-queue" data-queue>${queueHTML(model)}</ol></section>${selectors}</div>`;
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
  function setupEvidenceHTML(setup) {
    const state=value=>['verified','degraded'].includes(value)?value:'unknown';
    const details={manual_equipment:'Manual equipment',global_preset_selection:'Global preset selection only; contents not inspected',as_is:'Equipment left as is; not verified',adopted:'Adopted battle; setup not verified',setup_refused:'Setup refused',equipped_header:'Equipped slot confirmed',not_in_expected_slot:'Not in expected slot',not_verified:'Not verified'};
    const detail=value=>Object.hasOwn(details,value)?details[value]:label(value);
    const outcome=state(setup?.state);
    const modules=Array.isArray(setup?.modules)?setup.modules:[];
    return `<div class="rw-setup-summary"><span>Setup <strong class="rw-setup-${outcome}">${label(outcome)}</strong></span>${setup?.loadout?`<span>Loadout: ${esc(setup.loadout)}</span>`:''}<span>${esc(setup?.detail?detail(setup.detail):'No setup evidence recorded')}</span>${setup?.continued_with_partial===true?'<strong class="rw-setup-degraded">Continued with partial setup</strong>':''}</div>${setup?.reason?`<p class="rw-setup-reason">${esc(setup.reason)}</p>`:''}${modules.length?`<details class="rw-setup-modules"><summary>Module evidence (${modules.length})</summary><ul>${modules.map(item=>`<li><strong>${esc(item.module)}</strong> (${esc(item.role==='category'?'Category slot':label(item.role || 'Role unknown'))}) · ${label(state(item.state))}${item.detail?` · ${esc(detail(item.detail))}`:''}${item.reason?` · ${esc(item.reason)}`:''}</li>`).join('')}</ul></details>`:''}`;
  }
  function historyActivityText(event) {
    if(typeof event.reason==='string' && event.reason)return event.reason;
    const status=event.status;
    if(typeof status==='string')return status;
    if(!status || typeof status!=='object' || Array.isArray(status))return '';
    const parts=[];
    if(typeof status.observation_status==='string' && status.observation_status)parts.push(label(status.observation_status));
    if(numeric(status.observed_wave))parts.push(`Wave ${status.observed_wave}`);
    return parts.join(' · ');
  }
  function historySummaryHTML(battle) {
    const runtime=battle.runtime || {};
    const capture=runtime.stats_capture || battle.stats_capture;
    const duration=runtime.observed_duration_sec;
    const elapsed=numeric(duration)?`${Math.floor(duration/60)}m ${Math.floor(duration%60)}s observed`:'Unknown';
    const wave=battle.final_wave ?? battle.boundary_evidence?.last_observed_wave ?? runtime.observed_wave;
    const captureState=capture?.status?label(capture.status):'Unknown';
    const evidence=runtime.collection_evidence;
    const count=value=>Number.isInteger(value) && value>=0;
    const recorded=evidence?.coverage==='sampled_driver_observations' && evidence.generation===battle.generation
      && numeric(battle.created_at) && numeric(evidence.started_at) && evidence.started_at>=battle.created_at
      && count(evidence.ad_claim_confirmations) && count(evidence.orbit_balance_confirmations)
      && evidence.orbit_recorded_increase===2*evidence.orbit_balance_confirmations;
    const gems=recorded?`Ad claims ${evidence.ad_claim_confirmations} · Orbit +2 confirmations ${evidence.orbit_balance_confirmations} (recorded increase +${evidence.orbit_recorded_increase})`:'Not recorded';
    return `<section class="rw-setup" aria-label="Setup evidence">${setupEvidenceHTML(runtime.setup)}</section><div class="rw-history-summary"><span>Last observed wave <strong>${esc(wave ?? 'unknown')}</strong></span><span>Observed duration <strong>${esc(elapsed)}</strong></span><span>Stats capture <strong>${esc(captureState)}</strong>${capture?.verified===true?' · verified':capture?.verified===false?' · unverified':''}</span><span>Recorded collection evidence <strong>${esc(gems)}</strong><small>${recorded?'Sampled driver observations; gaps may exist. Ad disappearance confirms a claim, not its balance increase.':'No confirmation coverage recorded.'} Gem total unknown.</small></span></div>${capture?.reason || capture?.error?`<p class="muted rw-plan-note">${esc(capture.reason || capture.error)}</p>`:''}`;
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
  function renderHTML(model,options={}) {
    if(model.scope==='live' && options.variant==='dashboard')return dashboardHTML(model,options);
    return `<div class="rw-workspace" data-scope="${model.scope}"><div class="rw-toolbar"><div><strong>${model.scope==='live'?'Current battle':'Saved run controls'}</strong><small>${model.scope==='live'?'Applies to this battle · frozen defaults are retained':'Autosaved for future battles'}</small></div>${model.scope==='live'?'<button class="small ghost" data-reset>Reset live overrides</button><button class="small ghost" data-retry-command hidden>Retry acknowledgement</button>':''}<span role="status" class="rw-status"></span></div>${model.scope==='live'?`<section class="rw-setup" data-setup aria-label="Setup evidence">${setupEvidenceHTML(model.snapshot.runtime?.setup)}</section>`:''}${model.snapshot.notice?`<p class="muted rw-plan-note">${esc(model.snapshot.notice)}</p>`:''}${routinesHTML(model)}<section class="rw-shopping"><header><strong>Workshop</strong><small class="rw-command" data-command-control="shopping_plan"></small></header><p data-shopping-warning class="warn" hidden></p>${shoppingHTML(model)}</section></div>`;
  }
  const PRIMARY_ROUTINES=['ad_gems','floating_gems','shopping'];
  const OTHER_ROUTINES=['rewards','abilities','rescue','repeat'];
  /* Every driver grants these two actions when it activates a battle
     (runtime/battle_session.py capabilities); shopping actions need a shop with
     a queue plan, so a prepared battle cannot promise them yet. */
  const PREPARED_ROUTINES=['ad_gems','floating_gems'];
  const QUEUE_MODES={highest_affordable:'Single focus (affordable)',round_robin:'Round robin',weighted_split:'Weighted split'};
  const CADENCES={single_attempt:'Single attempt',while_affordable:'While affordable'};
  const COMPACT_CLOCK={'Status unavailable':'Unavailable','Stale observation':'Stale','Waiting for battle':'Waiting','Waiting for first report':'No report yet'};
  const IDLE_REASONS={none:'Needs a tracked battle',unavailable:'Battle status unavailable',loading:'Checking for a tracked battle'};
  const FRESHNESS_REASONS={unavailable:'Live status unavailable',unknown:'Waiting for the driver\'s first report',stale:'Battle observation is stale'};
  const money=value=>numeric(value)?`$${new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(value)}`:'';
  const ago=seconds=>{const value=Math.max(0,Math.floor(seconds));return value>60?`${durationHint(value)} ago`:`${value}s ago`;};
  const upgradeLabel=(catalog,id)=>(Array.isArray(catalog)?catalog:catalog?.upgrades || []).find(entry=>entry.id===id)?.label || label(id);
  const every=values=>numeric(values?.interval_sec)?`Every ${durationHint(values.interval_sec) || `${values.interval_sec}s`}`:'Interval unknown';
  /* The routine a control path, action or countdown belongs to. */
  const routineOf=target=>{const text=String(target);return text==='shopping_plan'?'shopping':text.startsWith('routines.')?text.split('.')[1]:text.split(':')[0];};
  /* Live models wait on the driver while their last requested control revision
     is unapplied (and not ended) or a command is still executing. */
  function unacknowledged(model) {
    return model.scope==='live' && numeric(model.snapshot.control_revision) && (!numeric(model.snapshot.applied_revision) || model.snapshot.applied_revision<model.snapshot.control_revision)
      && !commandRows(model).some(row=>row.kind==='controls' && row.revision===model.snapshot.control_revision && ['rejected','expired'].includes(row.state));
  }
  function actionBusy(model) {
    return !!model.actionPending || !!model.uncertain || commandRows(model).some(c=>['requested','pending','started','running','executing'].includes(c.state || c.status));
  }
  /* A refused retry cannot say by itself whether the first attempt was recorded;
     only that attempt's own command row can (requestRow). */
  function refusalHeadline(model) {
    const refusal=model.refusal;
    if(!refusal)return '';
    if(refusal.retried && requestRow(model,refusal))return '';
    return refusal.message;
  }
  /* Driver reporting for a live model: 'unavailable' when the battle read failed,
     'unknown' before the driver has published a report for this battle, 'stale'
     when its last report is older than the report limit, else 'fresh'. Given a
     routine, that routine's own report must be fresh too, so its clock, controls
     and Run now always agree. */
  function liveFreshness(model, now=Date.now()/1000+(model.clockOffset || 0), routine) {
    if(model.scope!=='live')return 'fresh';
    if(model.observationUnavailable)return 'unavailable';
    const runtime=model.snapshot.runtime;
    if(!numeric(runtime?.server_time))return 'unknown';
    if(!reportFresh({server_time:runtime.server_time},now))return 'stale';
    const record=routine?runtime.routines?.[routine]:null;
    return record && !reportFresh(record,now)?'stale':'fresh';
  }
  const holdsInput=freshness=>freshness==='stale' || freshness==='unknown';
  /* A routine is the driver's when its capabilities name one of its controls or
     its action; a prepared battle has none yet. */
  function supportedRoutine(model,name) {
    const caps=model.snapshot.capabilities || {};
    return (Array.isArray(caps.controls) && caps.controls.some(path=>path.startsWith(`routines.${name}.`))) || (Array.isArray(caps.actions) && caps.actions.includes(name));
  }
  /* Whether a manual action may be sent now, and the reason shown when not. */
  function actionState(model, action, now=Date.now()/1000+(model.clockOffset || 0)) {
    const deny=reason=>({enabled:false,reason});
    if(model.scope!=='live')return deny(IDLE_REASONS.none);
    const status=model.snapshot.status;
    if(status==='prepared')return deny('Waiting to observe the battle');
    if(!['active','running'].includes(status))return deny('Battle is not active');
    if(!allowed(model,action,true))return deny('Not supported by this driver');
    const freshness=liveFreshness(model,now,routineOf(action));
    if(freshness!=='fresh')return deny(FRESHNESS_REASONS[freshness]);
    if(model.sending)return deny('Waiting for a command reply');
    if(model.uncertain)return deny('Previous command outcome unknown; use Retry');
    if(model.awaitRead!==undefined)return deny('Waiting for a fresh battle read');
    if(model.invalid.size)return deny('Fix the invalid value first');
    if(Object.keys(model.draft).length || Object.keys(model.pending).length)return deny('Waiting for control changes');
    if(unacknowledged(model))return deny('Waiting for the driver to apply changes');
    if(actionBusy(model))return deny('Another action is running');
    return {enabled:true,reason:''};
  }
  /* A disabled Run now that shows where the action lives without any click
     path: no data-action, so no handler can send, launch or adopt. */
  function placeholderAction(name,reason) {
    return `<span class="rw-action"><button type="button" class="small ghost" data-idle-action="${esc(name)}" disabled aria-label="${esc(`Run now: ${label(name)} (unavailable)`)}">Run now</button></span><small class="rw-action-reason">${esc(reason)}</small>`;
  }
  function tapLimit(value) {
    if(!numeric(value))return 'no tap cap';
    return value===1?'1 tap':`${value} taps`;
  }
  /* The queue summary: the first three priorities, and every enabled entry in
     order behind a disclosure whose open state the caller keeps per scope. */
  function planSummaryHTML(plan,catalog,options={}) {
    if(!plan)return '<p class="rw-summary-plan muted">No queue plan is configured; the existing shopping policy is used.</p>';
    if(plan.version!==2 || !Array.isArray(plan.queue))return '<p class="rw-summary-plan muted">Legacy shopping policy; review it in the editor.</p>';
    const entries=plan.queue.filter(item=>item.enabled && !(plan.excluded_upgrades || []).includes(item.id));
    const reserve=money(plan.cash_reserve), cadence=plan.cadence || 'single_attempt';
    const weighted=plan.queue_mode==='weighted_split';
    const full=entries.length>3?`<details class="rw-summary-queue-all" data-queue-all ${options.open?'open':''}><summary class="rw-summary-more">All ${entries.length} priorities</summary><ol class="rw-summary-queue-full">${entries.map(item=>`<li><span class="rw-queue-name">${esc(upgradeLabel(catalog,item.id))}</span> <small class="rw-queue-limit">${esc(tapLimit(item.tap_limit))}${weighted?` · ${esc(item.weight ?? 1)}/turn`:''}</small></li>`).join('')}</ol></details>`:'';
    const queue=entries.length?`<ol class="rw-summary-queue">${entries.slice(0,3).map(item=>`<li>${esc(upgradeLabel(catalog,item.id))}</li>`).join('')}</ol>${full}`
      :'<p class="rw-summary-queue muted">No upgrades selected</p>';
    return `<p class="rw-summary-plan"><span class="rw-summary-mode">${esc(QUEUE_MODES[plan.queue_mode] || label(plan.queue_mode || 'unknown'))}</span><span class="rw-summary-cadence">${esc(CADENCES[cadence] || label(cadence))}</span><span class="rw-summary-reserve">${reserve?`Keep ${esc(reserve)}`:'No reserve set'}</span></p>${queue}`;
  }
  /* The shopper publishes its last decision and confirmation, not a time for
     them: the age shown is that of the status report that carried them. Cash,
     prices and affordability are never shown or inferred here. */
  function decisionHTML(outcome,catalog) {
    const decision=outcome?.decision && typeof outcome.decision==='object'?outcome.decision:null;
    const parts=decision?[label(decision.action || 'unknown'),decision.reason?label(decision.reason):'',decision.upgrade?upgradeLabel(catalog,decision.upgrade):''].filter(Boolean):[];
    const pending=outcome?.pending_confirmation, last=outcome?.last_confirmation;
    const confirmation=pending?.upgrade?`Awaiting confirmation: ${upgradeLabel(catalog,pending.upgrade)}`
      :last?.upgrade?`Last confirmation: ${upgradeLabel(catalog,last.upgrade)} · ${label(last.outcome || 'unknown')}${last.reason?` (${label(last.reason)})`:''}`:'No purchase confirmation recorded';
    return `<p class="rw-summary-decision">${parts.length?`Last decision: ${esc(parts.join(' · '))}`:'No shopping decision reported'} <span class="rw-summary-age" data-shopping-age></span></p><p class="rw-summary-confirmation">${esc(confirmation)}</p>`;
  }
  function shoppingSummaryHTML(model,options={}) {
    const pending=Object.hasOwn(model.draft,'shopping_plan') || !!model.pending.shopping_plan;
    const marker=pending?'Pending':Object.hasOwn(flatOverrides(model.snapshot.overrides),'shopping_plan')?'Override for this battle':'';
    return `<header><strong>Shopping priority</strong><small class="rw-summary-scope">This battle</small>${marker?`<small class="rw-summary-marker">${marker}</small>`:''}</header>${planSummaryHTML(fieldValue(model,'shopping_plan'),model.snapshot.catalog,options)}${decisionHTML(model.snapshot.runtime?.routines?.shopping?.last_outcome,model.snapshot.catalog)}<p data-shopping-warning class="warn" hidden></p>`;
  }
  function otherRoutinesText(model) {
    const routines=settings(model).routines || {};
    return OTHER_ROUTINES.filter(name=>Object.hasOwn(routines,name) && supportedRoutine(model,name))
      .map(name=>`${label(name)} ${fieldValue(model,`routines.${name}.enabled`)===true?'on':'off'}`).join(' · ');
  }
  function outcomeText(name,runtime,now) {
    const outcome=runtime?.last_outcome;
    if(!outcome || (name==='shopping' && !outcome.last_sweep))return 'No result recorded';
    const at=name==='shopping'?undefined:outcome.observed_at;
    return `Last result: ${resultText(name,outcome)}${numeric(at)?` · ${ago(now-at)}`:''}`;
  }
  function dashboardNotice(model,now,freshness) {
    const s=model.snapshot;
    if(s.status==='prepared')return `Waiting to observe the battle${s.origin?` (${label(s.origin)})`:''}. Routines start when the driver sees a wave.`;
    if(!['active','running'].includes(s.status))return `Battle ${label(s.status || 'unknown')}.`;
    if(freshness==='unknown')return 'Waiting for the driver\'s first report for this battle. Run now and changes are held until it arrives.';
    if(freshness==='stale')return `Battle observation is stale (last report ${ago(now-s.runtime.server_time)}). Controls are paused until the driver reports again.`;
    const unsupported=PRIMARY_ROUTINES.filter(name=>Object.hasOwn(settings(model).routines || {},name) && !supportedRoutine(model,name));
    return unsupported.length?`This driver does not run ${unsupported.map(name=>label(name)).join(' or ')}.`:'';
  }
  /* The full editor for the Dashboard disclosure: only routines this driver
     runs, without the toggles, intervals, clocks and Run now buttons the
     summary rows already own, so every control and action appears once. It is
     the detailed editor until live editing moves to Runs. */
  function advancedRoutinesHTML(model) {
    const prepared=model.snapshot.status==='prepared';
    return `<div class="rw-routines">${Object.entries(settings(model).routines || {}).filter(([name])=>!prepared && supportedRoutine(model,name)).map(([name,values])=> {
      const primary=PRIMARY_ROUTINES.includes(name);
      const fields=Object.entries(routineFields[name] || {}).filter(([key])=>Object.hasOwn(values,key) && !(primary && key==='interval_sec'));
      return `<section class="rw-routine" data-routine="${esc(name)}"><div class="rw-routine-title"><strong>${esc(label(name))}</strong></div><div class="rw-fields">${primary?'':inputHTML(model,`routines.${name}.enabled`,'On',{boolean:true})}${fields.map(([key,title])=>inputHTML(model,`routines.${name}.${key}`,`${title} (s)`)).join('')}</div>${observationHTML(model,name)}</section>`;
    }).join('')}</div>`;
  }
  /* Current battle. A prepared battle shows only the routines every driver will
     run, read-only from its frozen settings, with no clock, input or action. */
  function dashboardHTML(model,options={}) {
    const routines=settings(model).routines || {};
    const prepared=model.snapshot.status==='prepared';
    const row=name=>`<section class="rw-summary-routine" data-routine="${esc(name)}"><strong class="rw-summary-name">${esc(label(name))}</strong>${inputHTML(model,`routines.${name}.enabled`,'On',{boolean:true,className:'rw-summary-toggle',markState:true})}${Object.hasOwn(routines[name] || {},'interval_sec')?inputHTML(model,`routines.${name}.interval_sec`,'Every (s)',{className:'rw-summary-interval',markState:true}):''}<span class="rw-clock rw-summary-clock" data-countdown="${esc(name)}" data-clock-compact></span><small class="rw-summary-outcome" data-routine-outcome="${esc(name)}"></small>${actionHTML(model,name,'Run now',{commandOnly:true})}<small class="rw-action-reason" data-action-reason="${esc(name)}" hidden></small></section>`;
    const preparedRow=name=> {
      const on=routines[name]?.enabled===true;
      return `<section class="rw-summary-routine" data-routine="${esc(name)}"><strong class="rw-summary-name">${esc(label(name))}</strong><span class="rw-summary-state" data-state="${on?'on':'off'}">${on?'On once observed':'Off'}</span><span class="rw-summary-interval">${esc(every(routines[name]))}</span>${placeholderAction(name,'Waiting to observe the battle')}</section>`;
    };
    const rows=prepared?PREPARED_ROUTINES.filter(name=>Object.hasOwn(routines,name)).map(preparedRow).join('')
      :PRIMARY_ROUTINES.filter(name=>Object.hasOwn(routines,name) && supportedRoutine(model,name)).map(row).join('');
    const other=prepared?'':otherRoutinesText(model);
    const shops=!prepared && supportedRoutine(model,'shopping');
    const shopping=shops?`<section class="rw-summary-shopping" data-shopping-summary aria-label="Shopping priority for this battle">${shoppingSummaryHTML(model,{open:options.queueOpen})}</section>`:'';
    const workshop=shops?`<section class="rw-shopping"><header><strong>Workshop</strong><small class="rw-command" data-command-control="shopping_plan"></small></header>${shoppingHTML(model)}</section>`:'';
    return `<div class="rw-workspace rw-dashboard" data-scope="live" data-variant="dashboard" data-battle-status="${esc(model.snapshot.status)}"><div class="rw-toolbar"><div class="rw-dashboard-title"><strong>Current battle</strong><small>Edits apply to this battle only; saved run settings are unchanged</small></div><button type="button" class="small ghost" data-retry-command hidden>Retry acknowledgement</button><span role="status" class="rw-status" tabindex="-1"></span></div><p class="rw-dashboard-notice" data-dashboard-notice hidden></p><div class="rw-summary-routines">${rows}${other?`<p class="rw-summary-other" data-other-routines>${esc(other)}</p>`:''}</div>${shopping}<details class="rw-advanced" data-advanced ${options.advancedOpen?'open':''}><summary>All battle controls</summary><div class="rw-advanced-toolbar"><button type="button" class="small ghost" data-reset>Reset live overrides</button></div><section class="rw-setup" data-setup aria-label="Setup evidence">${setupEvidenceHTML(model.snapshot.runtime?.setup)}</section>${model.snapshot.notice?`<p class="muted rw-plan-note">${esc(model.snapshot.notice)}</p>`:''}${advancedRoutinesHTML(model)}${workshop}</details></div>`;
  }
  /* The saved template of the run the Start picker would launch: planned
     settings only. No clock, input, result or action; each Run now is a
     disabled placeholder stating why it cannot act. */
  function savedSummaryHTML(snapshot,options={}) {
    const settings=snapshot?.settings || {}, routines=settings.routines || {};
    const controls=snapshot?.capabilities?.controls;
    const supported=name=>Object.hasOwn(routines,name) && (!Array.isArray(controls) || controls.some(path=>path.startsWith(`routines.${name}.`)));
    const reason=IDLE_REASONS[options.battle] || IDLE_REASONS.loading;
    const queuePlan=settings.shopping_plan?.version===2 && Array.isArray(settings.shopping_plan.queue);
    const rows=PRIMARY_ROUTINES.filter(name=>supported(name)).map(name=> {
      const on=routines[name]?.enabled===true;
      const why=name==='shopping' && !queuePlan?'Needs a shopping queue plan':reason;
      return `<section class="rw-summary-routine" data-routine="${esc(name)}"><strong class="rw-summary-name">${esc(label(name))}</strong><span class="rw-summary-state" data-state="${on?'on':'off'}">${on?'On at next start':'Off at next start'}</span><span class="rw-summary-interval">${esc(every(routines[name]))}</span>${placeholderAction(name,why)}</section>`;
    }).join('');
    const others=OTHER_ROUTINES.filter(name=>supported(name)).map(name=>`${label(name)} ${routines[name]?.enabled===true?'on':'off'}`).join(' · ');
    const scope=`Saved template · ${options.label || 'this run'}`;
    const shopping=supported('shopping')?`<section class="rw-summary-shopping" aria-label="${esc(`Shopping priority, ${scope}`)}"><header><strong>Shopping priority</strong><small class="rw-summary-scope">${esc(scope)}</small></header>${planSummaryHTML(settings.shopping_plan,snapshot.catalog,{open:options.queueOpen})}</section>`:'';
    return `<div class="rw-summary-routines">${rows}${others?`<p class="rw-summary-other">${esc(`At next start: ${others}`)}</p>`:''}</div>${shopping}${snapshot?.notice?`<p class="muted rw-plan-note">${esc(snapshot.notice)}</p>`:''}`;
  }
  /* The Dashboard's live host while no battle is tracked. state.battle is
     'loading' | 'none' | 'unavailable'; state.preview is the Start picker run's
     preview ({name,label,status:'empty'|'loading'|'ready'|'error',snapshot,error,message});
     state.queueOpen keeps the full queue disclosure open. */
  function previewHTML(state={}) {
    const battle=['none','unavailable'].includes(state.battle)?state.battle:'loading';
    const preview=state.preview || null;
    const status=['loading','ready','error'].includes(preview?.status)?preview.status:'empty';
    const run=preview?.label || '';
    const title=run?`Next start · ${run}`:'Next start';
    const scope=status==='empty'?'':'<small>Saved settings, planned for the next start — not what is running now</small>';
    const battleText=battle==='none'?'No tracked battle':battle==='unavailable'?`Battle status unavailable: ${state.error || 'unknown error'}`:'Checking for a tracked battle…';
    const name=esc(run || 'this run');
    const body=status==='ready'?savedSummaryHTML(preview.snapshot,{battle,label:run,queueOpen:state.queueOpen})
      :status==='loading'?`<p class="rw-preview-message">Loading saved settings for ${name}…</p>`
      :status==='error'?`<p class="rw-preview-message warn">Saved settings for ${name} unavailable: ${esc(preview.error || 'unknown error')}</p>`
      :`<p class="rw-preview-message">${esc(preview?.message || 'Select a run to see its saved settings.')}</p>`;
    const link=status==='empty'?'':`<a class="rw-edit-link" data-run="${esc(preview?.name || '')}" href="#runs">Edit in Runs</a>`;
    return `<div class="rw-workspace rw-dashboard rw-dashboard-idle" data-scope="preview" data-variant="dashboard" data-battle-state="${battle}" data-preview-state="${status}"><div class="rw-toolbar"><div class="rw-dashboard-title"><strong>${esc(title)}</strong>${scope}</div>${link}<span role="status" class="rw-status">${esc(battleText)}</span></div>${body}</div>`;
  }
  function create(options) {
    const {request,onError=()=>{},onPreview=null} = options;
    let liveHost=null, savedHost=null, historyHost=null, live=null, saved=null, liveVariant='default', advancedOpen=false, destroyed=false;
    let selected='', epoch=0, pollBusy=false, pollSequence=0, historyKey='', historyRequest=0, detailRequest=0, context='', mountedHistoryHost=null;
    let battleState='loading', battleError='', idleHost=null, idleSignature='';
    let previewState=null, previewRequest=0, previewInflight=null, published={status:'',blueprint:'',context:'',snapshot:null};
    const previewCache=new Map();
    const queueOpen=new Set();
    let historyState={instance:'',limit:20,offset:0,status:'',rows:[],loaded:false,hasNext:false,loading:false,error:'',scope:null,detailHTML:''};
    const timers = new Map();
    const bindings = new WeakMap();
    const staleHeld = new WeakSet();
    const clockTimer=globalThis.document?setInterval(()=>{if(liveHost?.isConnected && live)clocks(live);},1000):null;
    /* Requests, replies and debounce timers belong to a model, not to the element
       it was first drawn in. A model stays current while it is this context's
       live (or saved) model and renders into whichever host is mounted now; a
       replaced model (context change, new battle identity, destroy) drops its
       late replies and timers. */
    const active=model=>!!model && !destroyed && (model.scope==='live'?model===live:model===saved);
    const hostOf=model=> {
      if(!active(model))return null;
      const host=model.scope==='live'?liveHost:savedHost;
      return host && bindings.get(host)===model?host:null;
    };
    const nowFor=model=>Date.now()/1000+(model.clockOffset || 0);
    const report=error=>{try{onError(error);}catch(_){/* reporting never changes command state */}};
    const fetchJSON = (url,body) => request(url,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    /* Open full-queue disclosures, per scope identity: a battle, or a previewed
       run in a context. Another battle or run starts closed. */
    const liveQueueKey=model=>`live:${model.key}`;
    const previewQueueKey=state=>`preview:${JSON.stringify([state?.context ?? context,state?.name || ''])}`;
    function bindQueue(host,key) {
      const details=host.querySelector('[data-queue-all]');
      if(details)details.ontoggle=()=>{if(details.open)queueOpen.add(key);else queueOpen.delete(key);};
    }
    /* A re-render keeps keyboard focus on the control that had it. */
    const FOCUSABLE=['[data-queue-all] > summary','.rw-edit-link'];
    function focusWithin(container,doc) {
      const active=doc?.activeElement;
      if(!active || typeof container?.contains!=='function' || !container.contains(active))return '';
      return FOCUSABLE.find(selector=>typeof active.matches==='function' && active.matches(selector)) || '';
    }
    function restoreFocus(container,selector) {
      if(selector)container.querySelector(selector)?.focus?.({preventScroll:true});
    }
    function schedule(model) {
      clearTimeout(timers.get(model));
      timers.set(model,setTimeout(()=>{timers.delete(model);flush(model);},450));
    }
    function status(model) {
      const host=hostOf(model);
      if (!host) return;
      const isLive=model.scope==='live';
      const el=host.querySelector('.rw-status');
      // An unknown outcome outranks an older refusal; invalid input is guidance
      // added to whatever else is true rather than hidden behind it.
      const problem=[model.uncertain?.message || refusalHeadline(model) || model.error,model.observationError].filter(Boolean).join(' · ');
      const guidance=[model.invalid.size?'Enter a valid value':'',model.heldForReport?'Change held until the driver reports':''].filter(Boolean).join(' · ');
      const busy=model.sending || Object.keys(model.draft).length || Object.keys(model.pending).length || unacknowledged(model) || actionBusy(model);
      if (el) el.textContent=(isLive?[problem,guidance].filter(Boolean).join(' · '):problem || guidance) || (busy ? 'Pending' : isLive?'Driver acknowledged':'Saved');
      const setup=host.querySelector('[data-setup]');
      if(setup && isLive) {
        const signature=JSON.stringify(model.snapshot.runtime?.setup ?? null);
        if(setup.dataset.signature!==signature){setup.innerHTML=setupEvidenceHTML(model.snapshot.runtime?.setup);setup.dataset.signature=signature;}
      }
      host.querySelectorAll('[data-control]').forEach(input=> {
        const path=input.dataset.control;
        if ((input!==input.ownerDocument.activeElement || model.reconcile?.has(path)) && !model.invalid.has(path) && !Object.hasOwn(model.draft,path)) {
          const value=fieldValue(model,path);
          if (input.type==='checkbox') input.checked=value===true;
          else input.value=value ?? '';
        }
        const hint=host.querySelector(`[data-pending="${path}"]`);
        if (hint && isLive) {
          const text=hintText(model,path);if(hint.textContent!==text)hint.textContent=text;
          if(hint.dataset && 'pendingState' in hint.dataset){const state=hintState(model,path);if(hint.dataset.pendingState!==state)hint.dataset.pendingState=state;}
        }
        else if (hint && (model.pending[path] || Object.hasOwn(model.draft,path))) hint.textContent='Pending';
        else if (hint && hint.textContent==='Pending') hint.textContent='Saved';
        const duration=host.querySelector(`[data-duration="${path}"]`);
        if(duration){duration.textContent=durationHint(input.value===''?null:Number(input.value));duration.hidden=!duration.textContent;}
      });
      const plan=fieldValue(model,'shopping_plan');
      host.querySelectorAll('[data-weight-field]').forEach(field=>field.hidden=plan?.queue_mode!=='weighted_split');
      const summary=host.querySelector('[data-shopping-summary]');
      if(summary && isLive) {
        // The canonical (closed) markup decides whether content changed, so
        // opening the queue never re-renders it under the person's focus.
        const signature=shoppingSummaryHTML(model);
        if(summary.dataset.signature!==signature) {
          const key=liveQueueKey(model), focus=focusWithin(summary,host.ownerDocument);
          summary.innerHTML=shoppingSummaryHTML(model,{open:queueOpen.has(key)});summary.dataset.signature=signature;
          bindQueue(host,key);restoreFocus(summary,focus);
        }
      }
      const other=host.querySelector('[data-other-routines]');
      if(other && isLive){const text=otherRoutinesText(model);if(other.textContent!==text)other.textContent=text;}
      const shopping=model.snapshot.runtime?.routines?.shopping?.last_outcome;
      const warning=host.querySelector('[data-shopping-warning]');
      if(warning){
        warning.hidden=!(isLive && shopping && (shopping.reserve_supported===false || shopping.quantity_observation_supported===false));
        warning.textContent=shopping?.reserve_supported===false?'Legacy shopping does not protect a cash reserve. Review and convert the saved shopping policy before relying on reserve enforcement.':shopping?.quantity_observation_supported===false?'Shopping is waiting for verified purchase quantity; reserve protection cannot be confirmed.':'';
      }
      host.querySelectorAll('[data-shop]').forEach(input=> {
        if((input===input.ownerDocument.activeElement && (!model.reconcile?.has('shopping_plan') || Object.hasOwn(model.draft,'shopping_plan'))) || model.invalid.has(input.dataset.shop) || !plan)return;
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
      // Refused paths follow the read requested after the refusal, even while focused.
      if(model.awaitRead===undefined)model.reconcile?.clear();
      clocks(model);
    }
    /* Time-dependent text and the controls it gates: runs on every status pass
       and once a second, so a driver that stops reporting stops looking live. */
    function clocks(model) {
      const host=hostOf(model);
      if(!host)return;
      const isLive=model.scope==='live', now=nowFor(model), freshness=liveFreshness(model,now);
      host.querySelectorAll('[data-countdown]').forEach(el=> {
        const name=el.dataset.countdown, report=liveFreshness(model,now,routineOf(name));
        const full=!isLive?'':report==='unavailable'?'Status unavailable':model.snapshot.status==='prepared'?'Waiting for battle':report==='unknown'?'Waiting for first report':report==='stale'?'Stale observation'
          :countdown(model.snapshot.runtime?.routines?.[name],fieldValue(model,`routines.${name}.enabled`),now);
        const compact='clockCompact' in (el.dataset || {});
        const text=compact?COMPACT_CLOCK[full] || full:full;
        if(el.textContent!==text)el.textContent=text;
        if(compact && el.title!==full)el.title=full;
      });
      const routines=model.snapshot.runtime?.routines || {};
      host.querySelectorAll('[data-observation="ad_gems"]').forEach(region=> {
        const values=observationValues(routines.ad_gems,now,model.observationUnavailable);
        region.querySelectorAll('[data-observation-field]').forEach(el=>el.textContent=values[el.dataset.observationField] || 'Unknown');
      });
      host.querySelectorAll('[data-runtime-raw]').forEach(el=> {
        const raw=JSON.stringify(routines[el.dataset.runtimeRaw] ?? {status:'Observation unavailable'},null,2);
        if(el.textContent!==raw)el.textContent=raw;
      });
      host.querySelectorAll('[data-inspect]').forEach(el=>el.href=inspectLink(model.snapshot,routines[el.dataset.inspect]));
      host.querySelectorAll('[data-command-control]').forEach(el=>el.textContent=commandFeedback(model,el.dataset.commandControl,false,now));
      host.querySelectorAll('[data-command-action]').forEach(el=> {
        const feedback=commandFeedback(model,el.dataset.commandAction,true,now);
        const outcome=routines[el.dataset.commandAction]?.last_outcome;
        el.textContent=feedback || (outcome && !('commandOnly' in (el.dataset || {}))?`Last result: ${resultText(el.dataset.commandAction,outcome)}`:'');
        el.hidden=!el.textContent;
      });
      host.querySelectorAll('[data-routine-outcome]').forEach(el=>{el.textContent=outcomeText(el.dataset.routineOutcome,routines[el.dataset.routineOutcome],now);});
      const refusal=routines.floating_gems?.last_refusal;
      host.querySelectorAll('[data-orbit-refusal]').forEach(el=>el.textContent=refusal?`Latest refusal: ${label(refusal.reason || 'unknown')}${numeric(refusal.observed_at)?` · ${Math.max(0,Math.floor(now-refusal.observed_at))}s ago`:''}`:'No refusal recorded');
      host.querySelectorAll('[data-shopping-age]').forEach(el=> {
        const at=routines.shopping?.server_time;
        el.textContent=freshness==='unavailable'?'· last known':numeric(at)?`· reported ${ago(now-at)}`:'';
      });
      const notice=host.querySelector('[data-dashboard-notice]');
      if(notice && isLive){const text=dashboardNotice(model,now,freshness);if(notice.textContent!==text)notice.textContent=text;if(notice.hidden!==!text)notice.hidden=!text;}
      gates(host,model,now,freshness);
    }
    function gates(host,model,now,freshness) {
      const isLive=model.scope==='live', stale=isLive && holdsInput(freshness);
      host.querySelectorAll('[data-action]').forEach(button=> {
        const state=actionState(model,button.dataset.action,now);
        if(button.disabled===state.enabled)button.disabled=!state.enabled;
        if(isLive && button.title!==state.reason)button.title=state.reason;
      });
      host.querySelectorAll('[data-action-reason]').forEach(el=> {
        const state=actionState(model,el.dataset.actionReason,now);
        if(el.textContent!==state.reason)el.textContent=state.reason;
        if(el.hidden!==state.enabled)el.hidden=state.enabled;
      });
      if(isLive) {
        // Without a fresh report from the driver (none yet, or stale) a routine
        // takes no new input; a draft typed before is held until it reports.
        host.querySelectorAll('[data-control]').forEach(input=> {
          const disabled=!allowed(model,input.dataset.control) || holdsInput(liveFreshness(model,now,routineOf(input.dataset.control)));
          if(input.disabled!==disabled)input.disabled=disabled;
        });
        const shopHeld=holdsInput(liveFreshness(model,now,'shopping'));
        host.querySelectorAll('[data-shop],[data-shop-toggle],[data-move],[data-convert-plan],[data-new-plan],[data-conversion]').forEach(el=> {
          if(shopHeld && !el.disabled){el.disabled=true;staleHeld.add(el);}
          else if(!shopHeld && staleHeld.has(el)){el.disabled=false;staleHeld.delete(el);}
        });
      }
      const reset=host.querySelector('[data-reset]');
      if(reset) reset.disabled=model.sending || model.awaitRead!==undefined || actionBusy(model) || stale || !Object.keys(flatOverrides(model.snapshot.overrides)).length;
      const retry=host.querySelector('[data-retry-command]');
      if(retry) {
        const hide=!model.uncertain, doc=host.ownerDocument || retry.ownerDocument;
        // Keep keyboard focus in the panel when the focused Retry disappears.
        if(hide && !retry.hidden && doc?.activeElement===retry) {
          const target=host.querySelector('.rw-status');
          if(target){target.tabIndex=-1;target.focus?.();}
        }
        retry.hidden=hide;retry.disabled=model.sending || model.observationUnavailable;
      }
    }
    function mount(host,model) {
      bindings.set(host,model);
      if(host===idleHost){idleHost=null;idleSignature='';}
      host.innerHTML=renderHTML(model,{variant:model.scope==='live'?liveVariant:'default',advancedOpen,queueOpen:model.scope==='live' && queueOpen.has(liveQueueKey(model))});
      const advanced=host.querySelector('[data-advanced]');
      if(advanced)advanced.ontoggle=()=>{advancedOpen=advanced.open;};
      if(model.scope==='live')bindQueue(host,liveQueueKey(model));
      host.oninput=event=> {
        if(hostOf(model)!==host)return;
        const conversion=event.target.closest('[data-conversion]');
        if(conversion){
          model.conversionDraft ||= clone(model.snapshot.legacy_conversion.plan);
          const value=conversion.tagName==='SELECT'?conversion.value:conversion.value===''?null:conversion.valueAsNumber;
          model.conversionDraft[conversion.dataset.conversion]=value;
          const button=host.querySelector('[data-convert-plan]');
          if(button)button.disabled=!conversion.checkValidity() || !numeric(model.conversionDraft.cash_reserve) || model.conversionDraft.cash_reserve<0;
          const raw=host.querySelector('.rw-conversion pre');if(raw)raw.textContent=JSON.stringify(model.conversionDraft,null,2);
          return;
        }
        const shop=event.target.closest('[data-shop]');
        if(shop) {
          clearTimeout(timers.get(model));
          if(!allowed(model,'shopping_plan'))return;
          if(!shop.checkValidity()){model.invalid.add(shop.dataset.shop);status(model);return;}
          model.invalid.delete(shop.dataset.shop);
          const value=shop.type==='checkbox'?shop.checked:shop.tagName==='SELECT'?shop.value:shop.value===''?null:shop.valueAsNumber;
          model.draft.shopping_plan=editPlan(fieldValue(model,'shopping_plan'),shop.dataset.shop,value);
          model.error='';model.refusal=null;status(model);
          schedule(model);return;
        }
        const input=event.target.closest('[data-control]'); if(!input)return;
        const path=input.dataset.control;
        if(!allowed(model,path))return;
        clearTimeout(timers.get(model));
        if(input.type!=='checkbox' && (input.value==='' || !input.checkValidity() || !Number.isFinite(input.valueAsNumber))){model.invalid.add(path);status(model);return;}
        model.invalid.delete(path);
        model.draft[path]=input.type==='checkbox'?input.checked:input.value===''?null:input.valueAsNumber;
        model.error=''; model.refusal=null; status(model);
        schedule(model);
      };
      host.onclick=event=> {
        if(hostOf(model)!==host)return;
        if(event.target.closest('[data-retry-command]')){retryCommand(model);return;}
        const convert=event.target.closest('[data-convert-plan]');
        if(convert && !convert.disabled && allowed(model,'shopping_plan') && model.snapshot.legacy_conversion?.plan) {
          model.draft.shopping_plan=clone(model.conversionDraft || model.snapshot.legacy_conversion.plan);mount(host,model);flush(model);return;
        }
        const move=event.target.closest('[data-move]');
        if(move && !move.disabled) {
          const plan=fieldValue(model,'shopping_plan');const queue=plan.queue.filter(u=>u.enabled && !(plan.excluded_upgrades || []).includes(u.id));
          const index=queue.findIndex(u=>u.id===move.dataset.move);const target=queue[index+Number(move.dataset.direction)];
          if(target){model.draft.shopping_plan=moveQueue(plan,move.dataset.move,target.id);publishQueue(host,model);host.querySelector(`[data-move="${move.dataset.move}"][data-direction="${move.dataset.direction}"]`)?.focus();}
          return;
        }
        const add=event.target.closest('[data-new-plan]');
        if(add && !add.disabled && allowed(model,'shopping_plan')) {
          model.draft.shopping_plan={version:2,enabled:true,interval_sec:5,cadence:'single_attempt',cash_reserve:null,queue_mode:'highest_affordable',queue:[],excluded_upgrades:['defense_absolute']};
          mount(host,model);flush(model);return;
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
          flush(model); return;
        }
        const button=event.target.closest('[data-action]');
        if(button && !button.disabled) runAction(model,button.dataset.action);
      };
      host.ondragstart=event=> {
        const row=event.target.closest('[data-queue-id], [data-upgrade]');
        if(hostOf(model)!==host || !row || row.getAttribute('draggable')!=='true' || !allowed(model,'shopping_plan') || event.target.closest('input,select,[data-action]')){event.preventDefault();return;}
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
        const queue=event.target.closest('[data-queue]');if(hostOf(model)!==host || !queue || !model.draggingUpgrade || !allowed(model,'shopping_plan'))return;
        event.preventDefault();const id=event.dataTransfer.getData('text/plain');
        if(id!==model.draggingUpgrade){host.ondragend();return;}
        const target=event.target.closest('[data-queue-id]')?.dataset.queueId;
        model.draft.shopping_plan=dropInQueue(fieldValue(model,'shopping_plan'),id,target);
        host.ondragend();publishQueue(host,model);
      };
      status(model);
    }
    function publishQueue(host,model) {
      const queue=host.querySelector('[data-queue]');if(queue)queue.innerHTML=queueHTML(model);
      model.error='';model.refusal=null;status(model);schedule(model);
    }
    function receipt(model,row,extra) {
      if(!row?.id)return;
      const now=Date.now()/1000+(model.clockOffset || 0);
      (model.receipts ||= {})[row.id]={requested_at:now,updated_at:now,...extra,...row};
    }
    /* A definite refusal recorded nothing (or, for a refused retry, nothing more):
       release the command, show the observed values again unless the person has
       typed since, and hold further sends until a read requested afterwards.
       Only one request per model is in flight (model.sending), so the pending
       entries of the refused paths belong to this request. */
    function refuse(model,request,outcome,error) {
      model.uncertain=null;
      const retried=outcome==='retry_refused';
      const message=retried?`Retry refused: ${error.message}. Whether the first attempt was recorded is unknown.`
        :`Refused: ${error.message}. Nothing was recorded.`;
      model.refusal={...request,retried,message,feedback:retried?'Retry refused · first attempt unconfirmed':`Refused · ${error.message}`};
      for(const path of Object.keys(request.changes || {})) {
        delete model.pending[path];
        (model.reconcile ||= new Set()).add(path);
      }
      model.awaitRead=pollSequence;
    }
    async function flush(model,retry=false) {
      if(!active(model) || model.sending || (!retry && (model.uncertain || model.awaitRead!==undefined || model.invalid.size || unacknowledged(model) || !Object.keys(model.draft).length)))return;
      // Sends wait for a fresh driver report; the held draft drains on the read
      // that brings one (poll), under the same explicit-edit rules.
      if(!retry && model.scope==='live' && Object.keys(model.draft).some(path=>holdsInput(liveFreshness(model,nowFor(model),routineOf(path))))){model.heldForReport=true;status(model);return;}
      model.heldForReport=false;
      const previous=retry?model.uncertain:null;
      const changes=previous?.changes || {...model.draft};
      const body=previous?.body || (model.scope==='live'?command(model,{changes}):{blueprint:model.snapshot.blueprint,context:model.snapshot.context,expected_revision:model.snapshot.profile_revision,changes});
      // A new request supersedes the previous request's refusal; a retry keeps
      // the frozen body of the request whose outcome is unknown.
      if(!retry){model.draft={};model.refusal=null;}
      model.sending=true; model.error='';
      const key=model.key, operation=model.snapshot.operation_id;
      let savedWrite=false;
      for(const [path,value] of Object.entries(changes))model.pending[path]={value,revision:null};
      status(model);
      try {
        const result=await fetchJSON(model.scope==='live'?`/api/operations/${encodeURIComponent(operation)}/live-controls`:'/api/run-controls',body);
        if(model.key!==key || !active(model))return;
        if(model.scope==='saved') {
          if(!result.settings)throw new Error('Saved settings were not returned; refresh before editing again.');
          refresh(model,{...model.snapshot,...result});
          for(const path of Object.keys(changes))delete model.pending[path];
          savedWrite=true;
        } else {
          model.uncertain=null;model.refusal=null;
          receipt(model,result.command,{kind:'controls',payload:changes});
          const revision=result.control_revision ?? result.battle?.control_revision;
          for(const path of Object.keys(changes))model.pending[path].revision=revision;
          if(result.battle)refresh(model,{...model.snapshot,...result.battle});
          else if(numeric(revision))model.snapshot.control_revision=revision;
        }
      } catch(error) {
        if(!active(model))return;
        if(model.scope==='live') {
          const outcome=commandOutcome(error,retry);
          if(outcome==='unknown')model.uncertain={kind:'controls',body,changes,operation,message:`Command acknowledgement unavailable; outcome unknown: ${error.message}`};
          else refuse(model,{kind:'controls',changes,body,operation},outcome,error);
        } else {
          model.error=error.message;
          for(const [path,value] of Object.entries(changes)) { delete model.pending[path]; if(!Object.hasOwn(model.draft,path))model.draft[path]=value; }
        }
        report(error);
      } finally {
        model.sending=false; status(model);
        // A live draft typed during the request drains even if an unrelated driver
        // rejection set model.error meanwhile; a saved error keeps its draft.
        if(active(model) && model.awaitRead!==undefined)poll();
        else if(active(model) && (model.scope==='live' || !model.error) && Object.keys(model.draft).length)flush(model);
        for(const resolve of model.waiters || [])resolve();model.waiters=[];
      }
      // The write is already acknowledged; refreshing the preview is display work
      // whose failure never reaches the command outcome.
      if(savedWrite){try{refreshSavedPreview(model);}catch(error){report(error);}}
    }
    async function runAction(model,action,retry=false) {
      if(!active(model) || model.sending || (!retry && !actionState(model,action,nowFor(model)).enabled))return;
      const body=retry?model.uncertain.body:command(model,{action});
      if(!retry)model.refusal=null;
      const operation=model.snapshot.operation_id;
      model.sending=true; model.error=''; status(model);
      try {
        const result=await fetchJSON(`/api/operations/${encodeURIComponent(operation)}/actions`,body);
        if(!active(model))return;
        if(!result.command?.id && !result.command_id)throw new Error('No command acknowledgement returned');
        model.uncertain=null;model.refusal=null;
        receipt(model,result.command,{kind:'action',payload:{action}});
        if(result.battle)refresh(model,{...model.snapshot,...result.battle});
        model.actionPending=['applied','rejected','failed','completed','expired'].includes(result.command?.state)?null:result.command?.id || result.command_id || action;
      } catch(error) {
        if(!active(model))return;
        const outcome=commandOutcome(error,retry);
        if(outcome==='unknown')model.uncertain={kind:'action',body,action,operation,message:`Command acknowledgement unavailable; outcome unknown: ${error.message}`};
        else refuse(model,{kind:'action',action,body,operation},outcome,error);
        report(error);
      } finally {model.sending=false;status(model);if(active(model) && model.awaitRead!==undefined)poll();}
    }
    function retryCommand(model) {
      if(!model.uncertain || model.sending || model.observationUnavailable || !active(model))return;
      if(model.uncertain.kind==='action')return runAction(model,model.uncertain.action,true);
      return flush(model,true);
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
        if(saved){selected=saved.snapshot.blueprint;saved.error=error.message;status(saved);}
        else savedHost.textContent=error.message;
        onError(error);
      }
    }
    async function settleSaved(model) {
      clearTimeout(timers.get(model));
      if(model.invalid.size)throw new Error('Finish the invalid saved control before opening another run.');
      if(model.sending){await new Promise(resolve=>(model.waiters ||= []).push(resolve));return settleSaved(model);}
      if(model.error)throw new Error(model.error);
      if(Object.keys(model.draft).length){if(!hostOf(model))throw new Error('Saved editor changed; reopen the run before editing.');await flush(model);return settleSaved(model);}
      return true;
    }
    async function poll() {
      if(pollBusy || destroyed || !liveHost?.isConnected)return;
      pollBusy=true;
      const targetContext=context, sequence=++pollSequence;
      try {
        const response=await fetchJSON('/api/battles/active');
        if(targetContext!==context || destroyed)return;
        const battle=response.battle;
        if(!battle) {
          if(live)clearTimeout(timers.get(live));
          live=null;battleState='none';battleError='';renderIdle();return;
        }
        battleState='tracked';battleError='';
        const snapshot={...battle,catalog:response.catalog ?? battle.catalog,capabilities:response.capabilities ?? battle.capabilities,constraints:response.constraints ?? battle.constraints};
        const awaitingAcknowledgement=live && unacknowledged(live);
        if(!live || identity(battle)!==live.key) {
          if(live)clearTimeout(timers.get(live));
          live=makeModel('live',snapshot);
          if(liveHost)mount(liveHost,live);
        }
        else {refresh(live,snapshot);settleRecorded(live);}
        live.observationUnavailable=false;live.observationError='';
        // Only a read requested after a refusal may release held sends.
        const reread=live.awaitRead!==undefined && sequence>live.awaitRead;
        if(reread)live.awaitRead=undefined;
        const commands=Array.isArray(snapshot.commands)?snapshot.commands:Object.values(snapshot.commands || {});
        const finished=commands.find(c=>(c.id===live.actionPending || c.action===live.actionPending) && ['applied','rejected','failed','completed','expired'].includes(c.state || c.status));
        if(live.actionPending && finished){live.actionPending=null;if(['rejected','failed','expired'].includes(finished.state || finished.status))live.error=finished.reason || finished.error || 'Action was rejected by the driver';}
        if(numeric(response.server_time))live.clockOffset=response.server_time-Date.now()/1000;
        status(live);
        // A held or queued draft is the person's explicit edit: it drains once the
        // driver is caught up, whatever unrelated error is displayed.
        if(((awaitingAcknowledgement || reread) && !unacknowledged(live)) || live.heldForReport)flush(live);
      } catch(error) {
        if(targetContext!==context || destroyed)return;
        if(live){live.observationUnavailable=true;live.observationError=`Live observation unavailable: ${error.message}`;status(live);}
        else {battleState='unavailable';battleError=error.message;renderIdle();}
      } finally {pollBusy=false;}
    }
    /* The live host without a live model. The default variant keeps its
       sentences; the Dashboard variant shows the Start picker run's saved
       preview. Re-rendered only when its content changes. */
    function renderIdle() {
      if(!liveHost || live || destroyed)return;
      const dashboard=liveVariant==='dashboard';
      const state={battle:battleState,error:battleError,preview:previewState};
      // Canonical markup (queue closed) decides whether to re-render.
      const signature=dashboard?previewHTML(state)
        :`text:${battleState==='none'?'No active battle. Saved controls are available in Runs.':battleState==='unavailable'?`Live controls unavailable: ${battleError}`:'Loading current battle…'}`;
      if(idleHost===liveHost && idleSignature===signature)return;
      bindings.delete(liveHost);
      if(dashboard) {
        const key=previewQueueKey(previewState), focus=idleHost===liveHost?focusWithin(liveHost,liveHost.ownerDocument):'';
        liveHost.innerHTML=previewHTML({...state,queueOpen:queueOpen.has(key)});
        bindQueue(liveHost,key);restoreFocus(liveHost,focus);
      }
      else liveHost.textContent=signature.slice(5);
      idleHost=liveHost;idleSignature=signature;
    }
    const runKey=name=>String(name ?? '').replace(/^bp_/,'');
    /* Observers see only a snapshot validated for the context and run it was
       requested for; every other state (loading, error, empty, another context)
       publishes null so an earlier selection's snapshot cannot linger. */
    function publishPreview() {
      if(typeof onPreview!=='function')return;
      const state=previewState;
      const status=state?.status || 'empty', snapshot=status==='ready'?state.snapshot:null;
      const info={status,blueprint:state?.name || '',context:state?.context ?? context};
      if(status==='error')info.error=state.error;
      if(published.status===info.status && published.blueprint===info.blueprint && published.context===info.context && published.snapshot===snapshot)return;
      published={...info,snapshot};
      try{onPreview(snapshot?clone(snapshot):null,info);}catch(error){report(error);}
    }
    function setPreview(next) {
      previewState=next;
      try{renderIdle();}catch(error){report(error);}
      publishPreview();
    }
    /* Read-only preview of a run's saved settings (GET /api/run-controls only).
       Never touches the Runs editor's selection, model or drafts. Cached per
       context and run name, in-flight reads are shared; force re-reads. */
    function preview(blueprint,{force=false,label:title,message}={}) {
      if(destroyed)return Promise.resolve(null);
      const name=typeof blueprint==='string'?blueprint:'';
      const display=title || (name?label(runKey(name)):'');
      const targetContext=context;
      if(!name) {
        previewRequest++;previewInflight=null;
        setPreview({key:'',name:'',label:display,status:'empty',message:message || '',context:targetContext});
        return Promise.resolve(null);
      }
      const key=JSON.stringify([targetContext,name]);
      // A forced read declares the cached snapshot superseded before it runs, so
      // a failed forced read can never bring the old snapshot back as ready.
      if(force)previewCache.delete(key);
      if(!force && previewInflight?.key===key)return previewInflight.promise;
      if(!force && previewCache.has(key)) {
        previewRequest++;previewInflight=null;
        const snapshot=previewCache.get(key);
        setPreview({key,name,label:display,status:'ready',snapshot,context:targetContext});
        return Promise.resolve(clone(snapshot));
      }
      const token=++previewRequest;
      setPreview({key,name,label:display,status:'loading',context:targetContext});
      const promise=(async()=> {
        let snapshot=null, failure=null;
        try {snapshot=await fetchJSON(`/api/run-controls?blueprint=${encodeURIComponent(name)}`);}
        catch(error){failure=error;}
        if(token!==previewRequest || targetContext!==context || destroyed)return null;
        if(previewInflight?.token===token)previewInflight=null;
        if(!failure && !(snapshot && typeof snapshot==='object' && runKey(snapshot.blueprint)===runKey(name) && snapshot.settings && typeof snapshot.settings==='object'))
          failure=new Error('Saved settings response did not match the selected run');
        if(failure){setPreview({key,name,label:display,status:'error',error:failure.message || String(failure),context:targetContext});return null;}
        const owned=clone(snapshot);
        previewCache.set(key,owned);
        setPreview({key,name,label:display,status:'ready',snapshot:owned,context:targetContext});
        return clone(owned);
      })();
      previewInflight={key,token,promise};
      return promise;
    }
    /* An acknowledged saved write changes what that run's next start uses: drop
       its cached previews and re-read the displayed one if it is that run. */
    function refreshSavedPreview(model) {
      const run=runKey(model.snapshot.blueprint);
      for(const key of [...previewCache.keys()])if(runKey(JSON.parse(key)[1])===run)previewCache.delete(key);
      const state=previewState;
      if(state?.name && runKey(state.name)===run && state.context===context)preview(state.name,{force:true,label:state.label});
    }
    const sameContext=(first,second)=>!first || !second || ['device_key','instance','account','serial'].every(key=>(first[key] ?? null)===(second[key] ?? null));
    function historyToolbar() {
      const host=historyHost;if(!host)return;
      const message=host.querySelector('[data-history-status]');
      if(message)message.textContent=historyState.error?`${historyState.error}${historyState.loaded?' - Last known records retained.':''}`:historyState.loading?'Refreshing battle history...':historyState.loaded?`Page ${Math.floor(historyState.offset/historyState.limit)+1} - ${historyState.rows.length} records`:'';
      host.querySelectorAll('[data-history-command]').forEach(button=> {
        const kind=button.dataset.historyCommand;
        button.hidden=kind==='retry' && !historyState.error;
        button.disabled=historyState.loading || (kind==='previous' && historyState.offset===0) || (kind==='next' && !historyState.hasNext);
      });
      const filter=host.querySelector('[data-history-filter]');
      if(filter){filter.value=historyState.status;filter.disabled=historyState.loading;}
    }
    function mountHistory() {
      if(!historyHost || mountedHistoryHost===historyHost)return;
      mountedHistoryHost=historyHost;
      historyHost.innerHTML=`<div class="rw-history-toolbar"><label>Status <select data-history-filter><option value="">All recorded battles</option><option value="active">Active</option><option value="prepared">Prepared</option><option value="ended">Ended</option><option value="interrupted">Observation interrupted</option></select></label><button class="small ghost" data-history-command="refresh">Refresh</button><button class="small ghost" data-history-command="retry" hidden>Retry</button><button class="small ghost" data-history-command="previous">Previous</button><button class="small ghost" data-history-command="next">Next</button><small role="status" data-history-status></small></div><div class="rw-history-list"></div><div class="rw-history-detail">${historyState.detailHTML}</div>`;
      historyHost.onclick=event=> {
        const row=event.target.closest('[data-battle]');if(row){detail(row.dataset.battle);return;}
        if(event.target.closest('[data-detail-retry]')){detail(historyKey);return;}
        const button=event.target.closest('[data-history-command]');if(!button || button.disabled)return;
        const kind=button.dataset.historyCommand;
        const offset=kind==='next'?historyState.offset+historyState.limit:kind==='previous'?Math.max(0,historyState.offset-historyState.limit):historyState.offset;
        history(historyState.instance,{offset});
      };
      historyHost.onchange=event=> {
        const filter=event.target.closest('[data-history-filter]');
        if(filter)history(historyState.instance,{offset:0,status:filter.value});
      };
      renderHistoryRows();historyToolbar();
    }
    function renderHistoryRows() {
      const target=historyHost?.querySelector('.rw-history-list');if(!target)return;
      target.innerHTML=historyState.rows.map(b=>`<button class="ghost rw-history-row" data-battle="${esc(b.id)}" aria-pressed="${b.id===historyKey}"><strong>${esc(b.label || b.blueprint || b.id)}</strong><span>${esc(b.status ?? 'Unknown status')}</span><span>Tier ${esc(b.tier ?? 'unknown')} - wave ${esc(b.wave ?? b.final_wave ?? 'unknown')}</span><small>${esc(b.started_at ? new Date(b.started_at*1000).toLocaleString():'Start time unknown')}</small></button>`).join('') || `<p>${historyState.loaded?'No battles match this filter.':'No history loaded yet.'}</p>`;
    }
    async function history(instance=historyState.instance, options={}) {
      if(!historyHost)return;
      if(instance!==historyState.instance) {
        historyState={instance,limit:20,offset:0,status:'',rows:[],loaded:false,hasNext:false,loading:false,error:'',scope:null,detailHTML:''};
        historyKey='';detailRequest++;mountedHistoryHost=null;
      }
      mountHistory();
      const token=++historyRequest, host=historyHost, targetContext=context;
      const offset=options.offset ?? historyState.offset, filter=options.status ?? historyState.status;
      historyState.loading=true;historyState.error='';historyToolbar();
      try {
        const params=new URLSearchParams({instance,limit:String(historyState.limit+1),offset:String(offset)});
        if(filter)params.set('status',filter);
        const result=await fetchJSON(`/api/battles?${params}`);
        if(token!==historyRequest || host!==historyHost || targetContext!==context)return;
        if(!Array.isArray(result.battles))throw new Error('Battle history response was incomplete');
        if(result.context && instance && result.context.instance!==instance)throw new Error('History context changed; refresh the selected device');
        if(result.context && result.battles.some(row=>!row.context || !sameContext(row.context,result.context)))throw new Error('History returned another device context');
        if(historyState.scope && result.context && !sameContext(historyState.scope,result.context)) {
          historyKey='';detailRequest++;historyState.detailHTML='';
          const detail=host.querySelector('.rw-history-detail');
          if(detail)detail.textContent='Selected account changed; choose a recorded battle.';
        }
        historyState.rows=result.battles.slice(0,historyState.limit);
        historyState.hasNext=result.battles.length>historyState.limit;
        historyState.scope=result.context || historyState.scope;
        historyState.offset=offset;historyState.status=filter;historyState.loaded=true;
        renderHistoryRows();
      } catch(error) {
        if(token===historyRequest && host===historyHost && targetContext===context)historyState.error=`History unavailable: ${error.message}`;
      } finally {
        if(token===historyRequest && host===historyHost && targetContext===context){historyState.loading=false;historyToolbar();}
      }
    }
    async function detail(id) {
      const sameSelection=historyKey===id;
      historyKey=id;
      const host=historyHost, target=host?.querySelector('.rw-history-detail');if(!target)return;
      const token=++detailRequest, targetContext=context, instance=historyState.instance;
      const scope=historyState.scope;
      if(!sameSelection)historyState.detailHTML='';
      if(!historyState.detailHTML)target.textContent='Loading battle...';
      renderHistoryRows();
      try {
        const result=await fetchJSON(`/api/battles/${encodeURIComponent(id)}${instance?`?instance=${encodeURIComponent(instance)}`:''}`);
        if(token!==detailRequest || historyKey!==id || host!==historyHost || targetContext!==context)return;
        const battle=result.battle;
        if(!battle || battle.id!==id || (scope && (!battle.context || !result.context)) || !sameContext(battle.context,scope) || !sameContext(result.context,scope))throw new Error('Battle detail context changed');
        if(instance && result.context && result.context.instance!==instance)throw new Error('Battle detail belongs to another device');
        const html=`<article><header>${esc(battle.label || battle.blueprint || battle.id)}</header><p>${esc(battle.status ?? 'Unknown status')} - tier ${esc(battle.tier ?? 'unknown')}</p><p>Result: ${esc(battle.result ?? battle.outcome ?? 'unknown')} - end reason: ${esc(battle.end_reason ?? battle.reason ?? 'unknown')}</p>${historySummaryHTML(battle)}<details><summary>Configuration snapshot</summary><pre>${esc(JSON.stringify(battle.envelope ?? {status:'Configuration was not recorded'},null,2))}</pre></details><details open><summary>Recorded activity</summary><div class="rw-activity">${(result.events || []).map(e=>`<p><time>${esc(e.t ? new Date(e.t*1000).toLocaleTimeString():'Time unknown')}</time> ${esc(e.kind || e.action || 'Activity')}<small>${esc(historyActivityText(e))}</small></p>`).join('') || '<p>Activity was not recorded.</p>'}</div></details></article>`;
        historyState.detailHTML=html;target.innerHTML=html;
      } catch(error) {
        if(token===detailRequest && historyKey===id && host===historyHost && targetContext===context)target.innerHTML=`<p role="status">Battle detail unavailable: ${esc(error.message)}${historyState.detailHTML?' - Last known detail retained.':''} <button class="small ghost" data-detail-retry>Retry detail</button></p>${historyState.detailHTML}`;
      }
    }
    return {
      attach(hosts) {
        if(destroyed)return;
        const incoming=hosts.context || '';
        const changed=context!==incoming;
        if(changed){
          for(const model of [live,saved])if(model)clearTimeout(timers.get(model));
          saved=null;live=null;epoch++;historyRequest++;detailRequest++;historyKey='';mountedHistoryHost=null;historyState={instance:'',limit:20,offset:0,status:'',rows:[],loaded:false,hasNext:false,loading:false,error:'',scope:null,detailHTML:''};
          battleState='loading';battleError='';idleHost=null;idleSignature='';
          previewRequest++;previewInflight=null;previewCache.clear();previewState=null;queueOpen.clear();
          if(hosts.history)hosts.history.textContent='History not loaded for this context.';
        }
        context=incoming;
        liveVariant=hosts.liveVariant==='dashboard'?'dashboard':'default';
        liveHost=hosts.live;savedHost=hosts.saved;historyHost=hosts.history;
        if(changed)publishPreview();
        if(live && liveHost)mount(liveHost,live);
        else if(liveHost && (changed || liveVariant==='dashboard'))renderIdle();
        if(saved && savedHost)mount(savedHost,saved);
        poll();if(selected)choose(selected);
      },
      choose,poll,history,detail,preview,
      async prepareEntry(){if(saved)await settleSaved(saved);return true;},
      tick(){if(live)clocks(live);},
      selected:()=>selected,
      destroy(){destroyed=true;if(clockTimer)clearInterval(clockTimer);for(const timer of timers.values())clearTimeout(timer);timers.clear();liveHost=null;savedHost=null;historyHost=null;live=null;saved=null;epoch++;historyRequest++;detailRequest++;previewRequest++;previewInflight=null;}
    };
  }
  return {create,makeModel,refresh,effective,settings,fieldValue,countdown,durationHint,command,identity,renderHTML,allowed,editPlan,moveQueue,dropInQueue,conversionHTML,setupEvidenceHTML,historySummaryHTML,observationValues,inspectLink,commandFeedback,resultText,
    fresh:reportFresh,observationFresh,actionState,previewHTML,commandOutcome};
});
