/* Presentation of recorded workspace state. No requests or game actions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkspaceStatus = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const stepStates = {
    pending:{label:'Waiting', symbol:'○'}, running:{label:'In progress', symbol:'●'},
    done:{label:'Done', symbol:'✓'}, skipped:{label:'Skipped', symbol:'–'},
    needs_attention:{label:'Needs attention', symbol:'!'}, error:{label:'Failed', symbol:'!'},
    stopped:{label:'Stopped', symbol:'■'}, unknown:{label:'Not checked', symbol:'?'},
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const requirements = {
    tools:'Game not needed. The emulator can be closed while connection tools are installed.',
    profile:'Game not needed. This creates or selects saved local settings; it does not log into The Tower.',
    connection:'Emulator required. The Tower can be closed while you connect the emulator.',
    mapping:'Game required while screens are learned. Keep the emulator and The Tower running. Start at Home with no active or resumable battle. Do not close the emulator during any phase.',
    configuration:'Game not needed to review or edit saved runs, equipment settings, schedules, or behaviors.',
    apply:'Game not needed to apply saved discoveries. Wait for screen learning to finish first.',
    observe:'Game required. Show the screen you want to capture; observation only reads it and does not tap.',
    prepare:'Game required for missing battle controls. Keep the emulator and The Tower running at Home; preparation explains any test battle before starting.',
    control:'Game required for automation. Keep the emulator and The Tower running while a driver is active.',
  };
  function requirementHTML(key) {
    return `<p class="game-requirement">${escape(requirements[key])}</p>`;
  }
  function selectOperation(st, basic) {
    const observation = st?.state?.observation;
    let bootstrap = st?.state?.phases?.bootstrap;
    const incompleteMaps = Object.entries(st?.state?.screen_map || {}).filter(([name,row]) => row.status !== 'verified'
      && (bootstrap?.kind !== 'battle' || bootstrap.screens?.includes(name))).map(([name]) => name);
    if (bootstrap?.status === 'done' && incompleteMaps.length) bootstrap = {...bootstrap,status:'needs_attention',
      message:[bootstrap.message,'Incomplete screen maps: '+incompleteMaps.join(', ')+'.'].filter(Boolean).join(' ')};
    const choices = [
      {mode:'bootstrap',record:bootstrap},
      {mode:'basic',record:basic},
      {mode:'observe',record:observation ? {...observation,updated_at:observation.t} : null},
    ];
    if (st?.running || st?.operation) {
      const mode = st.selection?.mode || (st.state?.phases?.bootstrap?.status === 'running' ? 'bootstrap' : 'basic');
      return choices.find(choice => choice.mode === mode) || choices[0];
    }
    const latest = choice => Math.max(choice.record?.updated_at || 0, choice.record?.finished_at || 0,
      ...(choice.record?.history || []).map(event => event.at || 0),
      ...(choice.record?.steps || []).map(step => step.finished_at || step.started_at || 0));
    return choices.filter(choice => choice.record).sort((a,b) => latest(b)-latest(a))[0] || choices[0];
  }
  function duration(seconds) {
    if (!finite(seconds)) return 'Not recorded';
    const n = Math.max(0, Math.floor(seconds));
    if (n < 60) return n + 's';
    if (n < 3600) return Math.floor(n / 60) + 'm ' + n % 60 + 's';
    return Math.floor(n / 3600) + 'h ' + Math.floor(n % 3600 / 60) + 'm';
  }
  function describeSteps(record, running) {
    const steps = (record?.steps || []).map(step => ({...step,
      status:!running && step.status === 'running' ? 'stopped'
        : stepStates[step.status] ? step.status : 'pending'}));
    const count = state => steps.filter(step => step.status === state).length;
    const done = count('done'), skipped = count('skipped'), attention = count('needs_attention');
    return {steps, done, skipped, attention, failed:count('error'),
      processed:done + skipped + attention, total:steps.length,
      active:steps.find(step => step.status === 'running'),
      next:steps.find(step => step.status === 'pending')};
  }
  function phaseGroups(steps) {
    const definitions = [
      ['connection','Check emulator', id => id === 'preflight'],
      ['artwork','Prepare artwork', id => ['extract','map'].includes(id)],
      ['menus','Read menus and inventory', id => id === 'home' || id.startsWith('route_') || id === 'flow_menus'],
      ['battle','Verify battle controls', id => id === 'flow_battle'],
      ['finish','Verify and save', id => id === 'finish'],
    ];
    return definitions.map(([id,label,matches]) => {
      const group = steps.filter(step => matches(String(step.id || '')));
      const state = group.some(step => step.status === 'error') ? 'error'
        : group.some(step => step.status === 'running') ? 'running'
        : group.some(step => step.status === 'needs_attention') ? 'needs_attention'
        : group.some(step => step.status === 'stopped') ? 'stopped'
        : group.every(step => step.status === 'skipped') ? 'skipped'
        : group.every(step => ['done','skipped'].includes(step.status)) ? 'done' : 'pending';
      return {id,label,state,steps:group};
    }).filter(group => group.steps.length);
  }
  function operation({record, attempt, context, finalScreen, setupBattle, running=false, mode='bootstrap', restorePending=false,
                      checkedAt, unavailable='', now=Date.now()/1000, starting=false}) {
    const detail = describeSteps(starting ? null : record, running);
    restorePending = restorePending || attempt?.status === 'restoration_required';
    const terminal = {failed:'error',cancelled:'stopped',interrupted:'stopped',awaiting_apply:'needs_attention',applying:'running'}[attempt?.status];
    const recordedState = record?.status === 'error' ? 'error' : running ? 'running'
      : record?.status === 'running' ? 'stopped'
      : stepStates[record?.status] ? record.status : 'pending';
    const state = starting ? 'running' : restorePending ? 'needs_attention' : terminal ||
      (attempt?.status === 'succeeded' && !['error','stopped','needs_attention'].includes(recordedState) ? 'done' : recordedState);
    const lastAt = record?.updated_at ?? record?.finished_at;
    const finalAt = finite(lastAt) ? lastAt : Math.max(0,
      ...detail.steps.map(step => step.finished_at || 0), ...(record?.history || []).map(event => event.at || 0));
    const startedAt = record?.started_at ?? attempt?.created_at;
    const elapsed = finite(startedAt) && (running || finalAt > 0 || finite(attempt?.updated_at))
      ? duration((running ? unavailable ? checkedAt ?? finalAt : now : finalAt || attempt.updated_at) - startedAt) : 'Not recorded';
    const current = detail.active || detail.steps.find(step => step.status === 'error' || step.status === 'stopped');
    const label = mode === 'observe' ? 'Screen observation' : mode === 'basic' ? 'Targeted profile scan'
      : record?.kind === 'battle' ? 'Battle preparation' : 'Screen learning';
    const headline = starting ? 'Starting screen learning'
      : restorePending ? 'Equipment restoration pending'
      : running ? state === 'error' ? 'Worker active · issue reported' : label + ' in progress'
      : record || attempt ? 'Last ' + label.toLowerCase() + ' result' : 'Screen learning has not started';
    const message = starting ? 'Waiting for the first worker update. Do not start another scan.'
      : restorePending ? 'The saved equipment must be restored before other automation can run.'
      : attempt?.error?.message || (attempt?.status === 'awaiting_apply' ? 'Capture saved. Applying discoveries to the profile is not yet confirmed.' : '')
      || record?.message || current?.message || (running ? 'Waiting for the worker to report its next action.'
        : 'Create a profile and connect the emulator, then learn screens from Overview.');
    const guidance = running ? 'Keep the emulator and The Tower running throughout this operation. Leave the game untouched. Longer phases may report less frequently.'
      : restorePending ? 'Keep the game at Home and review the equipment restoration details below.'
      : attempt?.recovery_action || (state === 'error' || state === 'stopped' ? 'The last attempt is saved. Review its message and connection before choosing a retry.'
      : state === 'done' || state === 'needs_attention' ? 'Review saved discoveries and check readiness for the run you want to use.'
      : 'Learning screens needs Home with no active or resumable battle. It starts only after your confirmation.');
    const target = attempt?.context || context;
    const targetText = target ? [['Emulator',target.instance],['Account',target.account],['Profile',target.profile],['Connection',target.serial]]
      .filter(([,value]) => value).map(([label,value]) => label+': '+value).join(' · ') : '';
    const matchingFinal = !!attempt?.id && finalScreen?.operation_id === attempt.id;
    const returnEvidence = mode === 'bootstrap' && !running && (record || attempt)
      ? matchingFinal && finalScreen.verified === true && finalScreen.name === 'home'
        ? 'Home verified' + (finite(finalScreen.observed_at) ? ' · '+duration(now-finalScreen.observed_at)+' ago' : '')
        : 'Final screen unverified' : '';
    const resetLabels = {starting:'Starting setup test battle',active:'Setup test battle active',ending:'Returning from the setup test battle',finished:'Setup test battle returned to Home',resetting:'Returning from the setup test battle',home_verified:'Setup test battle returned to Home',failed:'Setup test battle return failed',unknown:'Setup test battle state unconfirmed'};
    const resetEvidence = !!attempt?.id && setupBattle?.operation_id === attempt.id && resetLabels[setupBattle.status]
      ? resetLabels[setupBattle.status]+(setupBattle.error || setupBattle.reason ? ': '+(setupBattle.error?.message || setupBattle.error || setupBattle.reason) : '') : '';
    return {...detail,state,label,headline:unavailable ? 'Last known: ' + headline : headline,message,guidance,current,phases:phaseGroups(detail.steps),elapsed,
      workerAge:finite(lastAt) ? duration(now - lastAt) + ' ago' : 'Not recorded',
      checkedAge:finite(checkedAt) ? duration(now - checkedAt) + ' ago' : 'Not checked',
      unavailable, running, saved:!!record || !!attempt, starting,targetText,returnEvidence,resetEvidence};
  }
  function operationHTML(model) {
    const m = model, state = stepStates[m.state];
    return `<section class="operation-summary" aria-label="${escape(m.label)} status">
      <div class="workspace-heading"><h3>${escape(m.headline)}</h3><span class="status-tag status-${escape(m.state)}">${state.symbol} ${state.label}</span></div>
      ${m.unavailable ? `<p class="status-warning" role="status">Status unavailable — showing last known progress; retrying. ${escape(m.unavailable)} <button class="small ghost" onclick="pollCalibrate()">Retry status</button></p>` : ''}
      <p class="operation-message">${escape(m.message)}</p>
      ${m.targetText ? `<p class="muted operation-target">${escape(m.targetText)}</p>` : ''}
      <dl class="operation-metrics"><div><dt>Elapsed${m.running ? '' : ' (saved)'}</dt><dd>${escape(m.elapsed)}</dd></div><div><dt>Last checked</dt><dd>${escape(m.checkedAge)}</dd></div><div><dt>Last worker update</dt><dd>${escape(m.workerAge)}</dd></div></dl>
      ${m.total ? `<p><b>${m.processed} of ${m.total} steps processed</b> · ${m.done} successful${m.skipped ? ` · ${m.skipped} skipped` : ''}${m.attention ? ` · ${m.attention} need attention` : ''}${m.failed ? ` · ${m.failed} failed` : ''}</p>
        <progress value="${m.processed}" max="${m.total}" aria-label="Processed learning steps"></progress>
        <p class="muted">Steps have different durations; this is not a time estimate.</p>` : ''}
      ${m.phases.length ? `<ol class="phase-overview" aria-label="Learning phases">${m.phases.map(phase => `<li class="status-${phase.state}" ${phase.state === 'running' ? 'aria-current="step"' : ''}><span aria-hidden="true">${stepStates[phase.state].symbol}</span><b>${escape(phase.label)}</b><small>${stepStates[phase.state].label}</small></li>`).join('')}</ol>` : ''}
      ${m.current ? `<p><b>Current step:</b> ${escape(m.current.label)}</p>` : ''}
      ${m.current?.units?.total > 0 ? `<p>${escape(m.current.units.label)}: ${escape(m.current.units.completed)} / ${escape(m.current.units.total)}</p>` : ''}
      ${m.running && m.next ? `<p class="muted"><b>Next step:</b> ${escape(m.next.label)}</p>` : ''}
      ${m.returnEvidence ? `<p><b>Final screen:</b> ${escape(m.returnEvidence)}</p>` : ''}
      ${m.resetEvidence ? `<p class="operation-reset">${escape(m.resetEvidence)}</p>` : ''}
      <p class="operation-guidance">${escape(m.guidance)}</p>
      ${!m.running && ['error','stopped'].includes(m.state) ? '<p><a href="#emulators" data-workspace-section="setup-connection">Review emulator connection</a></p>' : ''}
    </section>`;
  }
  // adb server's view of the configured serial (`device_state` from /api/status).
  const connectionStates = {
    device:{label:'Online', note:'adb reports the emulator ready', hint:'adb reports the emulator ready.'},
    offline:{label:'Emulator offline', note:"adb sees the port but Android isn't answering",
      hint:"adb sees the port but Android isn't answering. Wait for the emulator to finish starting or restart it, then Reconnect."},
    unauthorized:{label:'Not authorized', note:'adb is waiting for USB debugging approval',
      hint:'Accept the USB debugging prompt inside the emulator, then Reconnect.'},
    missing:{label:'Not found by adb', note:'adb does not list this emulator', hint:'Start the emulator, then Reconnect.'},
    no_server:{label:'adb server not running', note:'The adb server is not running', hint:'Reconnect asks adb to connect again.'},
    unconfigured:{label:'Not configured', note:'Select an emulator', hint:'Choose your emulator in Setup.'},
    unknown:{label:'Not confirmed', note:"adb did not report this emulator's state", hint:"adb did not report this emulator's state. Reconnect asks adb to connect again."},
  };
  /* Truthful connection projection. `verified` is true only for device_state "device".
     `online` equals `verified`, except that a status without device_state (older
     backend) falls back to its port-only `connected` flag; that case is labelled
     "Not confirmed", never Online. While the dashboard's automatic reconnect is
     trying (`reconnect.state`, absent in older payloads) a non-device state keeps
     its key, note, hint and Reconnect action (the hint is the fix the user can act on:
     the dashboard also retries 'unauthorized', which only the user can resolve) but
     the label reads "Reconnecting to the emulator...", with the attempt count; the
     hint gains a retrying sentence and the last error. The label and hint carry no countdown to the
     next attempt: the renderers rewrite a region whenever its markup changes, and a
     countdown would change it on every status tick. */
  function connectionState(status) {
    if (!status) return {key:'unchecked', label:'Not checked', note:'Connection not checked yet', hint:'Waiting for the first status check.', online:false, verified:false};
    if (typeof status.device_state !== 'string') {
      return status.connected === true
        ? {key:'unknown', label:'Not confirmed', note:'The port answers; adb state not reported', hint:'The configured port answers, but this backend does not report what adb sees.', online:true, verified:false}
        : {key:'unknown', label:'Not reachable', note:'Configured; currently not reachable', hint:'The configured port did not answer. Start the emulator, then Reconnect.', online:false, verified:false};
    }
    const key = connectionStates[status.device_state] ? status.device_state : 'unknown';
    const conn = {key, ...connectionStates[key], online:key === 'device', verified:key === 'device'};
    const retry = status.reconnect;
    if (key === 'device' || retry?.state !== 'trying') return conn;
    return {...conn, label:'Reconnecting to the emulator...' + (retry.attempts > 0 ? ` (attempt ${retry.attempts})` : ''),
      hint:`${conn.hint} The dashboard is also retrying automatically.`
        + (retry.last_error ? ` Last error: ${retry.last_error}` : '')};
  }
  /* The sentence naming why the emulator is not online, for Start blockers and the
     get-started card; no second full stop after a label that already ends in one. */
  const connectionReason = conn => `Emulator: ${conn.label}${conn.label.endsWith('.') ? '' : '.'} ${conn.hint}`;
  /* Reasons every Start action is refused: emulator not online, game input
     disabled. Per-run readiness (which already lists missing navigation screens)
     is checked by the caller. Stop actions never consult this list. */
  function startBlockers({status, config={}}) {
    const inst = config.instances?.[config.active_instance] || {};
    const conn = connectionState(status);
    const out = [];
    if (!conn.online) out.push({id:'connection', text:connectionReason(conn), href:'#emulators', section:'setup-connection', link:'Check the connection'});
    if (!inst.allow_taps) out.push({id:'taps', text:'Game input is disabled. Tick “Allow automation to tap this emulator” in Live control.', href:'#overview', section:'card-runner', link:'Live control'});
    if(status?.process_refresh && status.process_refresh.state!=='fresh')out.push({id:'processes',text:'Automation process state is unconfirmed. Retry status before starting automation.',href:'#overview',section:'card-runner',link:'Live control'});
    return out;
  }
  const reasonHTML = reason => `<li>${escape(reason.text)} <a href="${reason.href}" data-workspace-section="${reason.section}">${escape(reason.link)}</a></li>`;
  /* The panel at the top of Control: the Start blockers plus runs whose readiness
     check reported not ready. Runs without a readiness entry are not listed. */
  function controlBlockersHTML({status, config={}, runs={}, readiness={}}) {
    const blockers = startBlockers({status, config});
    const eligible = Object.keys(runs).filter(name => name !== 'combo');
    const notReady = eligible.filter(name => readiness[name] && readiness[name].ready !== true);
    const reasons = [...blockers];
    if (notReady.length) reasons.push({text:`${notReady.length} of ${eligible.length} runs not ready: ${notReady.map(name => runs[name]?.label || name).join(', ')}.`,
      href:'#screens', section:'run-preparation', link:'Learn screens for a run'});
    const heading = blockers.length ? 'Automation cannot start yet' : notReady.length ? 'Some runs still have screens to learn' : 'Nothing blocks automation';
    return `<div class="workspace-heading"><h3>${heading}</h3></div>
      ${reasons.length ? `<ul class="control-blockers">${reasons.map(reasonHTML).join('')}</ul>` : '<p>Choose a run in Live control and press Start.</p>'}
      <p class="muted">Stop now and Finish current run never depend on these checks.</p>`;
  }
  /* Overview's status summary: emulator, adb connection, automation and run
     readiness. The profile name and Reconnect live in the header (headerHTML). */
  function contextHTML({config={}, status, error='', runs={}, readiness={}, emulators=[]}) {
    const inst = config.instances?.[config.active_instance] || {};
    const running = (status?.processes || []).filter(process => process.runner !== 'calibrate');
    const processState=status?.process_refresh?.state || 'fresh';
    const automation=!status?'Not checked':processState==='unknown'?'Unknown':processState==='stale'?`Last known ${running.length?'running':'idle'}`:running.length?'Running':'Idle';
    const eligible = Object.keys(runs).filter(name => name !== 'combo');
    const checked = eligible.filter(name => readiness[name]);
    const ready = checked.filter(name => readiness[name].ready === true);
    const conn = connectionState(status);
    // wizard/emulators rows (loaded on Setup) name the emulator behind the configured serial
    const detected = emulators.find(row => row.adb_port && `127.0.0.1:${row.adb_port}` === inst.serial);
    const emulatorName = detected ? [detected.emulator, detected.name].filter(Boolean).join(' ') : config.active_instance;
    const blockedReconnect = status?.processes?.length && !['device','unconfigured'].includes(conn.key);
    return `<dl class="workspace-context-grid"><div><dt>Emulator</dt><dd>${escape(emulatorName || 'Not selected')}</dd><small>${escape(inst.serial || 'No connection selected')}</small></div>
      <div><dt>Connection</dt><dd class="${conn.verified ? 'ok' : status ? 'warn' : ''}">${escape(conn.label)}</dd><small>${escape(error ? 'Last known status. ' + conn.hint : conn.hint)}</small>${blockedReconnect ? '<small>Reconnect waits until automation stops; reconnecting can drop its connection.</small>' : ''}${conn.key === 'unconfigured' ? '<a href="#emulators" data-workspace-section="setup-connection">Choose emulator</a>' : ''}</div>
      <div><dt>Automation</dt><dd>${automation}</dd><small>${inst.allow_taps ? 'Game input allowed' : 'Game input disabled'}</small>${processState!=='fresh'?'<button class="small ghost" onclick="loadStatus()">Retry status</button>':''}</div>
      <div><dt>Individual runs</dt><dd>${checked.length ? `${ready.length} of ${eligible.length} ready` : 'Not checked'}</dd><small>${checked.length < eligible.length ? 'Some readiness checks unavailable' : 'Saved-image checks; game can be closed'}</small></div></dl>
      ${error ? `<p class="status-warning" role="status">Live status unavailable; showing the last snapshot. ${escape(error)} <button class="small ghost" onclick="pollDashboard(true)">Retry status</button></p>` : ''}`;
  }
  /* The header: the active profile's name and a compact connection pill with
     the Reconnect action (adb's view of the configured serial, as contextHTML).
     While `reconnecting` (a POST /api/wizard/reconnect is in flight) the action is a
     disabled button, however the label changed since the click. */
  function headerHTML({config={}, accounts={}, status, error='', reconnecting=false}) {
    const profile = (accounts.accounts || []).find(account => account.id === accounts.active);
    const conn = connectionState(status);
    // /api/wizard/reconnect answers 409 while any runner (calibration included) is alive
    const action = conn.key === 'unconfigured' ? '<a href="#emulators" data-workspace-section="setup-connection">Choose emulator</a>'
      : !status || conn.key === 'device' ? ''
      : status.processes?.length ? '<button class="small ghost" disabled title="Stop running automation first; reconnecting can drop its connection.">Reconnect</button>'
      : reconnecting ? '<button class="small ghost" disabled>connecting…</button>'
      : '<button class="small ghost" onclick="reconnect(this)">Reconnect</button>';
    const tone = conn.verified ? 'ok' : status ? 'bad' : 'unknown';
    return `<span class="header-profile">${escape(profile?.label || 'No profile yet')}</span>
      <span class="connection-pill" title="${escape(error ? 'Last known status. ' + conn.hint : conn.hint)}"><span class="dot ${tone}" aria-hidden="true"></span><span class="visually-hidden">Emulator: </span><span>${escape(conn.label)}</span>${action}</span>`;
  }
  /* The live-screen placeholder shown instead of any frame or stream request
     while the emulator is not online (Screens' live screen, Overview's stream). */
  function screenPlaceholderHTML(status) {
    const conn = connectionState(status);
    return `<p class="screen-placeholder" role="status">Live screen unavailable — emulator offline.
        <small>${escape(conn.label)}: ${escape(conn.hint)}</small></p>`;
  }
  function stagesHTML({tools={}, accounts={}, config={}, status, readiness={}, calibration, unavailable=''}) {
    const inst = config.instances?.[config.active_instance] || {};
    const learned = getStarted({tools, accounts, config, status, readiness}).b.done && !calibration?.restore_pending;
    const conn = connectionState(status);
    const stages = [
      {label:'Connection tools', requirement:'Game can be closed', ok:tools.installed === true, note:tools.installed ? 'Installed' : tools.message || 'Install or select connection tools', href:'#setup-tools'},
      {label:'Profile', requirement:'Game can be closed', ok:!!accounts.active, note:accounts.active ? 'Settings saved on this PC' : 'Create a profile for this game', href:'#setup-profile'},
      {label:'Emulator connection', requirement:'Emulator on; game optional', ok:conn.verified && !!inst.serial, note:!inst.serial ? 'Select an emulator' : conn.verified ? 'Online: ' + conn.note : conn.label + ': ' + conn.note, href:'#setup-connection'},
      {label:'Learn screens', requirement:'Keep game and emulator on', ok:learned, note:calibration?.running ? 'Worker active — follow live progress' : learned ? 'At least one run is ready' : calibration?.state?.phases?.bootstrap?.status === 'error' ? 'Last attempt reported an error' : 'Learn screens from Overview', href:'#overview'},
    ];
    const active = stages.findIndex(stage => !stage.ok);
    return `<section class="setup-journey" aria-label="Setup steps"><div class="workspace-heading"><h3>${calibration?.running ? 'Learning screens' : active < 0 ? 'Setup done' : 'Setup overview'}</h3><span class="muted">${stages.filter(stage => stage.ok).length} of ${stages.length} checks satisfied</span></div>
      ${unavailable ? `<p class="status-warning">Status unavailable — these are the last known checks.</p>` : ''}
      <ol class="setup-stages">${stages.map((stage,i) => `<li ${i === active ? 'aria-current="step"' : ''}><a href="${stage.href === '#overview' ? '#overview' : stage.href === '#setup-profile' ? '#profiles' : '#emulators'}" ${stage.href === '#overview' ? '' : `data-workspace-section="${stage.href.slice(1)}"`}><span class="stage-number" aria-hidden="true">${stage.ok ? '✓' : '○'}</span><b>${stage.label}</b><small>${escape(stage.note)}</small><span class="requirement-tag">${stage.requirement}</span></a></li>`).join('')}</ol>
      <p>${calibration?.running ? 'Follow the active operation below. Keep the emulator and game running until learning finishes.' : active === 3 && calibration?.state?.phases?.bootstrap?.status === 'error' ? '<b>Next:</b> review the last learning result and check the emulator connection before retrying.' : active >= 0 ? `<b>Next:</b> ${escape(stages[active].note)}.` : 'Choose a run on <a href="#overview">Overview</a>.'}</p></section>`;
  }
  /* Overview's get-started card, derived from live reads only (no saved
     state). Stage A (configure) is done when tools are installed, a profile is
     active and a serial is configured - not when the emulator is online, so a
     dropped connection never reopens the card. Stage B (learn your game) is done
     when any non-combo run's /api/runs readiness reports ready. */
  function getStarted({tools={}, accounts={}, config={}, status, readiness={}}) {
    const inst = config.instances?.[config.active_instance] || {};
    const runs = Object.entries(readiness).filter(([name]) => name !== 'combo');
    const ready = runs.filter(([, r]) => r?.ready === true).length;
    const a = {tools:tools.installed === true, profile:!!accounts.active, emulator:!!inst.serial};
    a.done = a.tools && a.profile && a.emulator;
    const b = {done:ready > 0, ready, total:runs.length};
    return {a, b, done:a.done && b.done, conn:connectionState(status), serial:inst.serial || ''};
  }
  /* Card markup. The caller supplies the existing profile form, emulator
     suggestion and learning action as HTML; this only arranges them. */
  function getStartedHTML(model, {profileHTML='', emulatorHTML='', learnHTML=''}={}) {
    if (model.done) return '<p class="get-started-done">✓ Setup done · <a href="#profiles">Profiles</a></p>';
    const {a, b, conn} = model;
    const row = (ok, label, detail) => `<li class="${ok ? 'status-done' : ''}"><span aria-hidden="true">${ok ? '✓' : '○'}</span> <b>${label}</b> <span>${detail}</span></li>`;
    return `<div class="workspace-heading"><h2>Get started</h2><span class="muted">${a.done ? 'Configured' : 'Configure, then learn your game'}</span></div>
      <section aria-label="Configure"><h3>Configure</h3><p class="muted">The Tower doesn't need to be open.</p>
      <ul class="get-started-steps">
        ${row(a.tools, 'Connection tools', a.tools ? 'Installed' : '<a href="#emulators" data-workspace-section="setup-tools">Install connection tools</a>')}
        ${row(a.profile, 'Profile', 'Settings saved on this PC')}
        ${row(a.emulator, 'Emulator', a.emulator ? `${escape(conn.label)} <small>${escape(model.serial)}</small>` : 'Not selected yet')}
      </ul>
      ${a.profile ? '' : profileHTML}${a.emulator ? '' : emulatorHTML}</section>
      ${a.done ? `<section aria-label="Learn your game"><h3>Learn your game</h3><p class="muted">Keep The Tower open at Home with no battle running.</p>
        ${b.total ? `<p>${b.ready} of ${b.total} runs ready.</p>` : ''}${learnHTML}</section>` : ''}`;
  }
  return {stepStates, duration, describeSteps, phaseGroups, operation, operationHTML, contextHTML, headerHTML, screenPlaceholderHTML, stagesHTML,requirementHTML,selectOperation,
    connectionState, connectionReason, startBlockers, controlBlockersHTML, getStarted, getStartedHTML};
});
