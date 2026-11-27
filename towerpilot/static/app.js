const $ = (id) => document.getElementById(id);

let lastStatus = null;
let lastRunsLogged = -1;
let lastProfilesStore = null;
let lastMetrics = null;
let lastRunsPayload = null;
let metricsScope = "all_time";
let lastMetricsSig = "";
let lastMetricsFetchTs = 0;
let lastProfileSig = "";
let editingProfileId = null;
let priorityTouched = false;
let pollTimer = null;
let inFlight = 0;
let serverWasOffline = false;
let activeWikiQuery = "";
let activeWikiCategory = "";
let lastAccountSnap = null;
let lastScanState = null;
let lastScanRunning = false;
let lastBattleMenuActive = false;
let lastBattleMenuTask = null;
let scanRequestBusy = false;
let loadoutOwnerFilter = "all";
let loadoutPresetFilter = "";

const KIND_LABELS = {
  farm: "FARM",
  push: "PUSH",
  tournament: "TOURNEY",
};

const DEFAULT_PRIORITIES = {
  farm: 10,
  push: 20,
  tournament: 30,
};

function showToast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.classList.remove("show");
  }, isError ? 2800 : 1600);
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return "";
  const s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

function fmtTime(ts) {
  if (ts === null || ts === undefined) return "--:--:--";
  if (typeof ts === "string" && ts.includes("T")) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toTimeString().slice(0, 8);
    }
  }
  if (!Number.isFinite(Number(ts))) return "--:--:--";
  return new Date(Number(ts) * 1000).toTimeString().slice(0, 8);
}

function fmtInt(val) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return "\u2014";
  return Math.round(Number(val)).toLocaleString();
}

function fmtRate(val) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return "\u2014";
  const n = Number(val);
  if (n <= 0) return "0";
  return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);
}

function kindClass(kind) {
  if (kind === "push" || kind === "tournament" || kind === "farm") return kind;
  return "farm";
}

function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind || "FARM").toUpperCase();
}

function shortPreset(preset, prefix) {
  if (!preset) return "";
  const m = String(preset).match(/(\d+)/);
  return m ? `${prefix}${m[1]}` : `${prefix}:${preset}`;
}

function setPill(el, text, tone) {
  el.className = "pill" + (tone ? " " + tone : "");
  el.textContent = "";
  const dot = document.createElement("span");
  dot.className = "dot";
  el.appendChild(dot);
  el.appendChild(document.createTextNode(text));
}

function setToggle(btn, isOn, variant) {
  btn.textContent = isOn ? "ON" : "OFF";
  btn.className = `toggle-btn ${variant}` + (isOn ? " on" : "");
  btn.setAttribute("aria-pressed", String(isOn));
}

function formatGemStatus(gem, mode) {
  const base = (gem && gem.status) ? String(gem.status) : "idle";
  if (mode === "timer" && gem && gem.enabled && gem.next_timer_sec !== null && gem.next_timer_sec !== undefined) {
    return `${base} \u00b7 next in ${fmtDuration(gem.next_timer_sec)}`;
  }
  return base;
}

function syncInputValue(inputEl, value) {
  if (document.activeElement === inputEl) return;
  const next = value === null || value === undefined ? "" : String(value);
  if (inputEl.value !== next) {
    inputEl.value = next;
  }
}

function syncTimerInput(inputEl, humanEl, value) {
  if (document.activeElement === inputEl) return;
  if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
    const rounded = Math.round(Number(value));
    if (inputEl.value !== String(rounded)) {
      inputEl.value = String(rounded);
    }
    humanEl.textContent = fmtDuration(rounded);
  }
}

function makeInlineWikiButton(label, query, className = "inline-link") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.title = `Open wiki for ${label}`;
  btn.addEventListener("click", () => openWiki(query));
  return btn;
}

function renderActivity(recent) {
  const list = $("activityList");
  list.textContent = "";
  if (!Array.isArray(recent) || recent.length === 0) {
    const li = document.createElement("li");
    li.className = "activity-empty";
    li.textContent = "No recent activity yet.";
    list.appendChild(li);
    return;
  }

  let rows = recent.slice();
  if (rows.length >= 2 && Number(rows[0].ts) < Number(rows[rows.length - 1].ts)) {
    rows = rows.slice(-8).reverse();
  } else {
    rows = rows.slice(0, 8);
  }

  for (const item of rows) {
    const li = document.createElement("li");
    li.className = "activity-item";

    const tsEl = document.createElement("span");
    tsEl.className = "activity-ts";
    tsEl.textContent = fmtTime(item.ts);

    const msgEl = document.createElement("span");
    msgEl.className = "activity-msg";
    msgEl.textContent = item.msg || "";

    li.appendChild(tsEl);
    li.appendChild(msgEl);
    list.appendChild(li);
  }
}

// --- Profiles UI & Slide-over Editor Drawer ----------------------------

function buildProfileSummary(profile, byId) {
  const parts = [];
  const tier = profile.tier || {};
  if (tier.mode === "fixed" && tier.value) {
    parts.push(`T${tier.value}`);
  } else if (tier.mode === "highest_unlocked") {
    parts.push("Max Tier");
  } else if (tier.mode === "ignore" || profile.kind === "tournament") {
    parts.push("Tourney");
  } else {
    parts.push("Curr T");
  }

  const presets = profile.presets || {};
  const cShort = shortPreset(presets.cards, "C");
  const mShort = shortPreset(presets.modules, "M");
  if (cShort) parts.push(cShort);
  if (mShort) parts.push(mShort);

  const runsDone = Number((profile.runtime && profile.runtime.runs_completed) || 0);
  const maxRuns = Number(profile.max_runs || 0);
  if (maxRuns > 0) {
    const runPart = runsDone > 0 ? `${runsDone}/${maxRuns}r` : `${maxRuns}r`;
    const thenProf = profile.then && byId[profile.then];
    if (thenProf) {
      parts.push(`${runPart} -> ${thenProf.name}`);
    } else if (profile.then) {
      parts.push(`${runPart} -> ${profile.then}`);
    } else {
      parts.push(runPart);
    }
  } else if (runsDone > 0) {
    parts.push(`${runsDone}r`);
  }

  const qw = profile.quiet_window || {};
  if (qw.enabled && qw.from && qw.until) {
    parts.push(`Quiet ${qw.from}-${qw.until}`);
  }

  if (!profile.enabled) {
    parts.push("disabled");
  }

  return parts.join(" \u00b7 ");
}

function renderActiveProfileStrip(profileInfo) {
  const info = profileInfo || {};
  const screenEl = $("screenBadge");
  const screen = info.screen ? String(info.screen).toLowerCase() : "unknown";
  screenEl.textContent = screen;
  screenEl.className = "screen-badge" + (screen ? ` ${screen.replace(/[^a-z0-9_-]/g, "")}` : "");

  const kindEl = $("activeKindPill");
  const nameEl = $("activeProfileName");
  const activeName = info.active_name || "";
  const activeKind = info.active_kind || "";
  if (activeName) {
    kindEl.textContent = kindLabel(activeKind);
    kindEl.className = `kind-pill ${kindClass(activeKind)}`;
    kindEl.hidden = false;
    nameEl.textContent = activeName;
    nameEl.title = activeName;
  } else {
    kindEl.hidden = true;
    nameEl.textContent = "\u2014";
    nameEl.title = "";
  }

  const navEl = $("navStateText");
  const navBits = [];
  if (info.nav_state && info.nav_state !== "idle") {
    navBits.push(String(info.nav_state));
  }
  const vc = shortPreset(info.verified_cards, "C");
  const vm = shortPreset(info.verified_modules, "M");
  if (vc) navBits.push(vc);
  if (vm) navBits.push(vm);
  if (navBits.length > 0) {
    navEl.textContent = navBits.join(" \u00b7 ");
    navEl.title = navBits.join(" \u00b7 ");
    navEl.hidden = false;
  } else {
    navEl.textContent = "";
    navEl.hidden = true;
  }

  const queuedRow = $("queuedChipRow");
  if (info.queued_id && info.queued_id !== info.active_id) {
    const qLabel = info.queued_name || info.queued_id;
    $("queuedProfileText").textContent = `Next: ${qLabel}`;
    $("cancelQueuedBtn").dataset.profileId = String(info.queued_id);
    queuedRow.hidden = false;
  } else {
    queuedRow.hidden = true;
    delete $("cancelQueuedBtn").dataset.profileId;
  }
}

