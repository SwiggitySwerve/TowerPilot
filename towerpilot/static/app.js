const $ = (id) => document.getElementById(id);

let lastStatus = null;
let lastRunsLogged = -1;
let pollTimer = null;
let inFlight = 0;
let serverWasOffline = false;

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
  if (!Number.isFinite(Number(ts))) return "--:--:--";
  return new Date(Number(ts) * 1000).toTimeString().slice(0, 8);
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
    return `${base} · next in ${fmtDuration(gem.next_timer_sec)}`;
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

function renderLedger(payload) {
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

      const tierTag = document.createElement("span");
      tierTag.className = "tier-tag";
      tierTag.textContent = `T${row.tier}`;
      left.appendChild(tierTag);

      if (row.profile) {
        const chip = document.createElement("span");
        chip.className = "profile-chip";
        chip.textContent = row.profile;
        chip.title = row.profile;
        left.appendChild(chip);
      }

      const meta = document.createElement("span");
      meta.style.color = "var(--muted)";
      const wavePart = row.avg_wave ? `avg W${row.avg_wave} · ` : "";
      meta.textContent = `${wavePart}${row.runs}r`;
      left.appendChild(meta);

      const right = document.createElement("span");
      right.className = "cph-val";
      right.textContent = row.coins_per_hour_fmt ? `${row.coins_per_hour_fmt}/hr` : "—";

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
    const tStr = run.tier !== null && run.tier !== undefined ? `T${run.tier}` : "T?";
    const wStr = run.wave !== null && run.wave !== undefined ? `W${run.wave}` : "W?";
    head.textContent = `${tStr} ${wStr}`;
    head.style.fontWeight = "700";

    const coins = document.createElement("span");
    const totalStr = run.total_coins_raw || "";
    const cphStr = run.coins_per_hour_fmt ? ` (${run.coins_per_hour_fmt}/hr)` : "";
    coins.textContent = totalStr ? `${totalStr}${cphStr}` : "—";
    coins.style.color = run.coins_verified === false ? "var(--amber)" : "var(--green)";

    top.appendChild(head);
    top.appendChild(coins);

    const meta = document.createElement("div");
    meta.className = "ledger-meta";

    const details = [];
    if (run.duration_sec) details.push(fmtDuration(run.duration_sec));
    if (run.killed_by) details.push(run.killed_by);
    if (run.profile) details.push(`[${run.profile}]`);

    const leftMeta = document.createElement("span");
    leftMeta.textContent = details.join(" · ") || "—";

    const timeMeta = document.createElement("span");
    timeMeta.textContent = fmtTime(run.ts);

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

  $("liveTier").textContent = battle.tier !== null && battle.tier !== undefined ? `T${battle.tier}` : "—";
  $("liveWave").textContent = battle.wave !== null && battle.wave !== undefined ? String(battle.wave) : "—";
  $("liveElapsed").textContent = battle.elapsed_sec !== null && battle.elapsed_sec !== undefined
    ? fmtDuration(battle.elapsed_sec)
    : "—";
  $("freezeBanner").hidden = !battle.frozen;

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

  // Run continuity & rules (left sidebar)
  const flow = data.run_flow || {};
  const rules = data.run_rules || {};
  setToggle($("autoHomeBtn"), Boolean(flow.auto_home), "flow");
  setToggle($("autoBattleBtn"), Boolean(flow.auto_battle), "flow");
  setToggle($("finishStopBtn"), Boolean(rules.finish_and_stop), "amber");
  setToggle($("noStartBtn"), Boolean(rules.no_start_enabled), "amber");
  setToggle($("notifyDeathBtn"), Boolean(rules.notify_on_death), "flow");

  $("runsRestarted").textContent = String(flow.runs_restarted ?? 0);
  $("flowStatus").textContent = flow.status ? String(flow.status) : "off";

  syncInputValue($("maxRunsInput"), rules.max_runs ?? 0);
  syncInputValue($("noStartFrom"), rules.no_start_from || "23:00");
  syncInputValue($("noStartUntil"), rules.no_start_until || "07:00");
  $("noStartTimesRow").hidden = !rules.no_start_enabled;
  syncInputValue($("profileInput"), rules.profile_name || "");
  syncInputValue($("freezeMinInput"), rules.freeze_timeout_min ?? 10);

  // Sidebar status pill + hold banner
  const holding = Boolean(flow.holding);
  const holdBanner = $("holdBanner");
  const resumeBtn = $("resumeHoldBtn");
  if (holding) {
    setPill($("sidebarStatePill"), "Holding", "amber");
    $("holdBannerText").textContent = flow.status ? String(flow.status) : "Holding at Home";
    holdBanner.hidden = false;
    resumeBtn.hidden = !(flow.hold_reason === "finish_and_stop" || flow.hold_reason === "max_runs");
  } else if (battle.frozen) {
    setPill($("sidebarStatePill"), "Frozen", "red");
    holdBanner.hidden = true;
  } else if (running && (flow.auto_home || flow.auto_battle)) {
    setPill($("sidebarStatePill"), rules.finish_and_stop ? "Finishing" : "Active", rules.finish_and_stop ? "amber" : "green");
    holdBanner.hidden = true;
  } else {
    setPill($("sidebarStatePill"), flow.auto_home || flow.auto_battle ? "Paused" : "Passive", "");
    holdBanner.hidden = true;
  }

  // Refresh run ledger whenever a new run is recorded (and on first load)
  const logged = Number(flow.runs_logged ?? 0);
  if (logged !== lastRunsLogged) {
    lastRunsLogged = logged;
    fetchRuns();
  }

  // Recent activity
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

async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (serverWasOffline) {
      serverWasOffline = false;
      $("streamImg").src = "/api/stream.mjpg?t=" + Date.now();
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

// Collapsible left sidebar state
function setSidebarCollapsed(collapsed) {
  const grid = $("layoutGrid");
  const btn = $("collapseSidebarBtn");
  grid.classList.toggle("sidebar-collapsed", collapsed);
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.title = collapsed ? "Expand Runs panel" : "Collapse Runs panel";
  btn.textContent = collapsed ? "\u00bb" : "\u00ab";
  try {
    localStorage.setItem("tp_sidebar_collapsed", collapsed ? "1" : "0");
  } catch (_) {
    // ignore storage errors
  }
}

try {
  if (localStorage.getItem("tp_sidebar_collapsed") === "1") {
    setSidebarCollapsed(true);
  }
} catch (_) {
  // ignore
}

$("collapseSidebarBtn").addEventListener("click", () => {
  const collapsed = $("layoutGrid").classList.contains("sidebar-collapsed");
  setSidebarCollapsed(!collapsed);
});

// Event bindings: harvesting
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

// Event bindings: Runs sidebar
$("autoHomeBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_flow && lastStatus.run_flow.auto_home);
  updateRunRules({ run_flow: { auto_home: next } });
});

$("autoBattleBtn").addEventListener("click", () => {
  const next = !(lastStatus && lastStatus.run_flow && lastStatus.run_flow.auto_battle);
  updateRunRules({ run_flow: { auto_battle: next } });
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
    updateRunRules({ action: "reset_run_count" }, "Counter reset — resuming");
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

bindCommitInput($("maxRunsInput"), () => {
  const val = parseInt($("maxRunsInput").value, 10);
  if (!Number.isInteger(val) || val < 0 || val > 9999) {
    showToast("Max runs must be 0–9999", true);
    if (lastStatus) render(lastStatus);
    return;
  }
  updateRunRules({ max_runs: val }, val === 0 ? "Max runs: unlimited" : `Max runs: ${val}`);
});

bindCommitInput($("freezeMinInput"), () => {
  const val = parseInt($("freezeMinInput").value, 10);
  if (!Number.isInteger(val) || val < 0 || val > 180) {
    showToast("Freeze alert must be 0–180 min", true);
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

bindCommitInput($("profileInput"), () => {
  updateRunRules({ profile_name: $("profileInput").value.trim() }, "Profile tag saved");
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

// Start polling
pollStatus();
