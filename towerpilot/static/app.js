const $ = (id) => document.getElementById(id);

    let lastStatus = null;
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

    function formatGemStatus(gem, mode) {
      const base = (gem && gem.status) ? String(gem.status) : "idle";
      if (mode === "timer" && gem && gem.enabled && gem.next_timer_sec !== null && gem.next_timer_sec !== undefined) {
        return `${base} · next in ${fmtDuration(gem.next_timer_sec)}`;
      }
      return base;
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

      // Battle status pill
      const battle = data.battle || {};
      if (battle.blocker) {
        setPill($("battlePill"), String(battle.blocker), "amber");
      } else if (battle.live) {
        setPill($("battlePill"), "Battle Live", "green");
      } else {
        setPill($("battlePill"), "Waiting", "");
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
      const adOn = Boolean(ad.enabled);
      const adBtn = $("adToggleBtn");
      adBtn.textContent = adOn ? "ON" : "OFF";
      adBtn.className = "toggle-btn ad" + (adOn ? " on" : "");
      adBtn.setAttribute("aria-pressed", String(adOn));
      $("adCount").textContent = String(ad.count ?? 0);
      $("adStatus").textContent = formatGemStatus(ad, mode);
      $("adTimerRow").hidden = mode !== "timer";
      syncTimerInput($("adTimerInput"), $("adTimerHuman"), ad.timer_interval_sec);

      // Floating Gems row
      const fg = data.floating_gems || {};
      const fgOn = Boolean(fg.enabled);
      const fgBtn = $("floatingToggleBtn");
      fgBtn.textContent = fgOn ? "ON" : "OFF";
      fgBtn.className = "toggle-btn floating" + (fgOn ? " on" : "");
      fgBtn.setAttribute("aria-pressed", String(fgOn));
      $("floatingCount").textContent = String(fg.count ?? 0);
      $("floatingStatus").textContent = formatGemStatus(fg, mode);
      $("floatingTimerRow").hidden = mode !== "timer";
      syncTimerInput($("floatingTimerInput"), $("floatingTimerHuman"), fg.timer_interval_sec);

      // Run continuity (End Stats -> Home, Auto Re-Battle)
      const flow = data.run_flow || {};
      const autoHomeOn = Boolean(flow.auto_home);
      const autoHomeBtn = $("autoHomeBtn");
      autoHomeBtn.textContent = autoHomeOn ? "ON" : "OFF";
      autoHomeBtn.className = "toggle-btn flow" + (autoHomeOn ? " on" : "");
      autoHomeBtn.setAttribute("aria-pressed", String(autoHomeOn));

      const autoBattleOn = Boolean(flow.auto_battle);
      const autoBattleBtn = $("autoBattleBtn");
      autoBattleBtn.textContent = autoBattleOn ? "ON" : "OFF";
      autoBattleBtn.className = "toggle-btn flow" + (autoBattleOn ? " on" : "");
      autoBattleBtn.setAttribute("aria-pressed", String(autoBattleOn));

      $("runsRestarted").textContent = String(flow.runs_restarted ?? 0);
      $("flowStatus").textContent = flow.status ? String(flow.status) : "off";

      // Recent activity
      renderActivity(data.recent);
    }

    async function updateHarvest(payload, toastLabel) {
      inFlight += 1;
      try {
        const res = await fetch("/api/harvest", {
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

    // Event bindings
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

    $("autoHomeBtn").addEventListener("click", () => {
      const next = !(lastStatus && lastStatus.run_flow && lastStatus.run_flow.auto_home);
      updateHarvest({ run_flow: { auto_home: next } });
    });

    $("autoBattleBtn").addEventListener("click", () => {
      const next = !(lastStatus && lastStatus.run_flow && lastStatus.run_flow.auto_battle);
      updateHarvest({ run_flow: { auto_battle: next } });
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

      inputEl.addEventListener("change", commit);
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          inputEl.blur();
        }
      });
    }

    bindTimerInput($("adTimerInput"), $("adTimerHuman"), "ad_gems");
    bindTimerInput($("floatingTimerInput"), $("floatingTimerHuman"), "floating_gems");

    // Start polling
    pollStatus();