function renderProfiles(store) {
  const container = $("profilesList");
  container.textContent = "";
  if (!store || !Array.isArray(store.profiles) || store.profiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ledger-empty";
    empty.textContent = store ? "No profiles configured." : "Profiles unavailable.";
    container.appendChild(empty);
    return;
  }

  const statusProfile = (lastStatus && lastStatus.profile) || {};
  const activeId = statusProfile.active_id || store.active_id || null;
  const queuedId = statusProfile.queued_id !== undefined ? statusProfile.queued_id : (store.queued_id || null);
  const inBattle = Boolean(lastStatus && lastStatus.battle && lastStatus.battle.live);

  const byId = {};
  for (const p of store.profiles) {
    byId[p.id] = p;
  }

  for (const prof of store.profiles) {
    const isActive = prof.id === activeId;
    const isQueued = Boolean(queuedId && prof.id === queuedId && prof.id !== activeId);

    const row = document.createElement("div");
    row.className = "profile-row"
      + (isActive ? " is-active" : "")
      + (isQueued ? " is-queued" : "")
      + (!prof.enabled ? " is-disabled" : "");

    const top = document.createElement("div");
    top.className = "profile-row-top";

    const titleWrap = document.createElement("div");
    titleWrap.className = "profile-row-title";

    const pill = document.createElement("span");
    pill.className = `kind-pill ${kindClass(prof.kind)}`;
    pill.textContent = kindLabel(prof.kind);

    const nameEl = document.createElement("span");
    nameEl.className = "profile-row-name";
    nameEl.textContent = prof.name || prof.id;
    nameEl.title = prof.name || prof.id;

    titleWrap.appendChild(pill);
    titleWrap.appendChild(nameEl);

    const actions = document.createElement("div");
    actions.className = "profile-row-actions";

    const actBtn = document.createElement("button");
    actBtn.type = "button";
    if (isQueued) {
      actBtn.className = "mini-btn amber";
      actBtn.textContent = "Queued";
      actBtn.title = "Queued next \u2014 click to cancel";
      actBtn.addEventListener("click", () => activateProfile(prof.id, "cancel", prof.name));
    } else if (isActive) {
      actBtn.className = "mini-btn green";
      actBtn.textContent = "Active";
      actBtn.disabled = true;
      actBtn.title = "Currently active profile";
    } else {
      actBtn.className = "mini-btn cyan";
      actBtn.textContent = "Run";
      actBtn.title = inBattle ? "Queue for next run (in battle)" : "Switch to this profile now";
      actBtn.addEventListener("click", () => {
        const liveNow = Boolean(lastStatus && lastStatus.battle && lastStatus.battle.live);
        activateProfile(prof.id, liveNow ? "next" : "now", prof.name);
      });
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "mini-btn";
    editBtn.textContent = "Edit";
    editBtn.title = `Edit ${prof.name || prof.id}`;
    editBtn.addEventListener("click", () => openProfileDrawer(prof));

    actions.appendChild(actBtn);
    actions.appendChild(editBtn);

    top.appendChild(titleWrap);
    top.appendChild(actions);

    const summary = document.createElement("div");
    summary.className = "profile-row-summary";
    const summaryText = buildProfileSummary(prof, byId);
    summary.textContent = summaryText;
    summary.title = summaryText;

    row.appendChild(top);
    row.appendChild(summary);
    container.appendChild(row);
  }
}

async function fetchProfiles() {
  try {
    const res = await fetch("/api/profiles", { cache: "no-store" });
    if (!res.ok) {
      if (!lastProfilesStore) renderProfiles(null);
      return;
    }
    const data = await res.json();
    lastProfilesStore = data;
    renderProfiles(data);
  } catch (_) {
    if (!lastProfilesStore) renderProfiles(null);
  }
}

async function activateProfile(profileId, mode, displayName) {
  if (!profileId) return;
  inFlight += 1;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(profileId)}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.store) {
      lastProfilesStore = data.store;
    }
    if (data.status) {
      render(data.status);
    }
    if (lastProfilesStore) {
      renderProfiles(lastProfilesStore);
    }
    const label = displayName || profileId;
    if (mode === "cancel") {
      showToast("Queued profile cancelled");
    } else if (data.store && data.store.active_id === profileId) {
      showToast(`Switched to ${label}`);
    } else if (data.store && data.store.queued_id === profileId) {
      showToast(`Queued next: ${label}`);
    } else if (mode === "now") {
      showToast(`Switched to ${label}`);
    } else {
      showToast(`Queued next: ${label}`);
    }
  } catch (err) {
    showToast(err.message || "Profile switch failed", true);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

function closeProfileDrawer() {
  $("profileDrawer").hidden = true;
  if ($("wikiDrawer").hidden) {
    $("wikiBackdrop").hidden = true;
  }
  editingProfileId = null;
}

function syncProfileDrawerVisibility() {
  $("profTierValueRow").hidden = $("profTierMode").value !== "fixed";
  const quietOn = $("profQuietEnabledBtn").getAttribute("aria-pressed") === "true";
  $("profQuietTimesRow").hidden = !quietOn;
}

function populateThenOptions(excludeId, selectedThen) {
  const sel = $("profThen");
  sel.textContent = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None";
  sel.appendChild(noneOpt);

  const list = (lastProfilesStore && Array.isArray(lastProfilesStore.profiles))
    ? lastProfilesStore.profiles
    : [];
  for (const p of list) {
    if (excludeId && p.id === excludeId) continue;
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    sel.appendChild(opt);
  }
  sel.value = selectedThen || "";
}

function renderProfileRuntimeInfo(profile) {
  const box = $("profRuntimeInfo");
  if (!profile || !profile.runtime) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  const rt = profile.runtime;
  const bits = [`Completed: ${rt.runs_completed ?? 0}r`];
  if (rt.baseline_highest_wave !== null && rt.baseline_highest_wave !== undefined) {
    bits.push(`Baseline W${rt.baseline_highest_wave}`);
  }
  if (rt.last_tourney_cycle) {
    bits.push(`Last cycle: ${rt.last_tourney_cycle}`);
  }
  box.textContent = bits.join(" \u00b7 ");
  box.hidden = false;
}

function openProfileDrawer(profile = null) {
  // Coordinate cleanly with Wiki drawer so only one drawer is open at a time
  $("wikiDrawer").hidden = true;
  $("wikiBackdrop").hidden = false;
  $("profileDrawer").hidden = false;

  const isEdit = Boolean(profile && profile.id);
  editingProfileId = isEdit ? profile.id : null;
  priorityTouched = isEdit;

  $("profileDrawerTitle").textContent = isEdit ? "Edit Profile" : "New Profile";
  const idBadge = $("profileDrawerIdBadge");
  if (isEdit) {
    idBadge.textContent = profile.id;
    idBadge.hidden = false;
  } else {
    idBadge.textContent = "";
    idBadge.hidden = true;
  }

  const kind = (profile && profile.kind) || "farm";
  $("profName").value = (profile && profile.name) || "";
  $("profKind").value = kind;
  $("profPriority").value = String(
    profile && profile.priority !== undefined && profile.priority !== null
      ? profile.priority
      : (DEFAULT_PRIORITIES[kind] || 10)
  );
  setToggle($("profEnabledBtn"), profile ? Boolean(profile.enabled) : true, "flow");

  const tier = (profile && profile.tier) || {};
  const tierMode = tier.mode || (kind === "tournament" ? "ignore" : "current");
  $("profTierMode").value = tierMode;
  $("profTierValue").value = String(tier.value && Number(tier.value) >= 1 ? tier.value : 1);

  const presets = (profile && profile.presets) || {};
  $("profCardsPreset").value = presets.cards || "";
  $("profModulesPreset").value = presets.modules || "";

  $("profMaxRuns").value = String(profile && profile.max_runs !== undefined ? profile.max_runs : 0);
  populateThenOptions(editingProfileId, (profile && profile.then) || "");

  const qw = (profile && profile.quiet_window) || {};
  setToggle($("profQuietEnabledBtn"), Boolean(qw.enabled), "amber");
  $("profQuietFrom").value = qw.from || "23:00";
  $("profQuietUntil").value = qw.until || "07:00";

  syncProfileDrawerVisibility();
  renderProfileRuntimeInfo(isEdit ? profile : null);

  const totalCount = (lastProfilesStore && Array.isArray(lastProfilesStore.profiles))
    ? lastProfilesStore.profiles.length
    : 0;
  $("resetProfileStatsBtn").hidden = !isEdit;
  $("deleteProfileBtn").hidden = !isEdit || totalCount <= 1;

  $("profName").focus();
}

async function saveProfileForm(e) {
  e.preventDefault();
  const name = $("profName").value.trim();
  if (!name || name.length > 40) {
    showToast("Name must be 1\u201340 characters", true);
    $("profName").focus();
    return;
  }

  const kind = $("profKind").value;
  const priority = parseInt($("profPriority").value, 10);
  if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
    showToast("Priority must be 1\u2013100", true);
    $("profPriority").focus();
    return;
  }

  const tierMode = $("profTierMode").value;
  let tierValue = 0;
  if (tierMode === "fixed") {
    tierValue = parseInt($("profTierValue").value, 10);
    if (!Number.isInteger(tierValue) || tierValue < 1 || tierValue > 24) {
      showToast("Fixed tier must be 1\u201324", true);
      $("profTierValue").focus();
      return;
    }
  }

  const maxRuns = parseInt($("profMaxRuns").value || "0", 10);
  if (!Number.isInteger(maxRuns) || maxRuns < 0 || maxRuns > 9999) {
    showToast("Max runs must be 0\u20139999", true);
    $("profMaxRuns").focus();
    return;
  }

  const quietEnabled = $("profQuietEnabledBtn").getAttribute("aria-pressed") === "true";
  const quietFrom = $("profQuietFrom").value || "23:00";
  const quietUntil = $("profQuietUntil").value || "07:00";

  const payload = {
    name,
    kind,
    enabled: $("profEnabledBtn").getAttribute("aria-pressed") === "true",
    priority,
    tier: { mode: tierMode, value: tierValue },
    presets: {
      cards: $("profCardsPreset").value || null,
      modules: $("profModulesPreset").value || null,
    },
    max_runs: maxRuns,
    quiet_window: {
      enabled: quietEnabled,
      from: quietFrom,
      until: quietUntil,
    },
    then: $("profThen").value || null,
  };
  if (editingProfileId) {
    payload.id = editingProfileId;
  }

  const saveBtn = $("saveProfileBtn");
  saveBtn.disabled = true;
  try {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const wasEdit = Boolean(editingProfileId);
    if (data.store) {
      lastProfilesStore = data.store;
      renderProfiles(data.store);
    } else {
      fetchProfiles();
    }
    closeProfileDrawer();
    showToast(wasEdit ? "Profile saved" : "Profile created");
    pollStatus();
  } catch (err) {
    showToast(err.message || "Failed to save profile", true);
  } finally {
    saveBtn.disabled = false;
  }
}

async function resetEditingProfileStats() {
  if (!editingProfileId) return;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(editingProfileId)}/reset`, {
      method: "POST",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.store) {
      lastProfilesStore = data.store;
      renderProfiles(data.store);
    }
    if (data.profile) {
      renderProfileRuntimeInfo(data.profile);
    }
    showToast("Profile stats reset");
  } catch (err) {
    showToast(err.message || "Reset stats failed", true);
  }
}

async function deleteEditingProfile() {
  if (!editingProfileId) return;
  const totalCount = (lastProfilesStore && Array.isArray(lastProfilesStore.profiles))
    ? lastProfilesStore.profiles.length
    : 0;
  if (totalCount <= 1) return;
  try {
    const res = await fetch(`/api/profiles/${encodeURIComponent(editingProfileId)}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.store) {
      lastProfilesStore = data.store;
      renderProfiles(data.store);
    } else {
      fetchProfiles();
    }
    closeProfileDrawer();
    showToast("Profile deleted");
    pollStatus();
  } catch (err) {
    showToast(err.message || "Delete failed", true);
  }
}

// --- Persistent Telemetry & Multi-Iteration Metrics --------------------

function computeProfileGemsPerHour(metrics, bucket) {
  const byProfile = (metrics && metrics.by_profile && typeof metrics.by_profile === "object")
    ? metrics.by_profile
    : {};
  const activeId = (lastStatus && lastStatus.profile && lastStatus.profile.active_id)
    || (metrics && metrics.active_profile && metrics.active_profile.profile_id)
    || null;
  const activeName = (lastStatus && lastStatus.profile && lastStatus.profile.active_name)
    || (metrics && metrics.active_profile && metrics.active_profile.profile_name)
    || null;

  const entries = Object.values(byProfile);
  let matched = null;
  if (activeId) {
    matched = entries.find((e) => e && e.profile_id === activeId) || null;
  }
  if (!matched && activeName) {
    matched = entries.find((e) => e && e.profile_name === activeName) || null;
  }
  if (matched && Number.isFinite(Number(matched.gems_per_hour)) && Number(matched.gems_per_hour) > 0) {
    return `${fmtRate(matched.gems_per_hour)}/hr`;
  }
  if (bucket && Number(bucket.total_duration_sec) > 0 && Number(bucket.total_gems) >= 0) {
    const gph = Number(bucket.total_gems) / (Number(bucket.total_duration_sec) / 3600);
    return `${fmtRate(gph)}/hr`;
  }
  return "\u2014";
}

