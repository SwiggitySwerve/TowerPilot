/* Dashboard (#overview) projections. Pure: no requests, no DOM access and no
   game actions; index.html coordinates the reads and writes the regions.

   - automationFact: the main row's explicit automation state.
   - needsScreensHTML: runs whose saved-image check reported not ready.
   - nextHTML: the day plan's recorded decision (/api/schedule/status) and the
     latest recorded battle (/api/battles), each with its own read state.
   - attention / attentionHTML: at most three items that need a person, taken
     from canonical records (status reads, the latest setup operation and its
     recorded setup battle), never from the raw event tail, which stays on
     Runtime.
   Nothing here computes schedule eligibility, a current cash or affordability
   value, or a gem total; those are not published, so they are not shown. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DashboardView = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const label = value => String(value ?? '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const LIMIT = 3;

  /* Wall-clock text for a recorded epoch-seconds time: the time alone when it is
     today, else the date as well. `now` keeps tests deterministic. */
  function clock(t, now = Date.now() / 1000) {
    if (!finite(t)) return 'time not recorded';
    const date = new Date(t * 1000), today = new Date(now * 1000);
    const time = date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    return date.toDateString() === today.toDateString() ? time
      : date.toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + time;
  }
  /* Coarse relative span for display ("in 1h 12m", "8h ago"); seconds only under a minute. */
  function span(seconds) {
    if (!finite(seconds)) return '';
    const s = Math.max(0, Math.round(Math.abs(seconds)));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    return Math.floor(h / 24) + 'd';
  }

  /* What harvesting records as holding the emulator besides the process list:
     its standalone collector (harvest.operation) and another driver
     (harvest.owner). A collector whose worker the server cannot check
     (worker_alive null) or an accepted operation with no process yet is not in
     the process list, so a fresh empty list alone never proves idle. */
  function recordedOwners(status) {
    const harvest = status?.harvest;
    if (!plain(harvest) || harvest.version !== 1) return [];
    return [harvest.operation, harvest.owner].filter(record => record !== null && record !== undefined);
  }
  /* Why a status cannot show that nothing holds the emulator, or '' when it
     can: a fresh process list alone never proves it. Positive "nothing is
     running" evidence is a status whose harvesting records are readable and
     well formed (contract 1: no collector or other owner recorded, records
     typed; ownershipRecords) with a process scan whose numbers agree with the
     harvest server clock (processScanFresh). */
  function holdersUnknownReason(status) {
    if (!plain(status)) return 'no status was read';
    const harvest = status.harvest;
    if (harvest === undefined || harvest === null) return "this server doesn't report its harvesting records";
    if (!plain(harvest) || harvest.version !== HARVEST_VERSION) return 'this page cannot read the harvesting records of this server';
    if (!harvestReadable(harvest)) return 'the harvesting records could not be read';
    if (!ownershipRecords(status)) return 'the harvesting or process records are malformed';
    if (!processScanFresh(status.process_refresh, harvest.server_time)) return 'the process list is not confirmed fresh';
    return '';
  }
  /* The main row: what automation is doing, from /api/status processes and
     their freshness. Calibration workers count as screen learning. A listed
     driver on a fresh label is "running" (the conservative claim); idle needs
     positive evidence (holdersUnknownReason): without it the state is unknown.
     A failed read, or a stale scan over readable records, is "last known". */
  function automationFact({status, error = ''} = {}) {
    if (!status) return {text:error ? 'Automation state unavailable' : 'Automation not checked', tone:'warn'};
    const processes = Array.isArray(status.processes) ? status.processes : [];
    const learning = processes.filter(p => p.runner === 'calibrate' || p.runner === 'scan').length;
    const drivers = processes.length - learning;
    const state = status.process_refresh?.state;
    if (state === 'unknown') return {text:'Automation state unknown', tone:'warn'};
    // (a missing label is not stale: listed drivers stay "running", the conservative
    // claim; "idle" below needs the label and its numbers anyway)
    const lastKnown = !!error || (state !== undefined && state !== 'fresh');
    if (drivers) return lastKnown ? {text:'Automation last known running', tone:'warn'} : {text:'Automation running', tone:'ok'};
    const busy = learning ? ' · screen learning running' : '';
    // nothing listed, but harvesting records a holder: not idle, and not confirmed running
    if (recordedOwners(status).length) return {text:(lastKnown ? 'Automation last known ' : 'Automation ') + 'state unknown' + busy, tone:'warn'};
    // a stale scan over otherwise complete records, or the last good read before a failed one
    const recordsKnown = harvestReadable(status.harvest) && !!ownershipRecords(status);
    if (lastKnown) return recordsKnown && state === 'stale' || recordsKnown && error && !holdersUnknownReason(status)
      ? {text:'Automation last known idle' + busy, tone:'warn'} : {text:'Automation state unknown' + busy, tone:'warn'};
    if (holdersUnknownReason(status)) return {text:'Automation state unknown' + busy, tone:'warn'};
    return {text:'Automation idle' + busy, tone:learning ? 'busy' : 'idle'};
  }
  function factHTML(fact) {
    return `<p class="dashboard-fact" data-tone="${escape(fact.tone)}"><span class="dashboard-dot" aria-hidden="true"></span>${escape(fact.text)}` +
      (fact.detail ? `<span class="dashboard-fact-detail"> · ${escape(fact.detail)}</span>` : '') + '</p>';
  }
  /* The name a person knows a running process by. */
  function processLabel(process, runs = {}) {
    if (process.runner === 'gem_collector') return 'Diamond collector';
    const run = process.operation?.context?.selected_run;
    if (run) return runs?.[run]?.label || run;
    return process.runner === 'calibrate' ? 'Screen learning' : String(process.runner || 'Automation');
  }
  /* "Now": what automation is doing and what it is doing it to - the running
     drivers, the tracked battle (or that none is tracked) and a running setup
     operation's current step. `battleState` is tracked | none | failed |
     unchecked, from the controller's latest battle read. */
  function activity({status, error = '', battle = null, battleState = 'unchecked', operation = null, runs = {}} = {}) {
    const fact = automationFact({status, error});
    const drivers = (status?.processes || []).filter(p => p.runner !== 'calibrate' && p.runner !== 'scan');
    const parts = drivers.map(p => processLabel(p, runs));
    if (battleState === 'tracked' && battle)
      parts.push(battle.status === 'prepared' ? 'waiting to observe the battle' : finite(battle.runtime?.observed_wave) ? 'battle at wave ' + battle.runtime.observed_wave : 'battle tracked');
    else if (battleState === 'none') parts.push('no tracked battle');
    else if (battleState === 'failed') parts.push('battle status unavailable');
    // (collection is stated in the Gems row, from harvesting's own records; an
    // empty process list never says "no gem collection running")
    if (!drivers.length && status) {
      // a holder harvesting records but the process list does not show
      const recorded = recordedOwners(status);
      for (const record of recorded)
        parts.push(record === status.harvest.operation ? 'a diamond collector is recorded but its process is not listed' : 'another driver is recorded as holding the emulator but is not listed');
      // why "idle" cannot be said
      const why = !recorded.length && /^Automation (last known )?state unknown/.test(fact.text) ? holdersUnknownReason(status) : '';
      if (why) parts.push(why);
    }
    if (operation?.running) parts.push(operation.label + (operation.current?.label ? ': ' + operation.current.label : ''));
    return {...fact, detail:parts.join(' · ')};
  }

  function needsScreensHTML({runs = {}, readiness = {}} = {}) {
    const notReady = Object.keys(runs).filter(run => run !== 'combo' && readiness[run] && readiness[run].ready !== true);
    return notReady.length ? `<p class="dashboard-note">Needs screens: ${escape(notReady.map(run => runs[run]?.label || run).join(', '))} <a href="#screens" data-workspace-section="run-preparation">Learn screens</a></p>` : '';
  }

  /* ------------------------------------------------------------- day plan */
  const SCHEDULE_REASONS = {
    scheduler_not_observed:['Not running', ''],
    scheduler_not_running:['Stopped', ''],
    scheduler_worker_unavailable:['Worker not responding', 'warn'],
    scheduler_observation_stale:['Status stale', 'warn'],
    plan_unavailable:['Plan unavailable', 'warn'],
  };
  /* /api/schedule/status as recorded by the running day plan. The next clock
     boundary is a proposal to check again, not a promised switch: a switch
     waits for the current run's natural end. `read` is {data, error,
     checkedAt (ms)} or null when not yet read for this context. */
  function scheduleSummary(read, now = Date.now() / 1000) {
    if (!read) return {text:'Not checked yet', tone:'', detail:''};
    const data = read.data;
    if (read.error && !data) return {text:'Status unavailable: ' + read.error, tone:'warn', detail:''};
    const prefix = read.error ? 'Last known · ' : '';
    if (data?.availability === 'available') {
      const winner = data.winner?.label ? data.winner.label + ' now' : 'No block open now';
      const boundary = data.next_clock_boundary;
      let detail = '';
      if (finite(boundary?.at)) {
        const serverNow = finite(data.server_time) && finite(read.checkedAt) ? data.server_time + (now - read.checkedAt / 1000) : now;
        const remaining = boundary.at - serverNow;
        detail = `next check ${clock(boundary.at, now)}${remaining > 0 ? ' (in ' + span(remaining) + ')' : ''}; a switch waits for the run to end`;
      }
      return {text:prefix + winner, tone:read.error ? 'warn' : '', detail};
    }
    if (data?.availability === 'stale') {
      const age = finite(data.observed_at) && finite(data.server_time) ? span(data.server_time - data.observed_at) + ' ago' : 'age unknown';
      return {text:prefix + 'Status stale' + (data.observed_winner?.label ? ' · last known ' + data.observed_winner.label : '') + ' · observed ' + age, tone:'warn', detail:''};
    }
    const reason = data?.error ? 'plan_unavailable' : data?.reason;
    const [text, tone] = SCHEDULE_REASONS[reason] || [label(reason || 'not reported'), 'warn'];
    return {text:prefix + text + (data?.error ? ': ' + data.error : ''), tone:read.error ? 'warn' : tone, detail:''};
  }

  /* --------------------------------------------------------- last battle */
  const BATTLE_STATUS = {ended:'Ended', interrupted:'Interrupted', failed:'Failed', abandoned:'Abandoned'};
  /* The newest recorded battle that is no longer running (/api/battles rows,
     newest first). Wave comes from the recorded final wave, else the last
     observed wave, else it is stated as not recorded. Gem results stay on
     History, which owns their evidence rule. */
  function lastBattle(rows) {
    return (Array.isArray(rows) ? rows : []).find(row => row && !['active', 'prepared'].includes(row.status)) || null;
  }
  function lastBattleSummary(read, now = Date.now() / 1000) {
    if (!read) return {text:'Not checked yet', tone:''};
    if (read.error && !read.loaded) return {text:'Unavailable: ' + read.error, tone:'warn'};
    const battle = read.battle;
    if (!battle) return {text:(read.error ? 'Last known · ' : '') + 'No recorded battle yet', tone:read.error ? 'warn' : ''};
    const at = finite(battle.ended_at) ? battle.ended_at : battle.updated_at;
    const parts = [battle.label || battle.blueprint || 'Run',
      (BATTLE_STATUS[battle.status] || label(battle.status || 'status unknown')) + ' ' + clock(at, now) + (finite(at) ? ' (' + span(now - at) + ' ago)' : '')];
    if (battle.end_reason && battle.end_reason !== 'observed_results') parts.push(label(battle.end_reason).toLowerCase());
    parts.push(finite(battle.final_wave) ? 'wave ' + battle.final_wave : finite(battle.wave) ? 'last observed wave ' + battle.wave : 'wave not recorded');
    if (battle.result && battle.result !== 'unknown') parts.push(label(battle.result).toLowerCase());
    return {text:(read.error ? 'Last known · ' : '') + parts.join(' · '), tone:read.error ? 'warn' : ''};
  }

  function nextHTML({schedule = null, last = null, now = Date.now() / 1000} = {}) {
    const plan = scheduleSummary(schedule, now), battle = lastBattleSummary(last, now);
    const row = (key, model, href, link) => `<p class="dashboard-next-row"><span class="dashboard-next-key">${key}</span>` +
      `<span class="dashboard-next-value"${model.tone ? ` data-tone="${model.tone}"` : ''}>${escape(model.text)}${model.detail ? ` <span class="dashboard-next-detail">· ${escape(model.detail)}</span>` : ''}</span>` +
      `<a href="${href}">${link}</a></p>`;
    return row('Day plan', plan, '#schedule', 'Schedule') + row('Last battle', battle, '#history', 'History');
  }

  /* ----------------------------------------------------------- attention */
  const VERB = {error:'failed', stopped:'stopped', needs_attention:'finished with items to review'};
  const SETTLED = ['finished', 'home_verified'];
  /* One sentence for the latest setup operation's outcome and what it means
     now, from the recorded evidence: the setup test battle it left (and the
     launch guard that cites the same operation), else its final screen. The
     worker's own message stays beside it as detail, never alone. */
  function operationOutcome(operation, {setupBattle = null, guard = null, operationAt, now = Date.now() / 1000} = {}) {
    const at = finite(operationAt) ? ' at ' + clock(operationAt, now) : '';
    const step = operation.current?.label ? ` during “${operation.current.label}”` : '';
    const ownBattle = setupBattle && operation.operationId && setupBattle.operation_id === operation.operationId;
    const unresolved = ownBattle && !SETTLED.includes(setupBattle.status);
    const blocks = guard?.blocks_launch === true && guard.operation_id === operation.operationId;
    const impact = unresolved && blocks ? 'Its test battle was never confirmed back on Home, so Start and Collect stay off until a later setup verifies Home.'
      : unresolved ? 'Its test battle was not confirmed back on Home.'
      : operation.returnEvidence === 'Final screen unverified' ? 'Its final screen was not verified.'
      : 'Review it on Screens before retrying.';
    return `${operation.label} ${VERB[operation.state]}${at}${operation.state === 'needs_attention' ? '' : step}. ${impact}`;
  }
  /* Items a person should act on, most urgent first. `operation` is
     WorkspaceStatus.operation()'s model of the latest setup operation;
     `setupBattle` its recorded setup battle, `guard` the server's launch
     admission (/api/status setup_battle_guard), `operationAt` its last update. */
  function attention({status, statusError = '', operation = null, operationAt, setupBattle = null, guard = status?.setup_battle_guard} = {}, now = Date.now() / 1000) {
    const items = [];
    if (statusError) items.push({tone:'warn', text:'Live status unavailable: ' + statusError, action:{label:'Retry status', call:'pollDashboard(true)'}});
    else if (status?.process_refresh && status.process_refresh.state !== 'fresh')
      items.push({tone:'warn', text:status.process_refresh.state === 'unknown' ? 'Automation process state is unknown.' : 'Automation process state is stale; showing the last discovery.',
        action:{label:'Retry status', call:'loadStatus()'}});
    if (operation?.unavailable) items.push({tone:'warn', text:'Setup status unavailable: ' + operation.unavailable, action:{label:'Retry', call:'pollCalibrate()'}});
    if (operation && !operation.running && operation.saved) {
      const links = [{href:'#screens', section:'workspace-operation', label:'Setup details'}];
      if (operation.operationId) links.push({href:'#runtime?operation_id=' + encodeURIComponent(operation.operationId), label:'Events'});
      if (operation.restorePending)
        items.push({tone:'warn', text:'Equipment restoration pending: other automation is blocked until the saved equipment is restored.', detail:operation.message, links});
      else if (VERB[operation.state])
        items.push({tone:operation.state === 'error' ? 'bad' : 'warn', text:operationOutcome(operation, {setupBattle, guard, operationAt, now}),
          detail:operation.message ? 'Reported: ' + operation.message : '', links});
    }
    return items;
  }
  function attentionHTML(items, {limit = LIMIT} = {}) {
    const shown = (Array.isArray(items) ? items : []).slice(0, limit);
    const more = (items?.length || 0) - shown.length;
    const runtime = '<a class="dashboard-attention-runtime" href="#runtime">Runtime events</a>';
    if (!shown.length) return `<p class="dashboard-attention-head"><span class="dashboard-quiet">Nothing needs attention.</span>${runtime}</p>`;
    return `<p class="dashboard-attention-head"><span class="dashboard-label">Needs attention${more > 0 ? ` · ${more} more on Runtime` : ''}</span>${runtime}</p><ul class="dashboard-attention-list">${shown.map(item =>
      `<li data-tone="${escape(item.tone)}"><span class="dashboard-attention-text">${escape(item.text)}</span>` +
      (item.action ? ` <button class="small ghost" onclick="${escape(item.action.call)}">${escape(item.action.label)}</button>` : '') +
      [...(item.links || []), ...(item.link ? [item.link] : [])].map(link => ` <a href="${escape(link.href)}"${link.section ? ` data-workspace-section="${escape(link.section)}"` : ''}>${escape(link.label)}</a>`).join('') +
      (item.detail ? `<small class="dashboard-attention-detail">${escape(item.detail)}</small>` : '') +
      '</li>').join('')}</ul>`;
  }

  /* ------------------------------------------------------------ harvesting */
  /* GET /api/status harvest, contract version 1 (backend/tests/fixtures/
     harvest_status_v1.json): the person's persisted choice (desired), the run
     whose saved gem settings it uses (source), what the backend observes
     (state/code/message; the standalone collector operation and its battle
     freshness, or another owner and what it publishes about gems), the
     per-battle overlay on a running automation and this dashboard process's
     reconciler (host). Desired On, an enabled routine, a collection attempt and
     a confirmed reward are different facts: this projection states the choice
     and the observed owner/state only and never infers collection from a run, a
     heartbeat or saved settings. A status whose records the server could not
     read (UNREADABLE codes) is evidence of nothing: its choice is unknown. */
  const HARVEST_VERSION = 1;
  const UNREADABLE = ['status_failed', 'harvest_state_unreadable'];
  const HARVEST_STATES = {
    starting:['Collector starting', 'busy'],
    collecting:['Collecting gems in the battle on screen', 'ok'],
    waiting_for_battle:['Collector running, waiting for a battle on screen', 'busy'],
    live_paused:['Collector running; both gem routines are paused for this battle', 'warn'],
    transferring:['Handing the emulator to the run you started', 'busy'],
    stopping:['Collector stopping; its input is not confirmed stopped yet', 'warn'],
    blocked:['Blocked', 'warn'],
    backing_off:['Waiting before starting the collector again', 'warn'],
    unavailable:['Collector state unknown', 'warn'],
  };
  const CHOICE_REASONS = {enabled_by_person:'turned on', paused_by_person:'paused',
    collector_stopped_by_person:'paused when a collector was stopped', stopped_by_person:'paused when automation was stopped'};
  const OVERLAY_STATES = {requested:'requested', pending:'waiting for the driver', applied:'applied', rejected:'refused by the driver',
    expired:'expired before the driver applied it', not_needed:'already in effect', not_requested:'not requested yet',
    waiting_for_battle:'waits until the battle is observed', blocked:'held because the saved gem settings are not usable',
    unsupported:'not supported by this driver', live_choice:'left to the choices made for this battle'};
  const OVERLAY_TONES = {applied:'ok', not_needed:'ok', live_choice:'idle', rejected:'warn', expired:'warn', blocked:'warn', unsupported:'warn'};
  const flagOf = value => value && typeof value === 'object' ? value.enabled : value;
  function interval(seconds) {
    if (!finite(seconds) || seconds <= 0) return '';
    const s = Math.round(seconds);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
  }
  /* A desired record in its contract shape (backend/control/harvest.py
     desired_view): choice on / off / unset with the matching enabled flag
     (true / false / null) and a non-negative integer revision. Anything else,
     including a fractional revision or a choice its flag contradicts, is not a
     readable choice. */
  function desiredValid(desired) {
    if (!plain(desired) || !Number.isSafeInteger(desired.revision) || desired.revision < 0) return false;
    return desired.choice === 'on' ? desired.enabled === true : desired.choice === 'off' ? desired.enabled === false
      : desired.choice === 'unset' ? desired.enabled === null || desired.enabled === undefined : false;
  }
  /* True only for a contract-1 status whose harvesting records the server read
     and whose desired record is in its contract shape (desiredValid): only then
     are its choice, collector and owner fields evidence. */
  function harvestReadable(harvest) {
    return !!harvest && typeof harvest === 'object' && harvest.version === HARVEST_VERSION &&
      desiredValid(harvest.desired) && !UNREADABLE.includes(harvest.code);
  }
  /* A status's process scan (process_refresh) is fresh EVIDENCE only when the
     server labels it fresh, reports no error, and its numbers agree with that
     label and with each other. The server samples the harvest clock
     (`serverTime`, H) first and the scan age a moment later in the same request
     (frontend/dashboard.py api_status: harvest, then process_refresh), so with
     the scan's success time `at`: age = later - at >= H - at. Required: age
     finite, not negative and within the server's own bound (_procs_status:
     stale after 6 s); at finite; the age implied by H (H - at) not greater than
     the reported age (+ SCAN_CLOCK_SLACK_SEC rounding allowance), which rejects
     an "age 0" scan taken 7 s before H; and at not after H by more than that
     allowance (non-future). Age 6 with at = H or H + 2 is later sampling and
     stays valid. Missing numbers prove nothing. */
  const SCAN_FRESH_SEC = 6, SCAN_CLOCK_SLACK_SEC = 2;
  function processScanFresh(refresh, serverTime) {
    if (!plain(refresh) || refresh.state !== 'fresh' || refresh.error) return false;
    const age = refresh.age_sec, at = refresh.last_success_at;
    if (!finite(age) || age < 0 || age > SCAN_FRESH_SEC || !finite(at) || !finite(serverTime)) return false;
    const implied = serverTime - at;
    return implied >= -SCAN_CLOCK_SLACK_SEC && implied <= age + SCAN_CLOCK_SLACK_SEC;
  }
  /* Ownership records as evidence. Each must have the identity the contract
     gives it, of the right type; anything else is malformed and makes the whole
     observation unknown (never "no owner"):
     - a process (status.processes[]): a plain object with a positive integer
       pid and, when present, operation null or a plain object whose id is a
       non-empty string;
     - harvest.operation: null, or a plain object whose id is a non-empty string;
     - harvest.owner: null, or a plain object of kind 'operation' (operation_id a
       non-empty string, pid null/absent or a positive integer) or kind 'process'
       (pid a positive integer, no operation_id).
     Identities compare exactly: operation ids as strings, PIDs as integers. */
  const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const opId = value => typeof value === 'string' && value.length > 0;
  const pidOf = value => Number.isSafeInteger(value) && value > 0;
  function processIdentity(process) {
    if (!plain(process) || !pidOf(process.pid)) return null;
    const op = process.operation;
    if (op === null || op === undefined) return {op:null, pid:process.pid};
    return plain(op) && opId(op.id) ? {op:op.id, pid:process.pid} : null;
  }
  function operationIdentity(operation) {
    if (operation === null) return {op:null, pid:null};
    return plain(operation) && opId(operation.id) ? {op:operation.id, pid:null} : null;
  }
  function ownerIdentity(owner) {
    if (owner === null) return {op:null, pid:null};
    if (!plain(owner)) return null;
    if (owner.kind === 'operation') {
      const pid = owner.pid === null || owner.pid === undefined ? null : owner.pid;
      return opId(owner.operation_id) && (pid === null || pidOf(pid)) ? {op:owner.operation_id, pid} : null;
    }
    if (owner.kind === 'process')
      return pidOf(owner.pid) && (owner.operation_id === null || owner.operation_id === undefined) ? {op:null, pid:owner.pid} : null;
    return null;
  }
  /* An owner record named by an answer (a revocation's still_owned entry, a
     refusal's owner): its identity by the same rules as harvest.owner, or null
     when it is not an object, has no kind, or has no or a malformed identity. */
  function ownerRecord(owner) {
    return plain(owner) ? ownerIdentity(owner) : null;
  }
  /* Every ownership record of a status ({processes, harvest}) with its
     identity, or null when any of them is missing or malformed: processes must
     be an array, and harvest must carry both its operation and owner keys. */
  function ownershipRecords(status) {
    if (!plain(status) || !Array.isArray(status.processes)) return null;
    const harvest = status.harvest;
    if (!plain(harvest) || !Object.prototype.hasOwnProperty.call(harvest, 'operation') || !Object.prototype.hasOwnProperty.call(harvest, 'owner')) return null;
    const processes = status.processes.map(processIdentity);
    const operation = operationIdentity(harvest.operation), owner = ownerIdentity(harvest.owner);
    if (processes.some(entry => !entry) || !operation || !owner) return null;
    return {processes, operation, owner, entries:[...processes, operation, owner].filter(entry => entry.op !== null || entry.pid !== null)};
  }
  /* A target an answer named (an operation id or a PID), validated the same
     way; null when it carries neither or a malformed one. */
  function ownerTarget(target) {
    if (!plain(target)) return null;
    const op = target.operation_id === null || target.operation_id === undefined ? null : target.operation_id;
    const pid = target.pid === null || target.pid === undefined ? null : target.pid;
    if ((op !== null && !opId(op)) || (pid !== null && !pidOf(pid)) || (op === null && pid === null)) return null;
    return {op, pid};
  }
  /* "Collecting" is said only when the collector's own report proves it: a
     running operation whose worker is alive, a battle the server marks fresh,
     observing and active, and timestamps that agree with the harvest server
     clock: published_at finite, not after it and at most BATTLE_FRESH_SEC
     (backend/control/harvest.py FRESH_SEC) before it, observation_age_sec
     finite, not negative, within the bound and matching that difference, and no
     recorded collection evidence time after it. Input revoked is not collecting. */
  const BATTLE_FRESH_SEC = 15, CLOCK_SLACK_SEC = 1;
  function collectionConfirmed(harvest) {
    if (!plain(harvest) || harvest.input_revoked === true) return false;
    const now = harvest.server_time, op = harvest.operation, battle = op?.battle;
    if (!finite(now) || !plain(op) || !opId(op.id) || op.status !== 'running' || op.worker_alive !== true) return false;
    if (!plain(battle) || battle.fresh !== true || battle.observation_status !== 'observing' || (battle.status !== undefined && battle.status !== 'active')) return false;
    // the publication the server marked valid, bound to one battle generation
    // (harvest.py battle_view publication_valid; the evidence names the generation it counts)
    if (battle.publication_valid !== true || !opId(battle.id) || !opId(battle.generation)) return false;
    if (op.evidence !== undefined && op.evidence !== null && plain(op.evidence) && op.evidence.generation !== undefined && op.evidence.generation !== battle.generation) return false;
    const at = battle.published_at, age = battle.observation_age_sec;
    if (!finite(at) || at > now || now - at > BATTLE_FRESH_SEC) return false;
    if (!finite(age) || age < 0 || age > BATTLE_FRESH_SEC || Math.abs(now - at - age) > CLOCK_SLACK_SEC) return false;
    const evidence = op.evidence;
    if (evidence !== undefined && evidence !== null) {
      if (!plain(evidence)) return false;
      const times = [evidence.observed_through_at, evidence.started_at,
        ...Object.values(plain(evidence.latest_confirmations) ? evidence.latest_confirmations : {}).map(entry => plain(entry) ? entry.observed_at : NaN)];
      if (times.some(time => time !== undefined && time !== null && (!finite(time) || time > now + CLOCK_SLACK_SEC))) return false;
    }
    return true;
  }
  /* "Ad gems on every 12m, floating gems off" from a saved gem policy (the
     source's policy, or a run's saved routines; same two keys). */
  function gemSettingsText(policy) {
    if (!policy || typeof policy !== 'object') return '';
    const routine = (title, r) => !r || typeof r !== 'object' ? '' : title + (r.enabled === true
      ? ' on' + (interval(r.interval_sec) ? ' every ' + interval(r.interval_sec) : '') : r.enabled === false ? ' off' : ' not set');
    return [routine('Ad gems', policy.ad_gems), routine('floating gems', policy.floating_gems)].filter(Boolean).join(', ');
  }
  function gemsText(gems) {
    const part = (name, value) => name + (flagOf(value) === true ? ' on' : flagOf(value) === false ? ' off' : ' not reported');
    return part('Ad gems', gems?.ad_gems) + ', ' + part('Floating gems', gems?.floating_gems).toLowerCase();
  }
  /* The name an owner record (status harvest.owner, a refusal's owner, a
     revocation's still_owned entry) is known by. */
  function ownerName(owner, runs = {}) {
    if (!owner || typeof owner !== 'object') return 'Another driver';
    // a holder known only by the emulator lease (no script, no PID) is named as unidentified
    if (owner.kind === 'process') return !owner.script && !owner.pid ? 'An unidentified automation process'
      : (owner.script || 'An automation process') + (owner.pid ? ' (PID ' + owner.pid + ')' : '');
    // an accepted operation holds the emulator before its worker exists
    const starting = owner.status === 'accepted';
    if (owner.operation_kind === 'gems') return starting ? 'The diamond collector that is starting'
      : owner.harvest_managed === false ? 'The diamond collector you started' : 'The diamond collector';
    if (owner.operation_kind === 'run') return (owner.selected_run && runs?.[owner.selected_run]?.label) || (starting ? 'The run that is starting' : 'The running automation');
    return 'A ' + (owner.operation_kind || 'running') + ' operation' + (starting ? ' that is starting' : '');
  }
  /* A person's Stop answer (POST /api/operations/<id>/cancel, /api/calibrate/stop):
     {ok, operation:{id, status, revision, error}, stop:{state, reason, holder,
     by_this_request}}; coded 409s distinguish no action from a partial stop.
     (backend/control/operations.py stop_state). Restated, never promoted; an
     answer whose stop does not match the contract, names another operation or
     contradicts its own operation status is unknown. Returns {state, tone, text,
     again (a further Stop may help), inputOff (turning game input off is a way
     out), revision (the operation revision a further Stop must name)}. */
  const STOP_REASONS = ['worker_not_verifiable_lease_free', 'worker_not_verifiable_lease_held', 'worker_not_verifiable_lease_unreadable', 'lease_held_after_stop', 'lease_unreadable_after_stop'];
  const STOP_STATUS = {stopped:['cancelled'], released:['interrupted'], ended:['interrupted', 'succeeded', 'failed'], stopping:['cancelling'], unverified:['cancelling'], active:['accepted', 'running', 'applying']};
  function stopResultView(answer, operationId, runs = {}) {
    const unknown = {state:'unknown', tone:'warn', text:'The answer did not say how the stop stands, so it is not confirmed. Read its current state before stopping again.', again:true, inputOff:true, revision:null};
    if (!plain(answer)) return unknown;
    const current = answer.operation;
    const identified = plain(current) && opId(current.id) && (!operationId || current.id === operationId) && Number.isSafeInteger(current.revision) && current.revision > 0;
    if (identified) unknown.revision = current.revision;
    if (answer.ok === false && ['operation_changed', 'operation_unknown', 'operation_required', 'not_cancellable'].includes(answer.code)) {
      if ('stop' in answer || (current !== null && !identified) || typeof answer.error !== 'string' || !answer.error) return unknown;
      return {...unknown, state:'refused', tone:'bad', inputOff:false, text:`Stop refused: nothing was applied (${answer.error}). Read its current state, then Stop again.`};
    }
    const partial = answer.ok === false && answer.code === 'stop_outcome_partial';
    if ((answer.ok !== true && !partial) || !plain(answer.stop) || !identified) return unknown;
    const op = answer.operation, stop = answer.stop, state = stop.state;
    if (!Array.isArray(STOP_STATUS[state]) || !STOP_STATUS[state].includes(op.status)) return unknown;
    const reason = stop.reason === undefined ? null : stop.reason, holder = stop.holder === undefined ? null : stop.holder;
    if (state === 'unverified' ? !STOP_REASONS.includes(reason) : reason !== null) return unknown;
    if (['worker_not_verifiable_lease_held', 'lease_held_after_stop'].includes(reason) ? holder !== null && !plain(holder) : holder !== null) return unknown;
    const effects = stop.by_this_request;
    if (!plain(effects) || ['paused', 'requested', 'released'].some(key => typeof effects[key] !== 'boolean') ||
        !Array.isArray(effects.signalled) || effects.signalled.some(pid => !Number.isSafeInteger(pid) || pid <= 0) ||
        ![null, 'stopped', 'stopping', 'unverified', 'gone'].includes(effects.family) || (effects.signalled.length && effects.family === null)) return unknown;
    if ((effects.released && effects.signalled.length) || (state === 'ended' && effects.signalled.length && effects.family !== 'stopped')) return unknown;
    const afterStop = ['lease_held_after_stop', 'lease_unreadable_after_stop'].includes(reason);
    if ((effects.released && effects.family === 'stopping') || (afterStop && ['stopping', 'unverified'].includes(effects.family))) return unknown;
    if (partial) {
      const done = [[effects.paused, 'harvesting was paused'], [effects.requested, 'the stop was recorded'],
        [effects.signalled.length, 'processes were signalled'], [effects.released, 'the worker was released']].filter(([taken]) => taken).map(([, text]) => text);
      if (!done.length || typeof answer.error !== 'string' || !answer.error || typeof answer.conflict !== 'string' || !answer.conflict) return unknown;
      return {state:'partial', tone:'warn', again:true, inputOff:true, revision:op.revision,
        text:`Stop partly done: ${done.join(', ')}. Nothing more will be sent automatically. Read its current state, then Stop again.`};
    }
    const released = plain(op.error) && op.error.code === 'worker_released';
    if ((state === 'released') !== (op.status === 'interrupted' && released)) return unknown;
    if ((effects.released && state !== 'released') || (state === 'released' && effects.signalled.length) ||
        (state === 'stopped' && ['stopping', 'unverified'].includes(effects.family)) ||
        (state === 'active' && (effects.requested || effects.signalled.length || effects.released))) return unknown;
    const base = {state, revision:op.revision, again:false, inputOff:false};
    if (state === 'stopped') return {...base, tone:'ok', text:'Stopped: its verified worker family exited, nothing held the emulator, and the operation is cancelled.'};
    if (state === 'released') return {...base, tone:'idle', text:'Closed without signalling any process: its worker could never be verified and nothing held the emulator.'};
    if (state === 'ended') return {...base, tone:'idle', text:effects.signalled.length
      ? 'This Stop stopped the worker; another writer settled the operation.'
      : 'It ended on its own or another writer settled it; this Stop signalled no process.'};
    if (state === 'active') return {...base, tone:'warn', again:true, text:'The server recorded no stop; it is still active.'};
    if (state === 'stopping') return {...base, tone:'warn', again:true, text:'Stop sent; its worker is still exiting, so it is not stopped yet.'};
    const lead = effects.signalled.length ? 'Its worker cannot be verified; this Stop signalled processes, but it stays stopping'
      : 'Its worker cannot be verified, so no process was signalled and it stays stopping';
    if (reason === 'worker_not_verifiable_lease_free') return {...base, tone:'warn', again:true, text:lead + '. Nothing held the emulator when this was checked; Stop again to release it.'};
    if (['worker_not_verifiable_lease_held', 'lease_held_after_stop'].includes(reason)) {
      const name = holder ? ownerName(holder, runs).replace(/^(The|A|An) /, word => word.toLowerCase()) + (holder.foreign === true ? ' from another installation' : '') : 'another process';
      return {...base, tone:'warn', again:true, inputOff:true, text:(reason === 'lease_held_after_stop'
        ? `Its worker is gone, but ${name} still holds the emulator, so the operation stays stopping.`
        : `${lead}, and ${name} holds the emulator.`) + ' End that process, or turn game input off.'};
    }
    if (reason === 'lease_unreadable_after_stop') return {...base, tone:'warn', again:true, inputOff:true,
      text:'Its worker is gone, but who holds the emulator could not be read, so the operation stays stopping. Turn game input off, read its current state, then Stop again.'};
    return {...base, tone:'warn', again:true, inputOff:true, text:lead + ', and who holds the emulator could not be read. End the worker process if you can, or turn game input off.'};
  }
  /* Another driver owns the emulator: what it is and what it publishes about gems. */
  function ownerText(owner) {
    if (!owner || typeof owner !== 'object') return ['Another driver owns the emulator; harvesting waits', 'warn'];
    const name = ownerName(owner);
    if (owner.foreign) return [name + ' from another installation owns the emulator; harvesting waits', 'warn'];
    if (owner.kind === 'process' || owner.operation_kind !== 'run') return [name + ' is using the emulator; harvesting waits', 'warn'];
    const basis = owner.gems?.basis;
    if (basis === 'published_routines') return [name + ' handles gems itself: ' + gemsText(owner.gems), owner.gathers === true ? 'ok' : 'warn'];
    if (basis === 'stale') return [name + ' owns the emulator; its last gem report is stale (' + gemsText(owner.gems) + ')', 'warn'];
    return [name + ' owns the emulator and does not report gem routines', 'warn'];
  }
  /* The per-battle overlay on a running automation, qualified by what that
     driver itself publishes (`owner.gems`): an "already in effect" judged from a
     stale report says so, and an applied choice the driver has not reported yet
     is not presented as its current routines. The battle's own timing stays. */
  function overlayView(overlay, owner = null) {
    if (!overlay || typeof overlay !== 'object') return null;
    const targets = Object.entries(overlay.targets || {}).filter(([, value]) => typeof value === 'boolean');
    const skipped = Object.entries(overlay.skipped || {}).filter(([, why]) => why).map(([name, why]) => label(name) +
      (why === 'live_choice' ? ' kept as set for this battle' : why === 'unsupported' ? ' not supported by this driver'
        : why === 'unchanged' ? ' already as chosen' : ' skipped (' + label(why) + ')'));
    const gems = owner && typeof owner === 'object' ? owner.gems : null;
    const notes = [];
    if (overlay.state === 'not_needed' && gems?.basis === 'stale') notes.push('judged from a stale gem report');
    if (overlay.state === 'applied' && gems?.basis === 'published_routines' &&
        targets.some(([name, value]) => typeof flagOf(gems[name]) === 'boolean' && flagOf(gems[name]) !== value))
      notes.push('the driver has not reported it yet');
    const timing = overlay.cadence_source === 'current_battle' ? "timing stays the battle's own" : '';
    const list = targets.map(([name, value]) => label(name) + (value ? ' on' : ' off')).join(', ');
    return {text:'This battle: harvesting choice' + (list ? ' (' + list + ')' : '') + ' ' + (OVERLAY_STATES[overlay.state] || label(overlay.state || 'unknown')) +
      [...notes, ...skipped, timing].filter(Boolean).map(part => ' \u00b7 ' + part).join(''),
      tone:notes.length ? 'warn' : OVERLAY_TONES[overlay.state] || 'busy'};
  }
  function sourceView(source, desired, runs) {
    const preset = source?.preset || desired?.preset || null;
    if (!preset) return null;
    return {preset, label:source?.label || desired?.label || runs?.[preset]?.label || preset,
      valid:source ? source.valid === true : null, problem:source && source.valid !== true ? source.message || label(source.code || 'invalid') : '',
      settings:gemSettingsText(source?.policy), changed:source?.changed_since_enable === true, edit:source?.edit?.blueprint || null};
  }
  /* The standalone collector's last launch outcome, for a backing-off state. */
  function outcomeText(outcome) {
    if (!outcome || typeof outcome !== 'object' || outcome.kind !== 'exited') return '';
    return 'the last collector exited' + (outcome.status ? ' (' + label(outcome.status).toLowerCase() + ')' : '') +
      (finite(outcome.ran_sec) ? ' after ' + span(outcome.ran_sec) : '');
  }
  /* This dashboard process's harvesting reconciler: not running here, or its
     latest pass failed (the server clears last_error on a successful pass). */
  function hostText(host, serverNow, covered) {
    if (!host || typeof host !== 'object') return '';
    const e = host.last_error;
    const error = e && typeof e === 'object' ? [e.type, e.message].filter(Boolean).join(': ') + (finite(e.at) ? ' (' + span(serverNow - e.at) + ' ago)' : '')
      : e ? String(e) : '';
    if (host.reconciler === 'inactive')
      return covered ? (error ? 'Last reconciler error: ' + error : '')
        : 'This dashboard process is not running the harvesting reconciler, so nothing here starts the collector.' + (error ? ' Last error: ' + error : '');
    return error ? "The harvesting reconciler's latest pass failed: " + error + '.' : '';
  }
  function harvestView({harvest = null, statusError = '', runs = {}, now = Date.now() / 1000} = {}) {
    if (!harvest || typeof harvest !== 'object' || harvest.version !== HARVEST_VERSION) {
      const headline = !harvest ? statusError ? 'Harvesting status unavailable' : 'This server does not report harvesting'
        : 'Harvesting status version ' + (harvest.version ?? 'missing') + ' is not supported by this page';
      return {supported:false, readable:false, choice:'unknown', on:false, headline, tone:'warn', detail:'', source:null, overlay:null, host:'', state:null, code:null, revision:null};
    }
    // records the server could not read report no choice: unknown, never "not turned on"
    const readable = harvestReadable(harvest);
    const desired = readable ? harvest.desired : null;
    const choice = ['on', 'off', 'unset'].includes(desired?.choice) ? desired.choice : 'unknown';
    const on = choice === 'on';
    const serverNow = finite(harvest.server_time) ? harvest.server_time : now;
    const op = readable && harvest.operation && typeof harvest.operation === 'object' ? harvest.operation : null;
    const inactive = harvest.host?.reconciler === 'inactive';
    let state, tone, detail = '', covered = false;
    if (harvest.state === 'off') {
      state = ''; tone = 'idle';
      const why = CHOICE_REASONS[desired?.reason] || (desired?.reason ? label(desired.reason).toLowerCase() : '');
      detail = choice === 'off' ? [why, finite(desired.changed_at) ? clock(desired.changed_at, now) : ''].filter(Boolean).join(' ') : '';
    } else if (harvest.state === 'owned_by_driver') {
      [state, tone] = ownerText(harvest.owner);
    } else {
      [state, tone] = HARVEST_STATES[harvest.state] || ['State ' + label(harvest.state || 'not reported'), 'warn'];
      const battle = op?.battle;
      if (harvest.state === 'starting' && !op && inactive) {
        // due to start, but nothing in this process starts it
        state = 'Collector not started: this dashboard process does not run harvesting'; tone = 'warn'; covered = true;
      } else if (harvest.state === 'collecting' && !collectionConfirmed(harvest)) {
        // "collecting" is said only with its evidence (collectionConfirmed)
        state = harvest.input_revoked === true ? 'Collector running; game input is revoked, so it does not collect' : 'Collector state unknown';
        tone = 'warn'; detail = harvest.input_revoked === true ? '' : "the collector's report does not confirm collection";
      } else if (harvest.state === 'collecting') detail = 'battle observed ' + span(battle.observation_age_sec) + ' ago';
      else if (harvest.state === 'backing_off' && finite(harvest.next_attempt_at))
        detail = ['next attempt in ' + span(harvest.next_attempt_at - serverNow), outcomeText(harvest.last_outcome)].filter(Boolean).join(' \u00b7 ');
      else if (!['starting', 'waiting_for_battle', 'collecting'].includes(harvest.state)) detail = harvest.message || '';
      // a collector the person started with Collect diamonds only
      if (op && op.harvest_managed === false) state += ' (started with Collect diamonds only)';
    }
    const choiceText = on ? 'On' : choice === 'off' ? 'Off' : choice === 'unset' ? 'Not turned on for this emulator' : 'Choice unknown';
    return {supported:true, readable, choice, on, headline:(statusError ? 'Last known \u00b7 ' : '') + choiceText + (state ? ' \u00b7 ' + state : ''), observed:state || '',
      tone:statusError || choice === 'unknown' ? 'warn' : tone, detail, source:readable ? sourceView(harvest.source, desired, runs) : null,
      overlay:readable ? overlayView(harvest.overlay, harvest.owner) : null, host:hostText(harvest.host, serverNow, covered),
      inputRevoked:harvest.input_revoked === true, circuitOpen:readable && harvest.circuit_open === true, collector:!!op, state:harvest.state, code:harvest.code || null,
      revision:finite(desired?.revision) ? desired.revision : null};
  }

  return {clock, span, recordedOwners, holdersUnknownReason, desiredValid, stopResultView, ownerRecord, automationFact, factHTML, processLabel, activity, operationOutcome, harvestView, harvestReadable, processScanFresh, ownershipRecords, ownerTarget, collectionConfirmed, overlayView, ownerName, gemSettingsText, needsScreensHTML, scheduleSummary, lastBattle, lastBattleSummary, nextHTML, attention, attentionHTML};
});