function renderMetrics(metrics) {
  const totalGemsEl = $("metricTotalGems");
  const runsEl = $("metricRuns");
  const navTapsEl = $("metricNavTaps");
  const gphEl = $("metricGemsPerHour");
  const profileBox = $("metricsByProfileList");

  if (!metrics) {
    totalGemsEl.textContent = "\u2014";
    runsEl.textContent = "\u2014";
    navTapsEl.textContent = "\u2014";
    gphEl.textContent = "\u2014";
    profileBox.textContent = "";
    const empty = document.createElement("div");
    empty.className = "ledger-empty";
    empty.textContent = "Telemetry unavailable.";
    profileBox.appendChild(empty);
    return;
  }

  const bucket = metricsScope === "session"
    ? (metrics.session || {})
    : (metrics.all_time || {});

  const totalGems = bucket.total_gems ?? ((bucket.ad_gems || 0) + (bucket.floating_gems || 0));
  totalGemsEl.textContent = fmtInt(totalGems);
  totalGemsEl.title = `Ad: ${fmtInt(bucket.ad_gems ?? 0)} \u00b7 Floating: ${fmtInt(bucket.floating_gems ?? 0)}`;
  runsEl.textContent = fmtInt(bucket.runs_completed ?? 0);
  runsEl.title = `Restarted: ${fmtInt(bucket.runs_restarted ?? 0)}`;
  navTapsEl.textContent = fmtInt(bucket.nav_taps ?? 0);
  navTapsEl.title = `Holds: ${fmtInt(bucket.holds ?? 0)} \u00b7 Freezes: ${fmtInt(bucket.freezes ?? 0)}`;
  gphEl.textContent = computeProfileGemsPerHour(metrics, bucket);

  profileBox.textContent = "";
  const byProfile = (metrics.by_profile && typeof metrics.by_profile === "object")
    ? Object.values(metrics.by_profile)
    : [];
  byProfile.sort((a, b) => Number((b && b.runs) || 0) - Number((a && a.runs) || 0));

  if (byProfile.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ledger-empty";
    empty.textContent = "Complete a run to see per-profile stats.";
    profileBox.appendChild(empty);
    return;
  }

  for (const row of byProfile.slice(0, 6)) {
    const el = document.createElement("div");
    el.className = "metric-profile-row";

    const left = document.createElement("div");
    left.className = "metric-profile-left";

    const nameSpan = document.createElement("span");
    nameSpan.className = "metric-profile-name";
    nameSpan.textContent = row.profile_name || row.profile_id || "default";
    nameSpan.title = nameSpan.textContent;

    const runsSpan = document.createElement("span");
    runsSpan.style.color = "var(--muted)";
    runsSpan.textContent = `${row.runs ?? 0}r`;

    left.appendChild(nameSpan);
    left.appendChild(runsSpan);

    const right = document.createElement("div");
    right.className = "metric-profile-stats";

    if (row.coins_per_hour_fmt) {
      const cph = document.createElement("span");
      cph.className = "cph-val";
      cph.textContent = `${row.coins_per_hour_fmt}/hr`;
      right.appendChild(cph);
    }

    const gph = document.createElement("span");
    gph.className = "metric-gph";
    gph.textContent = `${fmtRate(row.gems_per_hour ?? 0)} g/hr`;
    gph.title = `${row.total_gems ?? 0} gems (${row.ad_gems ?? 0} ad, ${row.floating_gems ?? 0} float)`;
    right.appendChild(gph);

    el.appendChild(left);
    el.appendChild(right);
    profileBox.appendChild(el);
  }
}

async function fetchMetrics() {
  lastMetricsFetchTs = Date.now();
  try {
    const res = await fetch("/api/metrics", { cache: "no-store" });
    if (!res.ok) {
      if (!lastMetrics) renderMetrics(null);
      return;
    }
    const data = await res.json();
    lastMetrics = data;
    renderMetrics(data);
    // Re-render ledger so per-iteration gem badges stay in sync with metrics
    if (lastRunsPayload) {
      renderLedger(lastRunsPayload);
    } else if (Array.isArray(data.iterations) && data.iterations.length > 0) {
      renderLedger({
        by_tier: Array.isArray(data.by_tier) ? data.by_tier : [],
        runs: data.iterations,
      });
    }
  } catch (_) {
    if (!lastMetrics) renderMetrics(null);
  }
}

// --- Run Ledger & Measured Coins/hr ------------------------------------

function findIterationGems(run) {
  let ad = Number(run.ad_gems || 0);
  let fg = Number(run.floating_gems || 0);
  if (ad > 0 || fg > 0) {
    return { ad, fg, total: ad + fg };
  }
  const iterations = (lastMetrics && Array.isArray(lastMetrics.iterations))
    ? lastMetrics.iterations
    : [];
  if (iterations.length === 0) return null;

  let match = null;
  if (run.iteration_id) {
    match = iterations.find((it) => it && it.iteration_id === run.iteration_id) || null;
  }
  if (!match && (run.iso || run.ts || run.ended_at)) {
    const tsNum = Number(run.ts);
    match = iterations.find((it) => {
      if (!it || it.tier !== run.tier || it.wave !== run.wave) return false;
      if (run.iso && it.ended_at && it.ended_at === run.iso) return true;
      if (run.ended_at && it.ended_at && it.ended_at === run.ended_at) return true;
      if (Number.isFinite(tsNum) && it.ended_at !== null && it.ended_at !== undefined) {
        const itSec = typeof it.ended_at === "string"
          ? Date.parse(it.ended_at) / 1000
          : Number(it.ended_at);
        if (Number.isFinite(itSec) && Math.abs(itSec - tsNum) < 3) return true;
      }
      return false;
    }) || null;
  }
  if (!match) return null;
  ad = Number(match.ad_gems || 0);
  fg = Number(match.floating_gems || 0);
  return (ad + fg) > 0 ? { ad, fg, total: ad + fg } : null;
}

function renderLedger(payload) {
  lastRunsPayload = payload;
  const tierBox = $("tierSummaryList");
  const ledgerList = $("runLedgerList");
  const byTier = Array.isArray(payload && payload.by_tier) ? payload.by_tier : [];
  const runs = Array.isArray(payload && payload.runs) ? payload.runs : [];

  $("ledgerCount").textContent = String(runs.length);

  tierBox.textContent = "";
  if (byTier.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ledger-empty";
    empty.textContent = "Complete a run to measure Coins/hr.";
    tierBox.appendChild(empty);
  } else {
    for (const row of byTier.slice(0, 6)) {
      const el = document.createElement("div");
      el.className = "tier-row";

      const left = document.createElement("div");
      left.className = "tier-row-left";

      left.appendChild(
        makeInlineWikiButton(
          `T${row.tier}${row.tournament ? "+" : ""}`,
          `tier:${row.tier}`,
          "inline-link tier-tag",
        ),
      );

      if (row.profile) {
        const chip = document.createElement("span");
        chip.className = "profile-chip";
        chip.textContent = row.profile;
        chip.title = row.profile;
        left.appendChild(chip);
      }

      const meta = document.createElement("span");
      meta.style.color = "var(--muted)";
      const wavePart = row.avg_wave ? `avg W${row.avg_wave} \u00b7 ` : "";
      meta.textContent = `${wavePart}${row.runs}r`;
      left.appendChild(meta);

      const right = document.createElement("span");
      right.className = "cph-val";
      right.textContent = row.coins_per_hour_fmt ? `${row.coins_per_hour_fmt}/hr` : "\u2014";

      el.appendChild(left);
      el.appendChild(right);
      tierBox.appendChild(el);
    }
  }

  ledgerList.textContent = "";
  if (runs.length === 0) {
    const li = document.createElement("li");
    li.className = "ledger-empty";
    li.textContent = "No completed runs logged yet.";
    ledgerList.appendChild(li);
    return;
  }

  for (const run of runs.slice(0, 20)) {
    const li = document.createElement("li");
    li.className = "ledger-item";

    const top = document.createElement("div");
    top.className = "ledger-top";

    const head = document.createElement("span");
    head.style.fontWeight = "700";
    if (run.tier !== null && run.tier !== undefined) {
      head.appendChild(
        makeInlineWikiButton(`T${run.tier}${run.tournament ? "+" : ""}`, `tier:${run.tier}`),
      );
    } else {
      head.appendChild(document.createTextNode("T?"));
    }
    const wStr = run.wave !== null && run.wave !== undefined ? ` W${run.wave}` : " W?";
    head.appendChild(document.createTextNode(wStr));

    const gemInfo = findIterationGems(run);
    if (gemInfo) {
      const gemBadge = document.createElement("span");
      gemBadge.className = "ledger-gem-badge";
      gemBadge.textContent = `+${gemInfo.total}g`;
      gemBadge.title = `Ad: ${gemInfo.ad} + Floating: ${gemInfo.fg}`;
      head.appendChild(gemBadge);
    }

    const coins = document.createElement("span");
    const totalStr = run.total_coins_raw || "";
    const cphStr = run.coins_per_hour_fmt ? ` (${run.coins_per_hour_fmt}/hr)` : "";
    coins.textContent = totalStr ? `${totalStr}${cphStr}` : "\u2014";
    coins.style.color = run.coins_verified === false ? "var(--amber)" : "var(--green)";

    top.appendChild(head);
    top.appendChild(coins);

    const meta = document.createElement("div");
    meta.className = "ledger-meta";

    const leftMeta = document.createElement("span");
    let hasPart = false;
    if (run.duration_sec) {
      const durSpan = document.createElement("span");
      const exact = run.duration_exact !== false;
      durSpan.textContent = (exact ? "" : "~") + fmtDuration(run.duration_sec);
      if (!exact) {
        durSpan.style.color = "var(--amber)";
        durSpan.title = "Approximate (clipped by restart) \u2014 sync Battle History for exact timing";
      }
      leftMeta.appendChild(durSpan);
      hasPart = true;
    }
    if (run.cells_raw) {
      if (hasPart) leftMeta.appendChild(document.createTextNode(" \u00b7 "));
      leftMeta.appendChild(document.createTextNode(`${run.cells_raw} cells`));
      hasPart = true;
    }
    if (run.killed_by) {
      if (hasPart) leftMeta.appendChild(document.createTextNode(" \u00b7 "));
      leftMeta.appendChild(makeInlineWikiButton(run.killed_by, run.killed_by));
      hasPart = true;
    }
    const profileLabel = run.profile_name || run.profile;
    if (profileLabel) {
      if (hasPart) leftMeta.appendChild(document.createTextNode(" \u00b7 "));
      leftMeta.appendChild(document.createTextNode(`[${profileLabel}]`));
      hasPart = true;
    }
    if (!hasPart) leftMeta.textContent = "\u2014";

    const timeMeta = document.createElement("span");
    if (run.ts !== undefined && run.ts !== null) {
      timeMeta.textContent = fmtTime(run.ts);
    } else if (run.ended_at) {
      timeMeta.textContent = fmtTime(run.ended_at);
    } else if (run.date) {
      timeMeta.textContent = String(run.date);
    } else {
      timeMeta.textContent = "";
    }

    meta.appendChild(leftMeta);
    meta.appendChild(timeMeta);

    li.appendChild(top);
    li.appendChild(meta);
    ledgerList.appendChild(li);
  }
}

async function fetchRuns() {
  try {
    const res = await fetch("/api/runs", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    renderLedger(data);
  } catch (_) {
    // non-fatal
  }
}

// --- Loadout tab (inventory scanner & master catalog) ------------------

const SLOT_LABELS = {
  cannon: "Cannon",
  armor: "Armor",
  generator: "Gen",
  core: "Core",
};

const DEFAULT_PRESET_NAMES = ["Preset 1", "Preset 2", "Preset 3", "Preset 4", "Preset 5"];

function normalizeKey(str) {
  return String(str || "").trim().toLowerCase();
}

function getActiveProfilePresets() {
  const profStatus = (lastStatus && lastStatus.profile) || {};
  let cards = profStatus.verified_cards || null;
  let modules = profStatus.verified_modules || null;
  if ((!cards || !modules) && lastProfilesStore && Array.isArray(lastProfilesStore.profiles)) {
    const activeId = profStatus.active_id || lastProfilesStore.active_id;
    const found = lastProfilesStore.profiles.find((p) => p && p.id === activeId);
    if (found && found.presets) {
      if (!cards && found.presets.cards) cards = found.presets.cards;
      if (!modules && found.presets.modules) modules = found.presets.modules;
    }
  }
  return { cards, modules };
}

function collectPresetNames(snap) {
  const seen = new Set();
  const ordered = [];
  const add = (name) => {
    const s = String(name || "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      ordered.push(s);
    }
  };
  if (snap) {
    if (Array.isArray(snap.presets)) snap.presets.forEach(add);
    if (snap.card_presets && typeof snap.card_presets === "object") {
      Object.keys(snap.card_presets).forEach(add);
    }
    if (snap.module_presets && typeof snap.module_presets === "object") {
      Object.keys(snap.module_presets).forEach(add);
    }
  }
  ordered.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return ordered;
}

function syncPresetFilterDropdown(snap) {
  const sel = $("loadoutPresetFilter");
  const names = new Set(DEFAULT_PRESET_NAMES);
  for (const name of collectPresetNames(snap)) {
    names.add(name);
  }
  const sorted = Array.from(names).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  const currentVal = loadoutPresetFilter;
  sel.textContent = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All Presets";
  sel.appendChild(allOpt);

  for (const name of sorted) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = names.has(currentVal) ? currentVal : "";
  if (sel.value !== loadoutPresetFilter) {
    loadoutPresetFilter = sel.value;
  }
}

function buildPresetMembershipMaps(snap) {
  const cardMap = new Map();
  const modMap = new Map();
  const addTo = (map, key, preset) => {
    const k = normalizeKey(key);
    if (!k) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(preset);
  };

  if (snap && snap.card_presets && typeof snap.card_presets === "object") {
    for (const [preset, entries] of Object.entries(snap.card_presets)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry === "string") {
          addTo(cardMap, entry, preset);
        } else if (entry && typeof entry === "object") {
          if (entry.slug) addTo(cardMap, entry.slug, preset);
          if (entry.name) addTo(cardMap, entry.name, preset);
        }
      }
    }
  }

  if (snap && snap.module_presets && typeof snap.module_presets === "object") {
    for (const [preset, slots] of Object.entries(snap.module_presets)) {
      if (!slots || typeof slots !== "object") continue;
      for (const entry of Object.values(slots)) {
        if (!entry) continue;
        if (typeof entry === "string") {
          addTo(modMap, entry, preset);
        } else if (typeof entry === "object") {
          if (entry.slug) addTo(modMap, entry.slug, preset);
          if (entry.name) addTo(modMap, entry.name, preset);
        }
      }
    }
  }
  return { cardMap, modMap };
}

function resolveEquippedIn(item, category, membershipMaps) {
  const out = new Set();
  if (Array.isArray(item.equipped_in)) {
    for (const p of item.equipped_in) {
      if (p) out.add(String(p));
    }
  }
  const map = category === "card" ? membershipMaps.cardMap : (category === "module" ? membershipMaps.modMap : null);
  if (map) {
    for (const candidate of [item.slug, item.name]) {
      const k = normalizeKey(candidate);
      if (k && map.has(k)) {
        for (const p of map.get(k)) out.add(p);
      }
    }
  }
  return Array.from(out);
}

function getRarityChipClass(item, category) {
  const r = normalizeKey(item.rarity);
  if (category === "card") {
    if (r === "epic") return "card-epic";
    if (r === "rare") return "card-rare";
    return "card-common";
  }
  if (category === "module") {
    if (r.includes("ancestral")) return "mod-ancestral";
    if (r.includes("mythic")) return "mod-mythic";
    if (r.includes("legendary")) return "mod-legendary";
    if (r.includes("epic")) return "mod-epic";
    if (r.includes("rare")) return "mod-rare";
    return "mod-owned";
  }
  if (category === "uw") {
    return "uw-owned";
  }
  return "";
}

function getDetailRarityClass(item, category, detailText) {
  if (item.maxed || /^max$/i.test(detailText)) return "rarity-max";
  const r = normalizeKey(item.rarity || detailText);
  if (category === "module") {
    if (r.includes("ancestral")) return "rarity-ancestral";
    if (r.includes("mythic")) return "rarity-mythic";
    if (r.includes("legendary")) return "rarity-legendary";
    if (r.includes("epic")) return "rarity-epic";
    if (r.includes("rare")) return "rarity-rare";
  }
  return "";
}

function formatCatalogDetail(item, category) {
  if (!item.owned) return "";
  if (category === "card") {
    if (item.maxed) return "Max";
    if (item.stars !== null && item.stars !== undefined && Number(item.stars) > 0) {
      return `${item.stars}\u2605`;
    }
    if (item.level !== null && item.level !== undefined && Number(item.level) > 0) {
      return `Lv.${item.level}`;
    }
    return item.detail ? String(item.detail) : "";
  }
  if (category === "module") {
    const parts = [];
    if (item.level !== null && item.level !== undefined && Number(item.level) > 0) {
      parts.push(`Lv.${item.level}`);
    }
    if (item.rarity) {
      parts.push(String(item.rarity));
    }
    if (parts.length > 0) return parts.join(" ");
    return item.detail ? String(item.detail) : "";
  }
  if (item.detail) return String(item.detail);
  if (item.level !== null && item.level !== undefined && Number(item.level) > 0) {
    return `Lv.${item.level}`;
  }
  return "";
}

function buildItemTooltip(item, category, detailText, equippedIn) {
  const lines = [item.name || item.slug || "Item"];
  const meta = [];
  if (category === "module" && item.slot) {
    meta.push(SLOT_LABELS[normalizeKey(item.slot)] || String(item.slot));
  }
  if (item.rarity) meta.push(String(item.rarity));
  if (detailText && !meta.includes(detailText)) meta.push(detailText);
  meta.push(item.owned ? "Owned" : "Not owned");
  lines.push(meta.join(" \u00b7 "));
  if (equippedIn.length > 0) {
    lines.push(`Equipped: ${equippedIn.join(", ")}`);
  }
  if (Array.isArray(item.substats) && item.substats.length > 0) {
    lines.push(`Substats: ${item.substats.join(", ")}`);
  }
  lines.push("Click to open Wiki");
  return lines.join("\n");
}

const SCAN_PHASE_LABELS = {
  starting: "Starting scan",
  cards: "Scanning Cards",
  modules: "Scanning Modules",
  uws: "Scanning UWs",
  returning: "Returning Home",
};

function formatScanProgress(scan) {
  if (!scan) return "Scanning inventory...";
  const parts = [];
  const phase = scan.phase ? String(scan.phase).trim() : "";
  const phaseKey = phase.toLowerCase();
  const detail = scan.detail ? String(scan.detail).trim() : "";
  const progress = scan.progress ? String(scan.progress).trim() : "";
  if (phase) {
    const mapped = SCAN_PHASE_LABELS[phaseKey];
    if (mapped) {
      parts.push(mapped);
    } else {
      const label = phase.charAt(0).toUpperCase() + phase.slice(1);
      parts.push(/^scanning\b/i.test(label) ? label : `Scanning ${label}`);
    }
  }
  const detailLower = detail.toLowerCase();
  const phaseLabelLower = parts.length > 0 ? parts[0].toLowerCase() : "";
  if (detail && detailLower !== phaseKey && detailLower !== phaseLabelLower) {
    parts.push(detail);
  }
  if (progress && progress !== detail) {
    parts.push(progress);
  }
  return parts.length > 0 ? parts.join(" \u00b7 ") : "Scanning inventory...";
}

function renderScanState(scan) {
  if (scan && typeof scan === "object") {
    lastScanState = scan;
  }
  const s = lastScanState || {};
  const isRunning = Boolean(s.running);
  const isQueued = Boolean(s.queued) && !isRunning;
  const errMsg = !isRunning && !isQueued && s.error ? String(s.error) : "";
  const battleLive = Boolean(lastStatus && lastStatus.battle && lastStatus.battle.live);

  const scanBtn = $("scanInventoryBtn");
  const banner = $("scanBanner");
  const bannerText = $("scanBannerText");
  const cancelBtn = $("cancelScanBtn");

  if (scanRequestBusy) {
    scanBtn.disabled = true;
    scanBtn.className = "primary-btn";
    scanBtn.textContent = "Starting...";
  } else if (isRunning) {
    scanBtn.disabled = true;
    scanBtn.className = "primary-btn";
    scanBtn.textContent = "Scanning...";
  } else if (isQueued) {
    scanBtn.disabled = true;
    scanBtn.className = "primary-btn amber";
    scanBtn.textContent = "Scan Queued";
  } else if (battleLive) {
    scanBtn.disabled = false;
    scanBtn.className = "primary-btn amber";
    scanBtn.textContent = "Queue Scan (Next Boundary)";
    scanBtn.title = "Battle is live \u2014 arm automated scan to run automatically at the next boundary";
  } else {
    scanBtn.disabled = false;
    scanBtn.className = "primary-btn";
    scanBtn.textContent = "Scan Inventory";
    scanBtn.title = "Automated inventory scan across Cards and Modules";
  }

  if (isRunning) {
    banner.className = "alert-banner loadout-scan-banner cyan";
    bannerText.textContent = formatScanProgress(s);
    bannerText.title = bannerText.textContent;
    cancelBtn.hidden = false;
    cancelBtn.className = "mini-btn cyan";
    banner.hidden = false;
  } else if (isQueued) {
    banner.className = "alert-banner loadout-scan-banner amber";
    const qText = (s.detail && /queue|boundary|battle/i.test(String(s.detail)))
      ? String(s.detail)
      : "Scan queued for next boundary";
    bannerText.textContent = qText;
    bannerText.title = qText;
    cancelBtn.hidden = false;
    cancelBtn.className = "mini-btn amber";
    banner.hidden = false;
  } else if (errMsg) {
    banner.className = "alert-banner loadout-scan-banner red";
    bannerText.textContent = `Scan error: ${errMsg}`;
    bannerText.title = bannerText.textContent;
    cancelBtn.hidden = true;
    banner.hidden = false;
  } else {
    banner.hidden = true;
    cancelBtn.hidden = true;
  }
}

function renderCatalogSection(container, items, category, membershipMaps, activePresets) {
  container.textContent = "";
  const list = Array.isArray(items) ? items : [];
  const filtered = list.filter((item) => {
    const owned = Boolean(item && item.owned);
    if (loadoutOwnerFilter === "owned") return owned;
    if (loadoutOwnerFilter === "missing") return !owned;
    return true;
  });

  if (filtered.length === 0) {
    const span = document.createElement("span");
    span.className = "ledger-empty";
    if (list.length === 0) {
      span.textContent = "None observed yet.";
    } else if (loadoutOwnerFilter === "missing") {
      span.textContent = `All ${list.length} owned!`;
    } else if (loadoutOwnerFilter === "owned") {
      span.textContent = "None owned yet.";
    } else {
      span.textContent = "No items.";
    }
    container.appendChild(span);
    return;
  }

  const presetAware = category === "card" || category === "module";
  const activePresetForCat = category === "card" ? activePresets.cards : (category === "module" ? activePresets.modules : null);

  for (const item of filtered) {
    const owned = Boolean(item.owned);
    const equippedIn = resolveEquippedIn(item, category, membershipMaps);
    let isEquipped = false;
    let notInSelectedPreset = false;

    if (presetAware) {
      if (loadoutPresetFilter) {
        isEquipped = equippedIn.includes(loadoutPresetFilter);
        if (!isEquipped) notInSelectedPreset = true;
      } else if (activePresetForCat) {
        isEquipped = equippedIn.includes(activePresetForCat);
      } else {
        isEquipped = equippedIn.length > 0;
      }
    }

    const btn = document.createElement("button");
    btn.type = "button";
    const classes = ["wiki-chip", owned ? "owned" : "unowned"];
    if (owned) {
      const rarityCls = getRarityChipClass(item, category);
      if (rarityCls) classes.push(rarityCls);
    }
    if (isEquipped) classes.push("is-equipped");
    if (notInSelectedPreset) classes.push("not-in-preset");
    btn.className = classes.join(" ");

    if (isEquipped) {
      const eqDot = document.createElement("span");
      eqDot.className = "chip-eq-dot";
      eqDot.textContent = "\u2713";
      eqDot.setAttribute("aria-hidden", "true");
      btn.appendChild(eqDot);
    }

    if (category === "module" && item.slot) {
      const slotKey = normalizeKey(item.slot);
      const slotTag = document.createElement("span");
      slotTag.className = `slot-tag slot-${slotKey.replace(/[^a-z0-9_-]/g, "")}`;
      slotTag.textContent = SLOT_LABELS[slotKey] || String(item.slot);
      btn.appendChild(slotTag);
    }

    btn.appendChild(document.createTextNode(item.name || item.slug || ""));

    const detailText = formatCatalogDetail(item, category);
    if (detailText) {
      const det = document.createElement("span");
      const detRarityCls = getDetailRarityClass(item, category, detailText);
      det.className = "chip-detail" + (detRarityCls ? ` ${detRarityCls}` : "");
      det.textContent = detailText;
      btn.appendChild(det);
    }

    btn.title = buildItemTooltip(item, category, detailText, equippedIn);
    btn.addEventListener("click", () => openWiki(item.slug || item.name));
    container.appendChild(btn);
  }
}

function renderPresetSummary(snap, catalogCards, catalogModules, membershipMaps) {
  const presetsBox = $("loadoutPresets");
  presetsBox.textContent = "";
  const presetNames = collectPresetNames(snap);

  if (presetNames.length === 0) {
    const span = document.createElement("span");
    span.className = "ledger-empty";
    span.textContent = "None scanned yet.";
    presetsBox.appendChild(span);
    return;
  }

  for (const presetName of presetNames) {
    let cardCount = 0;
    if (snap.card_presets && Array.isArray(snap.card_presets[presetName])) {
      cardCount = snap.card_presets[presetName].length;
    } else {
      cardCount = catalogCards.filter((c) => resolveEquippedIn(c, "card", membershipMaps).includes(presetName)).length;
    }

    let modCount = 0;
    if (snap.module_presets && snap.module_presets[presetName] && typeof snap.module_presets[presetName] === "object") {
      modCount = Object.values(snap.module_presets[presetName]).filter(Boolean).length;
    } else {
      modCount = catalogModules.filter((m) => resolveEquippedIn(m, "module", membershipMaps).includes(presetName)).length;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    const isActive = loadoutPresetFilter === presetName;
    btn.className = "preset-summary-pill" + (isActive ? " active" : "");
    btn.setAttribute("aria-pressed", String(isActive));
    btn.appendChild(document.createTextNode(presetName));

    const countParts = [];
    if (cardCount > 0) countParts.push(`${cardCount}C`);
    if (modCount > 0) countParts.push(`${modCount}M`);
    if (countParts.length > 0) {
      const cnt = document.createElement("span");
      cnt.className = "preset-pill-count";
      cnt.textContent = countParts.join(" \u00b7 ");
      btn.appendChild(cnt);
    }

    btn.title = isActive
      ? `Showing ${presetName} \u2014 click to show all presets`
      : `Highlight items equipped in ${presetName}`;
    btn.addEventListener("click", () => {
      loadoutPresetFilter = loadoutPresetFilter === presetName ? "" : presetName;
      $("loadoutPresetFilter").value = loadoutPresetFilter;
      if (lastAccountSnap) renderAccount(lastAccountSnap);
    });
    presetsBox.appendChild(btn);
  }
}

function getSectionCatalog(snap, key, category) {
  if (snap && snap.catalog && Array.isArray(snap.catalog[key]) && snap.catalog[key].length > 0) {
    return snap.catalog[key];
  }
  const fallback = snap && Array.isArray(snap[key]) ? snap[key] : [];
  return fallback.map((item) => ({
    ...item,
    category: item.category || category,
    owned: item.owned !== undefined ? Boolean(item.owned) : true,
  }));
}

function renderAccount(snap) {
  if (!snap) return;
  lastAccountSnap = snap;
  syncPresetFilterDropdown(snap);

  if (snap.scan && typeof snap.scan === "object") {
    renderScanState(snap.scan);
  }

  const catalogCards = getSectionCatalog(snap, "cards", "card");
  const catalogModules = getSectionCatalog(snap, "modules", "module");
  const catalogUws = getSectionCatalog(snap, "uws", "uw");

  const counts = snap.counts || {};
  const cardsOwned = counts.cards_owned ?? catalogCards.filter((i) => i.owned).length;
  const cardsTotal = counts.cards_total ?? catalogCards.length;
  const modsOwned = counts.modules_owned ?? catalogModules.filter((i) => i.owned).length;
  const modsTotal = counts.modules_total ?? catalogModules.length;
  const uwsOwned = counts.uws_owned ?? catalogUws.filter((i) => i.owned).length;
  const uwsTotal = counts.uws_total ?? catalogUws.length;

  $("cardsCount").textContent = cardsTotal > 0 ? `${cardsOwned}/${cardsTotal}` : String(cardsOwned);
  $("modulesCount").textContent = modsTotal > 0 ? `${modsOwned}/${modsTotal}` : String(modsOwned);
  $("uwsCount").textContent = uwsTotal > 0 ? `${uwsOwned}/${uwsTotal}` : String(uwsOwned);

  const slotsBadge = $("cardSlotsBadge");
  if (snap.active_card_slots) {
    slotsBadge.textContent = `${snap.active_card_slots} slots`;
    slotsBadge.hidden = false;
  } else {
    slotsBadge.textContent = "";
    slotsBadge.hidden = true;
  }

  const membershipMaps = buildPresetMembershipMaps(snap);
  const activePresets = getActiveProfilePresets();

  renderCatalogSection($("loadoutCards"), catalogCards, "card", membershipMaps, activePresets);
  renderCatalogSection($("loadoutModules"), catalogModules, "module", membershipMaps, activePresets);
  renderCatalogSection($("loadoutUws"), catalogUws, "uw", membershipMaps, activePresets);
  renderPresetSummary(snap, catalogCards, catalogModules, membershipMaps);

  const metaParts = [];
  if (snap.scan && snap.scan.last_scan_at) {
    metaParts.push(`Scanned ${fmtTime(snap.scan.last_scan_at)}`);
  } else if (snap.updated_at) {
    const screen = snap.last_screen || "screen";
    metaParts.push(`Observed ${screen} at ${fmtTime(snap.updated_at)}`);
  }
  const totalOwned = cardsOwned + modsOwned + uwsOwned;
  if (totalOwned > 0) {
    metaParts.push(`${totalOwned} owned`);
  }
  if (metaParts.length > 0) {
    $("observeMeta").textContent = metaParts.join(" \u00b7 ");
  } else {
    $("observeMeta").textContent = "Scan inventory or open Cards/Modules/UWs and click Observe.";
  }
}

async function fetchAccount() {
  try {
    const res = await fetch("/api/account", { cache: "no-store" });
    if (!res.ok) return;
    renderAccount(await res.json());
  } catch (_) {
    // non-fatal
  }
}

async function scanInventory() {
  scanRequestBusy = true;
  renderScanState(lastScanState);
  try {
    const res = await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "scan", scope: "all", queue_if_battle: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.scan) {
      lastScanRunning = Boolean(data.scan.running);
      renderScanState(data.scan);
    }
    if (data.account) {
      renderAccount(data.account);
    }
    if (data.scan && data.scan.queued) {
      showToast("Scan queued for next boundary");
    } else if (data.scan && data.scan.running) {
      showToast("Inventory scan started");
    } else {
      showToast("Inventory scan complete");
    }
  } catch (err) {
    showToast(err.message || "Scan failed", true);
  } finally {
    scanRequestBusy = false;
    renderScanState(lastScanState);
  }
}

async function cancelInventoryScan() {
  const cancelBtn = $("cancelScanBtn");
  cancelBtn.disabled = true;
  try {
    const res = await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel_scan" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.scan) {
      lastScanRunning = Boolean(data.scan.running);
      renderScanState(data.scan);
    }
    if (data.account) {
      renderAccount(data.account);
    }
    showToast("Scan cancelled");
  } catch (err) {
    showToast(err.message || "Cancel failed", true);
  } finally {
    cancelBtn.disabled = false;
  }
}

async function observeScreen() {
  const btn = $("observeBtn");
  btn.disabled = true;
  btn.textContent = "Observing...";
  try {
    const res = await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "observe" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderAccount(data.account);
    const found = (data.observed && Array.isArray(data.observed.items)) ? data.observed.items.length : 0;
    const screen = (data.observed && data.observed.screen) ? data.observed.screen : "screen";
    showToast(`Observed ${found} item${found === 1 ? "" : "s"} (${screen})`);
  } catch (err) {
    showToast(err.message || "Observe failed", true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Observe";
  }
}

async function resetAccount() {
  try {
    const res = await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderAccount(data.account);
    showToast("Observed loadout cleared");
  } catch (err) {
    showToast(err.message || "Clear failed", true);
  }
}

// --- Contextual Wiki Drawer --------------------------------------------

function closeWiki() {
  $("wikiDrawer").hidden = true;
  if ($("profileDrawer").hidden) {
    $("wikiBackdrop").hidden = true;
  }
}

function closeAllDrawers() {
  $("wikiDrawer").hidden = true;
  $("profileDrawer").hidden = true;
  $("wikiBackdrop").hidden = true;
  editingProfileId = null;
}

async function searchWikiIndex(q, category) {
  const params = new URLSearchParams({ mode: "search", q: q || "" });
  if (category) params.set("category", category);
  try {
    const res = await fetch(`/api/wiki?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const box = $("wikiResults");
    box.textContent = "";
    const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0) {
      const hint = document.createElement("span");
      hint.className = "ledger-empty";
      hint.textContent = q ? `Press Enter to search Fandom for "${q}".` : "Type to search the game index.";
      box.appendChild(hint);
      return;
    }
    for (const item of results.slice(0, 18)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wiki-chip";
      btn.appendChild(document.createTextNode(item.name));
      const cat = document.createElement("span");
      cat.className = "chip-detail";
      cat.textContent = item.category;
      btn.appendChild(cat);
      btn.addEventListener("click", () => loadWikiEntry(item.slug));
      box.appendChild(btn);
    }
  } catch (_) {
    // ignore
  }
}

function renderWikiContent(container, text) {
  container.textContent = "";
  if (!text) {
    const p = document.createElement("div");
    p.className = "ledger-empty";
    p.textContent = "No text excerpt available.";
    container.appendChild(p);
    return;
  }
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("## ")) {
      const h = document.createElement("div");
      h.className = "wiki-heading";
      h.textContent = trimmed.slice(3);
      container.appendChild(h);
    } else if (trimmed.includes(" | ")) {
      const r = document.createElement("div");
      r.className = "wiki-row";
      r.textContent = trimmed;
      container.appendChild(r);
    } else {
      const p = document.createElement("div");
      p.textContent = trimmed;
      container.appendChild(p);
    }
  }
}

async function loadWikiEntry(query, refresh = false) {
  if (!query) return;
  activeWikiQuery = query;
  const article = $("wikiArticle");
  article.hidden = false;
  $("wikiTitle").textContent = "Loading...";
  $("wikiMeta").textContent = "";
  $("wikiContent").textContent = "";
  $("wikiError").hidden = true;
  $("wikiRefreshBtn").hidden = true;
  $("wikiExternalLink").hidden = true;
  $("wikiCachePill").hidden = true;

  const params = new URLSearchParams({ q: query });
  if (refresh) params.set("refresh", "1");
  try {
    const res = await fetch(`/api/wiki?${params.toString()}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    $("wikiTitle").textContent = data.name || query;
    const metaBits = [];
    if (data.category) metaBits.push(data.category.toUpperCase());
    if (Array.isArray(data.aliases) && data.aliases.length > 0) metaBits.push(data.aliases.join(" / "));
    if (data.page_title && data.page_title !== data.name) metaBits.push(`Page: ${data.page_title}`);
    if (data.revid) metaBits.push(`rev ${data.revid}`);
    $("wikiMeta").textContent = metaBits.join(" \u00b7 ");

    const pill = $("wikiCachePill");
    if (data.fetched_at) {
      setPill(pill, data.cached ? "Cached" : "Live", data.cached ? "cyan" : "green");
      pill.hidden = false;
    }

    if (data.url) {
      const link = $("wikiExternalLink");
      link.href = data.url;
      link.hidden = false;
    }
    $("wikiRefreshBtn").hidden = false;

    if (data.error) {
      $("wikiError").textContent = data.error;
      $("wikiError").hidden = false;
    }
    renderWikiContent($("wikiContent"), data.excerpt || "");
  } catch (err) {
    $("wikiTitle").textContent = query;
    $("wikiError").textContent = err.message || "Failed to load wiki";
    $("wikiError").hidden = false;
  }
}

function openWiki(query = "") {
  // Coordinate cleanly with Profile Editor drawer so only one drawer is open at a time
  $("profileDrawer").hidden = true;
  editingProfileId = null;
  $("wikiBackdrop").hidden = false;
  $("wikiDrawer").hidden = false;
  const input = $("wikiSearchInput");
  if (query) {
    const displayQ = String(query).includes(":") ? String(query).split(":").slice(1).join(":").replace(/_/g, " ") : String(query);
    input.value = displayQ;
    searchWikiIndex(displayQ, activeWikiCategory);
    loadWikiEntry(query);
  } else {
    searchWikiIndex(input.value.trim(), activeWikiCategory);
    input.focus();
  }
}

// --- Main status render ------------------------------------------------

function render(data) {
  lastStatus = data;
  $("connPill").hidden = true;

  if (data.version) {
    $("versionTag").textContent = "v" + String(data.version).replace(/^v/i, "");
  }

  // Stream backend + frame size + error
  const stream = data.stream || {};
  const backend = String(stream.backend || "none").toLowerCase();
  if (backend === "mumu") {
    setPill($("backendPill"), "MuMu", "green");
  } else if (backend === "adb") {
    setPill($("backendPill"), "ADB", "cyan");
  } else {
    setPill($("backendPill"), "Offline", "red");
  }

  if (Array.isArray(stream.frame_size) && stream.frame_size.length === 2) {
    const [w, h] = stream.frame_size;
    if (w > 0 && h > 0) {
      $("streamStage").style.aspectRatio = `${w} / ${h}`;
    }
  }

  const streamErr = $("streamError");
  if (stream.error) {
    streamErr.textContent = String(stream.error);
    streamErr.hidden = false;
  } else {
    streamErr.hidden = true;
  }

  // Battle status pill & live run telemetry
  const battle = data.battle || {};
  if (battle.frozen) {
    setPill($("battlePill"), "Frozen", "red");
  } else if (battle.blocker) {
    setPill($("battlePill"), String(battle.blocker), "amber");
  } else if (battle.live) {
    setPill($("battlePill"), "Battle Live", "green");
  } else {
    setPill($("battlePill"), "Waiting", "");
  }

  const tierBtn = $("liveTierBtn");
  if (battle.tier !== null && battle.tier !== undefined) {
    tierBtn.textContent = `T${battle.tier}`;
    tierBtn.disabled = false;
    tierBtn.dataset.tier = String(battle.tier);
  } else {
    tierBtn.textContent = "\u2014";
    tierBtn.disabled = true;
    delete tierBtn.dataset.tier;
  }
  $("liveWave").textContent = battle.wave !== null && battle.wave !== undefined ? String(battle.wave) : "\u2014";
  $("liveElapsed").textContent = battle.elapsed_sec !== null && battle.elapsed_sec !== undefined
    ? fmtDuration(battle.elapsed_sec)
    : "\u2014";
  const liveCphEl = $("liveCoinsPerHour");
  if (liveCphEl) {
    if (battle.live_coins_per_hour_fmt) {
      liveCphEl.textContent = `${battle.live_coins_per_hour_fmt}/hr`;
      liveCphEl.title = battle.coins_raw ? `Balance: ${battle.coins_raw}` : "Live in-run rate";
    } else if (battle.coins_raw) {
      liveCphEl.textContent = `${battle.coins_raw}`;
      liveCphEl.title = `Balance: ${battle.coins_raw} (sampling live Coins/hr\u2026)`;
    } else {
      liveCphEl.textContent = "\u2014";
      liveCphEl.title = "Samples live HUD coin rate during battle";
    }
  }
  $("freezeBanner").hidden = !battle.frozen;

  const stBanner = $("setupTestBanner");
  if (stBanner) {
    const st = data.setup_test || {};
    if (st.active) {
      $("setupTestBannerText").textContent = st.detail ? String(st.detail) : `Setup test: ${st.phase || "running"}`;
      stBanner.hidden = false;
    } else {
      stBanner.hidden = true;
    }
  }

  // Active Profile & Screen Strip
  const profileInfo = data.profile || {};
  renderActiveProfileStrip(profileInfo);

  // Keep profile action buttons & store in sync when active/queued/battle state shifts
  const nextProfileSig = `${profileInfo.active_id || ""}|${profileInfo.queued_id || ""}|${battle.live ? "1" : "0"}`;
  if (nextProfileSig !== lastProfileSig) {
    const changedIds = lastProfileSig.split("|").slice(0, 2).join("|") !== `${profileInfo.active_id || ""}|${profileInfo.queued_id || ""}`;
    lastProfileSig = nextProfileSig;
    if (changedIds) {
      fetchProfiles();
    } else if (lastProfilesStore) {
      renderProfiles(lastProfilesStore);
    }
  }

  // Master harvesting button
  const running = Boolean(data.running);
  const harvestBtn = $("harvestBtn");
  harvestBtn.className = "harvest-btn" + (running ? " on" : "");
  harvestBtn.setAttribute("aria-pressed", String(running));
  $("harvestLabel").textContent = running ? "Gem Harvesting: ON" : "Gem Harvesting: OFF";
  $("harvestBadge").textContent = running ? "RUNNING" : "STOPPED";

  // Collection mode switch
  const mode = data.mode === "timer" ? "timer" : "ocr";
  $("modeHint").textContent = mode === "timer"
    ? "Periodic taps on fixed timer intervals"
    : "OCR & vision detection";
  for (const btn of $("modeSeg").querySelectorAll("button")) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  // Ad Gems row
  const ad = data.ad_gems || {};
  setToggle($("adToggleBtn"), Boolean(ad.enabled), "ad");
  $("adCount").textContent = String(ad.count ?? 0);
  $("adStatus").textContent = formatGemStatus(ad, mode);
  $("adTimerRow").hidden = mode !== "timer";
  syncTimerInput($("adTimerInput"), $("adTimerHuman"), ad.timer_interval_sec);

  // Floating Gems row
  const fg = data.floating_gems || {};
  setToggle($("floatingToggleBtn"), Boolean(fg.enabled), "floating");
  $("floatingCount").textContent = String(fg.count ?? 0);
  $("floatingStatus").textContent = formatGemStatus(fg, mode);
  $("floatingTimerRow").hidden = mode !== "timer";
  syncTimerInput($("floatingTimerInput"), $("floatingTimerHuman"), fg.timer_interval_sec);

  // Run continuity & rules (left sidebar -> Advanced Flow & Guards)
  const flow = data.run_flow || {};
  const rules = data.run_rules || {};
  setToggle($("autoHomeBtn"), Boolean(flow.auto_home), "flow");
  setToggle($("autoRetryBtn"), Boolean(flow.auto_retry), "flow");
  setToggle($("autoBattleBtn"), Boolean(flow.auto_battle), "flow");
  setToggle($("autoResumeBtn"), Boolean(flow.auto_resume), "flow");
  setToggle($("finishStopBtn"), Boolean(rules.finish_and_stop), "amber");
  setToggle($("noStartBtn"), Boolean(rules.no_start_enabled), "amber");
  setToggle($("notifyDeathBtn"), Boolean(rules.notify_on_death), "flow");

  $("runsRestarted").textContent = String(flow.runs_restarted ?? 0);
  $("flowStatus").textContent = flow.status ? String(flow.status) : "off";

  syncInputValue($("expectedTierInput"), rules.expected_tier ?? 0);
  syncInputValue($("maxRunsInput"), rules.max_runs ?? 0);
  syncInputValue($("noStartFrom"), rules.no_start_from || "23:00");
  syncInputValue($("noStartUntil"), rules.no_start_until || "07:00");
  $("noStartTimesRow").hidden = !rules.no_start_enabled;
  syncInputValue($("freezeMinInput"), rules.freeze_timeout_min ?? 10);

  // Summary badge for collapsible Advanced Flow & Guards
  const enabledFlowCount = [flow.auto_home, flow.auto_retry, flow.auto_battle, flow.auto_resume].filter(Boolean).length;
  const advBadge = $("advancedFlowSummaryBadge");
  if (rules.finish_and_stop) {
    advBadge.textContent = "hold after run";
    advBadge.className = "flow-summary-badge amber";
  } else if (enabledFlowCount > 0) {
    advBadge.textContent = `${enabledFlowCount} active`;
    advBadge.className = "flow-summary-badge green";
  } else {
    advBadge.textContent = "off";
    advBadge.className = "flow-summary-badge";
  }

  // Sidebar status pill + hold banner
  const anyFlow = enabledFlowCount > 0;
  const holding = Boolean(flow.holding);
  const holdBanner = $("holdBanner");
  const resumeBtn = $("resumeHoldBtn");
  if (holding) {
    setPill($("sidebarStatePill"), "Holding", "amber");
    $("holdBannerText").textContent = flow.status ? String(flow.status) : "Holding at Home";
    holdBanner.hidden = false;
    resumeBtn.hidden = !(
      flow.hold_reason === "finish_and_stop"
      || flow.hold_reason === "max_runs"
      || flow.hold_reason === "tier_mismatch"
    );
  } else if (battle.frozen) {
    setPill($("sidebarStatePill"), "Frozen", "red");
    holdBanner.hidden = true;
  } else if (running && anyFlow) {
    setPill($("sidebarStatePill"), rules.finish_and_stop ? "Finishing" : "Active", rules.finish_and_stop ? "amber" : "green");
    holdBanner.hidden = true;
  } else {
    setPill($("sidebarStatePill"), anyFlow ? "Paused" : "Passive", "");
    holdBanner.hidden = true;
  }

  // Refresh run ledger, profiles, and telemetry metrics on run/telemetry changes
  const logged = Number(flow.runs_logged ?? 0);
  const telemetry = data.telemetry || {};
  const nextMetricsSig = `${telemetry.all_time_gems ?? ""}|${telemetry.all_time_runs ?? ""}|${telemetry.iteration_id ?? ""}|${logged}|${flow.runs_restarted ?? 0}`;
  const metricsStale = (Date.now() - lastMetricsFetchTs) > 10000;

  if (logged !== lastRunsLogged) {
    lastRunsLogged = logged;
    fetchRuns();
    fetchProfiles();
    lastMetricsSig = nextMetricsSig;
    fetchMetrics();
  } else if (nextMetricsSig !== lastMetricsSig || metricsStale) {
    lastMetricsSig = nextMetricsSig;
    fetchMetrics();
  }

  // Live inventory scan status & auto-refresh when scan finishes (true -> false)
  if (data.scan && typeof data.scan === "object") {
    const isRunning = Boolean(data.scan.running);
    renderScanState(data.scan);
    if (lastScanRunning && !isRunning) {
      fetchAccount();
      if (data.scan.error) {
        showToast(String(data.scan.error), true);
      } else if (data.scan.phase === "done") {
        showToast("Inventory scan complete");
      }
    }
    lastScanRunning = isRunning;
  } else {
    renderScanState(null);
  }

  // Live Battle Menu routines (auto toggles + on-demand status)
  const routinesCfg = data.routines || {};
  if ($("autoSyncHistoryBtn")) {
    setToggle($("autoSyncHistoryBtn"), Boolean(routinesCfg.auto_sync_history), "flow");
  }
  if ($("autoClaimDailyBtn")) {
    setToggle($("autoClaimDailyBtn"), Boolean(routinesCfg.auto_claim_daily), "flow");
  }
  if ($("autoClaimGuildBtn")) {
    setToggle($("autoClaimGuildBtn"), Boolean(routinesCfg.auto_claim_guild), "flow");
  }
  const bm = data.battle_menu || {};
  const bmActive = Boolean(bm.active);
  const bmPill = $("battleMenuPill");
  const bmBanner = $("battleMenuBanner");
  if (bmPill) {
    if (bmActive) {
      setPill(bmPill, bm.task ? String(bm.task).replace(/_/g, " ") : "Running", "cyan");
    } else if (bm.error) {
      setPill(bmPill, "Error", "amber");
    } else {
      setPill(bmPill, "Idle", "");
    }
  }
  if (bmBanner) {
    if (bmActive) {
      $("battleMenuBannerText").textContent = bm.detail ? String(bm.detail) : "Running Battle Menu routine\u2026";
      bmBanner.hidden = false;
    } else {
      bmBanner.hidden = true;
    }
  }
  if ($("historySyncMeta")) {
    const hCount = Number(bm.history_count || 0);
    $("historySyncMeta").textContent = hCount > 0
      ? `${hCount} runs synced \u00b7 exact timings & Coins/hr`
      : "Authoritative timings & Coins/hr";
  }
  for (const id of ["syncHistoryBtn", "runHistoryBtn", "runDailyBtn", "runGuildBtn", "runCardsBtn", "runModulesBtn", "inBattleCardsBtn", "inBattleModulesBtn"]) {
    const b = $(id);
    if (b) b.disabled = bmActive;
  }
  if (lastBattleMenuActive && !bmActive) {
    if (bm.error) {
      showToast(String(bm.error), true);
    } else if (bm.last_result && bm.last_result.summary) {
      showToast(String(bm.last_result.summary));
    }
    if (lastBattleMenuTask === "history") {
      fetchRuns();
      fetchMetrics();
    } else if (lastBattleMenuTask === "cards" || lastBattleMenuTask === "modules") {
      fetchAccount();
    }
  }
  lastBattleMenuActive = bmActive;
  if (bmActive) {
    lastBattleMenuTask = bm.task || null;
  }

  renderActivity(data.recent);
}

async function postJson(url, payload, toastLabel) {
  inFlight += 1;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    render(data);
    if (toastLabel) showToast(toastLabel);
  } catch (err) {
    showToast(err.message || "Update failed", true);
    if (lastStatus) render(lastStatus);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

function updateHarvest(payload, toastLabel) {
  return postJson("/api/harvest", payload, toastLabel);
}

function updateRunRules(payload, toastLabel) {
  return postJson("/api/run-rules", payload, toastLabel);
}

function updateRoutines(payload, toastLabel) {
  return postJson("/api/routines", payload, toastLabel);
}

async function runBattleMenuRoutine(task, label) {
  inFlight += 1;
  try {
    const res = await fetch("/api/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run", task }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.status) render(data.status);
    showToast(`Started ${label}`);
  } catch (err) {
    showToast(err.message || `Failed to start ${label}`, true);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (serverWasOffline) {
      serverWasOffline = false;
      $("streamImg").src = "/api/stream.mjpg?t=" + Date.now();
      fetchProfiles();
      fetchMetrics();
      fetchAccount();
    }
    if (inFlight === 0) {
      render(data);
    }
  } catch (_) {
    serverWasOffline = true;
    const conn = $("connPill");
    setPill(conn, "Server Offline", "red");
    conn.hidden = false;
  } finally {
    pollTimer = setTimeout(pollStatus, 1000);
  }
}

// Sidebar tabs (Runs | Loadout)
function selectSidebarTab(tabName) {
  const isLoadout = tabName === "loadout";
  $("tabRuns").hidden = isLoadout;
  $("tabLoadout").hidden = !isLoadout;
  for (const btn of $("sidebarTabs").querySelectorAll("button[data-tab]")) {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  if (isLoadout) fetchAccount();
}

$("sidebarTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (btn) selectSidebarTab(btn.dataset.tab);
});

// Collapsible left sidebar state
function setSidebarCollapsed(collapsed) {
  const grid = $("layoutGrid");
  const btn = $("collapseSidebarBtn");
  grid.classList.toggle("sidebar-collapsed", collapsed);
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.title = collapsed ? "Expand panel" : "Collapse panel";
  btn.textContent = collapsed ? "\u00bb" : "\u00ab";
  try {
    localStorage.setItem("tp_sidebar_collapsed", collapsed ? "1" : "0");
  } catch (_) {
    // ignore
  }
}

try {
  if (localStorage.getItem("tp_sidebar_collapsed") === "1") {
    setSidebarCollapsed(true);
  }
  if (localStorage.getItem("tp_advanced_flow_open") === "1") {
    $("advancedFlowDetails").open = true;
  }
} catch (_) {
  // ignore
}

$("collapseSidebarBtn").addEventListener("click", () => {
  const collapsed = $("layoutGrid").classList.contains("sidebar-collapsed");
  setSidebarCollapsed(!collapsed);
});

$("advancedFlowDetails").addEventListener("toggle", () => {
  try {
    localStorage.setItem("tp_advanced_flow_open", $("advancedFlowDetails").open ? "1" : "0");
  } catch (_) {
    // ignore
  }
});

// Profiles & Profile Drawer bindings
$("newProfileBtn").addEventListener("click", () => openProfileDrawer(null));
$("cancelQueuedBtn").addEventListener("click", () => {
  const qid = $("cancelQueuedBtn").dataset.profileId
    || (lastStatus && lastStatus.profile && lastStatus.profile.queued_id);
  if (qid) activateProfile(qid, "cancel", "");
});
$("closeProfileDrawerBtn").addEventListener("click", closeProfileDrawer);
$("profileForm").addEventListener("submit", saveProfileForm);
$("resetProfileStatsBtn").addEventListener("click", resetEditingProfileStats);
$("deleteProfileBtn").addEventListener("click", deleteEditingProfile);

$("profEnabledBtn").addEventListener("click", () => {
  const next = $("profEnabledBtn").getAttribute("aria-pressed") !== "true";
  setToggle($("profEnabledBtn"), next, "flow");
});

$("profQuietEnabledBtn").addEventListener("click", () => {
  const next = $("profQuietEnabledBtn").getAttribute("aria-pressed") !== "true";
  setToggle($("profQuietEnabledBtn"), next, "amber");
  syncProfileDrawerVisibility();
});

$("profTierMode").addEventListener("change", syncProfileDrawerVisibility);

$("profPriority").addEventListener("input", () => {
  priorityTouched = true;
});

$("profKind").addEventListener("change", () => {
  const kind = $("profKind").value;
  if (!priorityTouched) {
    $("profPriority").value = String(DEFAULT_PRIORITIES[kind] || 10);
  }
  if (!editingProfileId) {
    if (kind === "tournament") {
      $("profTierMode").value = "ignore";
    } else if (kind === "push") {
      $("profTierMode").value = "highest_unlocked";
    } else {
      $("profTierMode").value = "current";
    }
    syncProfileDrawerVisibility();
  }
});

// Telemetry scope toggle bindings
$("metricsScopeToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-scope]");
  if (!btn) return;
  metricsScope = btn.dataset.scope === "session" ? "session" : "all_time";
  for (const b of $("metricsScopeToggle").querySelectorAll("button[data-scope]")) {
    const active = b.dataset.scope === metricsScope;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  }
  if (lastMetrics) renderMetrics(lastMetrics);
});

// Wiki & Drawer shared bindings
$("openWikiBtn").addEventListener("click", () => openWiki(""));
$("closeWikiBtn").addEventListener("click", closeWiki);
$("wikiBackdrop").addEventListener("click", closeAllDrawers);
$("wikiRefreshBtn").addEventListener("click", () => {
  if (activeWikiQuery) loadWikiEntry(activeWikiQuery, true);
});
$("wikiSearchInput").addEventListener("input", () => {
  searchWikiIndex($("wikiSearchInput").value.trim(), activeWikiCategory);
});
$("wikiSearchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const q = $("wikiSearchInput").value.trim();
    if (q) loadWikiEntry(q);
  }
});
$("wikiCats").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  activeWikiCategory = btn.dataset.cat || "";
  for (const b of $("wikiCats").querySelectorAll("button[data-cat]")) {
    b.classList.toggle("active", b === btn);
  }
  searchWikiIndex($("wikiSearchInput").value.trim(), activeWikiCategory);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("profileDrawer").hidden || !$("wikiDrawer").hidden) {
      closeAllDrawers();
    }
  }
});

// Loadout & Battle Menu routine bindings
$("scanInventoryBtn").addEventListener("click", scanInventory);
$("cancelScanBtn").addEventListener("click", cancelInventoryScan);
if ($("inBattleCardsBtn")) {
  $("inBattleCardsBtn").addEventListener("click", () => runBattleMenuRoutine("cards", "Cards scan"));
}
if ($("inBattleModulesBtn")) {
  $("inBattleModulesBtn").addEventListener("click", () => runBattleMenuRoutine("modules", "Modules scan"));
}
if ($("syncHistoryBtn")) {
  $("syncHistoryBtn").addEventListener("click", () => runBattleMenuRoutine("history", "Battle History sync"));
}
if ($("runHistoryBtn")) {
  $("runHistoryBtn").addEventListener("click", () => runBattleMenuRoutine("history", "Battle History sync"));
}
if ($("runDailyBtn")) {
  $("runDailyBtn").addEventListener("click", () => runBattleMenuRoutine("daily_quests", "Daily Quests check"));
}
if ($("runGuildBtn")) {
  $("runGuildBtn").addEventListener("click", () => runBattleMenuRoutine("guild_rewards", "Guild Rewards check"));
}
if ($("runCardsBtn")) {
  $("runCardsBtn").addEventListener("click", () => runBattleMenuRoutine("cards", "Cards scan"));
}
if ($("runModulesBtn")) {
  $("runModulesBtn").addEventListener("click", () => runBattleMenuRoutine("modules", "Modules scan"));
}
if ($("cancelBattleMenuBtn")) {
  $("cancelBattleMenuBtn").addEventListener("click", () => {
    fetch("/api/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.status) render(d.status);
        showToast("Battle Menu routine cancelled");
      })
      .catch(() => showToast("Cancel failed", true));
  });
}
if ($("autoSyncHistoryBtn")) {
  $("autoSyncHistoryBtn").addEventListener("click", () => {
    const next = !(lastStatus && lastStatus.routines && lastStatus.routines.auto_sync_history);
    updateRoutines({ auto_sync_history: next }, next ? "Auto Sync History ON" : "Auto Sync History OFF");
  });
}
if ($("autoClaimDailyBtn")) {
  $("autoClaimDailyBtn").addEventListener("click", () => {
    const next = !(lastStatus && lastStatus.routines && lastStatus.routines.auto_claim_daily);
    updateRoutines({ auto_claim_daily: next }, next ? "Auto Claim Daily Quests ON" : "Auto Claim Daily Quests OFF");
  });
}
if ($("autoClaimGuildBtn")) {
  $("autoClaimGuildBtn").addEventListener("click", () => {
    const next = !(lastStatus && lastStatus.routines && lastStatus.routines.auto_claim_guild);
    updateRoutines({ auto_claim_guild: next }, next ? "Auto Claim Guild Rewards ON" : "Auto Claim Guild Rewards OFF");
  });
}
if ($("cancelSetupTestBtn")) {
  $("cancelSetupTestBtn").addEventListener("click", () => {
    postJson("/api/setup-test", { action: "cancel" }, "Setup test cancelled");
  });
}
$("observeBtn").addEventListener("click", observeScreen);
$("resetAccountBtn").addEventListener("click", resetAccount);
$("loadoutOwnerFilter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  const next = btn.dataset.filter;
  if (next !== "all" && next !== "owned" && next !== "missing") return;
  loadoutOwnerFilter = next;
  for (const b of $("loadoutOwnerFilter").querySelectorAll("button[data-filter]")) {
    const active = b.dataset.filter === loadoutOwnerFilter;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  }
  if (lastAccountSnap) renderAccount(lastAccountSnap);
});
$("loadoutPresetFilter").addEventListener("change", () => {
  loadoutPresetFilter = $("loadoutPresetFilter").value || "";
  if (lastAccountSnap) renderAccount(lastAccountSnap);
});
$("liveTierBtn").addEventListener("click", () => {
  const t = $("liveTierBtn").dataset.tier;
  if (t) openWiki(`tier:${t}`);
});

// Harvesting bindings
$("harvestBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.running);
  updateHarvest({ running: next });
});

$("modeSeg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (lastStatus && lastStatus.mode === mode) return;
  updateHarvest({ mode });
});

$("adToggleBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.ad_gems && lastStatus.ad_gems.enabled);
  updateHarvest({ ad_gems: { enabled: next } });
});

$("floatingToggleBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.floating_gems && lastStatus.floating_gems.enabled);
  updateHarvest({ floating_gems: { enabled: next } });
});

// Runs sidebar bindings
$("autoHomeBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_flow && lastStatus.run_flow.auto_home);
  updateRunRules({ run_flow: { auto_home: next } });
});

$("autoRetryBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_flow && lastStatus.run_flow.auto_retry);
  updateRunRules({ run_flow: { auto_retry: next } });
});

$("autoBattleBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_flow && lastStatus.run_flow.auto_battle);
  updateRunRules({ run_flow: { auto_battle: next } });
});

$("autoResumeBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_flow && lastStatus.run_flow.auto_resume);
  updateRunRules({ run_flow: { auto_resume: next } });
});

$("resetRunsBtn").addEventListener("click", () => {
  updateRunRules({ action: "reset_run_count" }, "Run counter reset");
});

$("finishStopBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_rules && lastStatus.run_rules.finish_and_stop);
  updateRunRules({ finish_and_stop: next }, next ? "Will hold at Home after this run" : "Hold cleared");
});

$("resumeHoldBtn").addEventListener("click", () => {
  const reason = lastStatus && lastStatus.run_flow && lastStatus.run_flow.hold_reason;
  if (reason === "finish_and_stop") {
    updateRunRules({ finish_and_stop: false }, "Resuming auto-restart");
  } else if (reason === "max_runs") {
    updateRunRules({ action: "reset_run_count" }, "Counter reset \u2014 resuming");
  } else if (reason === "tier_mismatch") {
    updateRunRules({ expected_tier: 0 }, "Expected tier cleared");
  }
});

$("noStartBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_rules && lastStatus.run_rules.no_start_enabled);
  updateRunRules({ no_start_enabled: next });
});

$("notifyDeathBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_rules && lastStatus.run_rules.notify_on_death);
  updateRunRules({ notify_on_death: next });
});

function bindCommitInput(inputEl, handler) {
  inputEl.addEventListener("change", handler);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      inputEl.blur();
    }
  });
}

bindCommitInput($("expectedTierInput"), () => {
  const val = parseInt($("expectedTierInput").value, 10);
  if (!Number.isInteger(val) || val < 0 || val > 24) {
    showToast("Expected tier must be 0\u201324", true);
    if (lastStatus) render(lastStatus);
    return;
  }
  updateRunRules({ expected_tier: val }, val === 0 ? "Expected tier: any" : `Expected tier: T${val}`);
});

bindCommitInput($("maxRunsInput"), () => {
  const val = parseInt($("maxRunsInput").value, 10);
  if (!Number.isInteger(val) || val < 0 || val > 9999) {
    showToast("Max runs must be 0\u20139999", true);
    if (lastStatus) render(lastStatus);
    return;
  }
  updateRunRules({ max_runs: val }, val === 0 ? "Max runs: unlimited" : `Max runs: ${val}`);
});

bindCommitInput($("freezeMinInput"), () => {
  const val = parseInt($("freezeMinInput").value, 10);
  if (!Number.isInteger(val) || val < 0 || val > 180) {
    showToast("Freeze alert must be 0\u2013180 min", true);
    if (lastStatus) render(lastStatus);
    return;
  }
  updateRunRules({ freeze_timeout_min: val }, val === 0 ? "Freeze alert off" : `Freeze alert: ${val}m`);
});

bindCommitInput($("noStartFrom"), () => {
  const val = $("noStartFrom").value;
  if (val) updateRunRules({ no_start_from: val }, "Quiet window updated");
});

bindCommitInput($("noStartUntil"), () => {
  const val = $("noStartUntil").value;
  if (val) updateRunRules({ no_start_until: val }, "Quiet window updated");
});

function bindTimerInput(inputEl, humanEl, key) {
  inputEl.addEventListener("input", () => {
    const v = Number(inputEl.value);
    humanEl.textContent = (Number.isFinite(v) && v > 0) ? fmtDuration(v) : "";
  });

  const commit = () => {
    const val = Number(inputEl.value);
    if (!Number.isFinite(val) || val <= 0) {
      if (lastStatus && lastStatus[key]) {
        const prev = Math.round(Number(lastStatus[key].timer_interval_sec || 0));
        inputEl.value = prev > 0 ? String(prev) : "";
        humanEl.textContent = fmtDuration(prev);
      }
      showToast("Enter a positive number of seconds", true);
      return;
    }
    updateHarvest({ [key]: { timer_interval_sec: val } }, "Timer updated");
  };

  bindCommitInput(inputEl, commit);
}

bindTimerInput($("adTimerInput"), $("adTimerHuman"), "ad_gems");
bindTimerInput($("floatingTimerInput"), $("floatingTimerHuman"), "floating_gems");

// Initial loads
pollStatus();
fetchProfiles();
fetchMetrics();
fetchAccount();
