"""Minimal background gem collector supporting OCR/vision detection or timer mode.

Only taps Ad Gems and Floating Gems during verified battles, and delegates all
off-battle navigation (GAME STATS -> HOME/RETRY, Home -> Cards/Modules/Tier/BATTLE/RESUME)
to `towerpilot.nav.MenuNavigator`. Never surrenders or cancels an active run.
"""
from __future__ import annotations

import copy
import math
import random
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import numpy as np

from towerpilot import adb, detectors, run_rules
from towerpilot.capture import CaptureError, FrameSource
from towerpilot.input import TapRefused, Tapper
from towerpilot.nav import MenuNavigator, VerifiedTapContext
from towerpilot.profiles import ProfileStore
from towerpilot.telemetry import DEFAULT_EVENT_LOG_PATH, Telemetry

# Built-in humanization & geometry defaults (kept out of config bloat)
_TAP_JITTER_PX = 5
_TAP_PRESS_MS = (65, 130)
_TAP_MAX_PER_SEC = 3.0

_AD_SCAN_INTERVAL_SEC = 2.0
_AD_DELAY_SEC = (2.0, 6.0)
_AD_COOLDOWN_SEC = 60.0
_AD_DEFAULT_TAP_POINT = (120, 680)

_FG_SCAN_INTERVAL_SEC = 1.5
_FG_COOLDOWN_SEC = 45.0
_FG_TAPS_PER_BURST = 3
_FG_ORBIT_CENTER = (510, 805)
_FG_ORBIT_RADIUS = 170.0
_FG_ORBIT_ANGLE_DEG = 135.0
_FG_ORBIT_SPREAD_DEG = 6.0
_FG_ORBIT_JITTER = 0.03

_TIMER_SKIP_BACKOFF_SEC = 5.0
_FAILURE_BACKOFF_SEC = 5.0

_FLOW_SCAN_INTERVAL_SEC = 3.0
_FLOW_COOLDOWN_SEC = 15.0
_FLOW_DELAY_SEC = (2.0, 4.0)
_WAVE_SCAN_INTERVAL_SEC = 20.0
_LEGACY_POLICY_HOLDS = frozenset({"finish_and_stop", "max_runs", "no_start_window", "tier_mismatch"})


class _MemoryProfileStore(ProfileStore):
    """In-memory ProfileStore used when GemCollector is constructed without an explicit store."""

    def __init__(self, cfg: dict[str, Any] | None = None) -> None:
        super().__init__(path=Path("__memory_profiles__.json"))
        self._mem_data: dict[str, Any] | None = None
        self.seed_from_config(cfg)

    def _read_unlocked(self) -> dict[str, Any]:
        return copy.deepcopy(self._mem_data) if self._mem_data is not None else self._empty()

    def _write_unlocked(self, data: dict[str, Any]) -> None:
        self._mem_data = copy.deepcopy(data)

    def seed_from_config(self, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            if self._mem_data is not None and self._mem_data.get("profiles"):
                return copy.deepcopy(self._mem_data)
            return super().seed_from_config(cfg)


class GemCollector:
    """Owns the background gem-collection thread, timers, detection state, and telemetry."""

    def __init__(
        self,
        frame_source: FrameSource,
        cfg: dict[str, Any],
        *,
        tapper: Tapper | None = None,
        rng: random.Random | None = None,
        ad_delay_sec: tuple[float, float] = _AD_DELAY_SEC,
        fg_taps_per_burst: int = _FG_TAPS_PER_BURST,
        max_taps_per_sec: float = _TAP_MAX_PER_SEC,
        flow_delay_sec: tuple[float, float] = _FLOW_DELAY_SEC,
        wave_scan_interval_sec: float = _WAVE_SCAN_INTERVAL_SEC,
        event_log_path: Path | None = None,
        now_local_fn: Callable[[], datetime] | None = None,
        on_notify: Callable[[str, str], None] | None = None,
        profile_store: ProfileStore | None = None,
        telemetry: Telemetry | None = None,
    ) -> None:
        self._frames = frame_source
        self._cfg = cfg
        self._tapper = tapper or Tapper()
        self._rng = rng or random.Random()
        self._ad_delay_sec = ad_delay_sec
        self._fg_taps_per_burst = fg_taps_per_burst
        self._max_taps_per_sec = max_taps_per_sec
        self._flow_delay_sec = flow_delay_sec
        self._wave_scan_interval_sec = wave_scan_interval_sec
        self._event_log_path = event_log_path
        self._now_local_fn = now_local_fn or datetime.now
        self._on_notify = on_notify

        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        self.running = False

        # Telemetry & modular profile store
        self._telemetry = telemetry if telemetry is not None else Telemetry(event_log_path=event_log_path)
        self._profile_store = profile_store if profile_store is not None else _MemoryProfileStore(cfg)
        snap = self._profile_store.snapshot()
        active_prof = self._profile_store.get(snap.get("active_id"))
        if active_prof is not None:
            self._telemetry.set_profile(active_prof["id"], active_prof["name"])

        # Live battle observation & freeze-watch state
        self.battle_live = False
        self.menu_state = "unknown"
        self.foreground_blocker: str | None = None
        self._last_battle_state: tuple[bool, str] | None = None
        self._last_capture_error: str | None = None
        now_mono = time.monotonic()
        self._run_started_at: float | None = None
        self._run_start_exact: bool = False
        self._saw_non_battle: bool = False
        self.current_wave: int | None = None
        self.current_tier: int | None = None
        self._wave_last_scan: float = now_mono
        self._wave_changed_at: float = now_mono
        self.frozen: bool = False
        self._freeze_notified: bool = False

        # Ad Gem routine state
        self.ad_last_scan = 0.0
        self.ad_cooldown_until = 0.0
        self.ad_next_timer_at = 0.0
        self.ad_pending_due_at: float | None = None
        self.ad_visible_hit: detectors.AdGemHit | None = None
        self.ad_status = "stopped" if cfg["ad_gems"]["enabled"] else "off"
        self.ad_count = 0

        # Floating Gem routine state
        self.fg_last_scan = 0.0
        self.fg_cooldown_until = 0.0
        self.fg_next_timer_at = 0.0
        self.fg_status = "stopped" if cfg["floating_gems"]["enabled"] else "off"
        self.fg_count = 0

        # Out-of-battle navigation state machine
        self._stats_logged_for_run = False
        nav_ctx = VerifiedTapContext(
            grab_verified_frame=self._grab_verified_frame,
            check_foreground=self._check_foreground,
            tap=self._dispatch_menu_tap,
            log=self.log,
            notify=self._notify,
            stop_event=self._stop_event,
            rng=self._rng,
            now_local_fn=self._now_local_fn,
            delay_sec=flow_delay_sec,
            scan_interval_sec=_FLOW_SCAN_INTERVAL_SEC,
            cooldown_sec=_FLOW_COOLDOWN_SEC,
            failure_backoff_sec=_FAILURE_BACKOFF_SEC,
        )
        self._nav = MenuNavigator(nav_ctx)
        flow_cfg = cfg.get("run_flow", {})
        self._nav.nav_state = "stopped" if self._flow_any_enabled(flow_cfg) else "off"

        self._reset_timers(now_mono)

    # --- Compatibility properties delegating to MenuNavigator / Telemetry ---

    @property
    def telemetry(self) -> Telemetry:
        return self._telemetry

    @property
    def profile_store(self) -> ProfileStore:
        return self._profile_store

    @property
    def navigator(self) -> MenuNavigator:
        return self._nav

    @property
    def flow_status(self) -> str:
        return self._nav.nav_state

    @flow_status.setter
    def flow_status(self, value: str) -> None:
        self._nav.nav_state = value

    @property
    def flow_hold_reason(self) -> str | None:
        return self._nav.hold_reason

    @flow_hold_reason.setter
    def flow_hold_reason(self, value: str | None) -> None:
        self._nav.hold_reason = value

    @property
    def flow_pending_action(self) -> tuple[str, Any, float] | None:
        return self._nav.pending_action

    @flow_pending_action.setter
    def flow_pending_action(self, value: tuple[str, Any, float] | None) -> None:
        self._nav.pending_action = value

    @property
    def flow_last_scan(self) -> float:
        return self._nav.last_scan

    @flow_last_scan.setter
    def flow_last_scan(self, value: float) -> None:
        self._nav.last_scan = value

    @property
    def flow_cooldown_until(self) -> float:
        return self._nav.cooldown_until

    @flow_cooldown_until.setter
    def flow_cooldown_until(self, value: float) -> None:
        self._nav.cooldown_until = value

    @property
    def runs_restarted(self) -> int:
        return self._nav.runs_restarted

    @runs_restarted.setter
    def runs_restarted(self, value: int) -> None:
        self._nav.runs_restarted = value

    @property
    def runs_logged(self) -> int:
        return int(self._telemetry.snapshot()["all_time"]["runs_completed"])

    def set_notifier(self, fn: Callable[[str, str], None] | None) -> None:
        with self._lock:
            self._on_notify = fn

    def _notify(self, message: str, title: str = "Tower Pilot") -> None:
        fn = self._on_notify
        if callable(fn):
            try:
                fn(message, title)
            except Exception:
                pass

    def on_profile_activated(self, profile_id: str | None, *, immediate: bool = False) -> None:
        """React to a profile activation/switch from the API."""
        with self._lock:
            if immediate:
                self._nav.reset_verification(clear_presets=True, clear_tier=True, clear_hold=True)
                self._nav._active_profile_id = profile_id
                prof = self._profile_store.get(profile_id)
                if prof is not None:
                    self._telemetry.set_profile(prof["id"], prof["name"])
                if self.running and not self.battle_live:
                    self._nav.nav_state = "watching"

    def reset_runs_restarted(self) -> None:
        with self._lock:
            self._nav.runs_restarted = 0
            snap = self._profile_store.snapshot()
            for pid in {snap.get("active_id"), snap.get("queued_id")}:
                if not pid:
                    continue
                prof = self._profile_store.get(pid)
                if prof is not None and int((prof.get("runtime") or {}).get("runs_completed", 0) or 0) > 0:
                    prof["runtime"]["runs_completed"] = 0
                    self._profile_store.upsert(prof)
            if self._nav.hold_reason == "max_runs":
                self._nav.hold_reason = None
                self._nav._last_hold_reason = None
                self._nav._last_hold_profile = None
                if self.running:
                    self._nav.nav_state = "watching"
            self.log("Run counter reset to 0", event="run_count_reset")

    def runs_ledger(self, limit: int = 50) -> dict[str, Any]:
        return self._telemetry.runs_ledger(limit=limit)

    @staticmethod
    def _flow_any_enabled(flow_cfg: dict[str, Any]) -> bool:
        return bool(
            flow_cfg.get("auto_home")
            or flow_cfg.get("auto_battle")
            or flow_cfg.get("auto_retry")
            or flow_cfg.get("auto_resume")
        )

    def _rules_cfg(self) -> dict[str, Any]:
        raw = self._cfg.get("run_rules")
        return raw if isinstance(raw, dict) else {}

    def _reset_timers(self, now: float) -> None:
        self.ad_next_timer_at = now + float(self._cfg["ad_gems"]["timer_interval_sec"])
        self.fg_next_timer_at = now + float(self._cfg["floating_gems"]["timer_interval_sec"])

    def _tap_cfg(self) -> dict[str, Any]:
        """Build the tapper safety dict: harvesting ON permits taps; guards stay enforced."""
        return {
            "screen": self._cfg["screen"],
            "safety": {
                "allow_taps": True,
                "dry_run": False,
                "jitter_px": _TAP_JITTER_PX,
                "press_ms": list(_TAP_PRESS_MS),
                "max_taps_per_sec": self._max_taps_per_sec,
            },
        }

    def log(self, msg: str, *, event: str = "info", **data: Any) -> None:
        self._telemetry.log(msg, event=event, **data)

    def reconfigure(self, cfg: dict[str, Any]) -> None:
        with self._lock:
            old_mode = self._cfg["mode"]
            old_ad = self._cfg["ad_gems"]
            old_fg = self._cfg["floating_gems"]
            old_flow = self._cfg.get("run_flow")
            old_rules = self._cfg.get("run_rules")
            self._cfg = cfg
            now = time.monotonic()

            if cfg["mode"] != old_mode:
                self.ad_pending_due_at = None
                self.ad_visible_hit = None
                if cfg["mode"] == "timer":
                    self._reset_timers(now)
                self.log(
                    f"Mode switched to {cfg['mode'].upper()}",
                    event="mode_changed",
                    mode=cfg["mode"],
                )

            if (
                float(cfg["ad_gems"]["timer_interval_sec"]) != float(old_ad["timer_interval_sec"])
                or (cfg["ad_gems"]["enabled"] and not old_ad["enabled"])
            ):
                self.ad_next_timer_at = now + float(cfg["ad_gems"]["timer_interval_sec"])
            if not cfg["ad_gems"]["enabled"]:
                self.ad_pending_due_at = None
                self.ad_visible_hit = None
                self.ad_status = "off"
            elif not self.running:
                self.ad_status = "stopped"

            if (
                float(cfg["floating_gems"]["timer_interval_sec"]) != float(old_fg["timer_interval_sec"])
                or (cfg["floating_gems"]["enabled"] and not old_fg["enabled"])
            ):
                self.fg_next_timer_at = now + float(cfg["floating_gems"]["timer_interval_sec"])
            if not cfg["floating_gems"]["enabled"]:
                self.fg_status = "off"
            elif not self.running:
                self.fg_status = "stopped"

            flow_cfg = cfg.get("run_flow", {})
            flow_or_rules_changed = (flow_cfg != old_flow) or (cfg.get("run_rules") != old_rules)
            is_legacy_hold = self._nav.hold_reason in _LEGACY_POLICY_HOLDS
            is_safety_hold = self._nav.hold_reason is not None and not is_legacy_hold
            if flow_or_rules_changed and not is_safety_hold:
                self._nav.reset_verification(clear_presets=False, clear_tier=False)

            if not self._flow_any_enabled(flow_cfg):
                if is_legacy_hold:
                    self._nav.hold_reason = None
                    self._nav._last_hold_reason = None
                if not is_safety_hold:
                    self._nav.nav_state = "off"
            elif not self.running:
                if is_legacy_hold:
                    self._nav.hold_reason = None
                    self._nav._last_hold_reason = None
                if not is_safety_hold:
                    self._nav.nav_state = "stopped"
            elif (flow_cfg.get("auto_battle") or flow_cfg.get("auto_retry")) and not self.battle_live:
                action, reason = run_rules.decide_home_action(
                    self._now_local_fn(),
                    runs_restarted=self._nav.runs_restarted,
                    rules=self._rules_cfg(),
                    detected_tier=self.current_tier,
                    check_tier=(self._nav.hold_reason == "tier_mismatch"),
                )
                if action != "hold":
                    if is_legacy_hold:
                        self._nav.hold_reason = None
                        self._nav._last_hold_reason = None
                        self._nav.nav_state = "watching"
                elif not is_safety_hold:
                    if (
                        self._nav.pending_action is not None
                        and self._nav.pending_action[0] in ("home_battle", "end_stats_retry")
                    ):
                        self._nav.pending_action = None
                    self._nav.hold_reason = reason
                    self._nav.nav_state = run_rules.hold_label(
                        reason,
                        self._rules_cfg(),
                        self._nav.runs_restarted,
                        detected_tier=self.current_tier,
                    )

    def start(self) -> bool:
        with self._lock:
            if self.running:
                return False
            self._stop_event.clear()
            self.running = True
            now_mono = time.monotonic()
            self._reset_timers(now_mono)
            self.foreground_blocker = None
            self._last_battle_state = None
            self._last_capture_error = None
            self.ad_pending_due_at = None
            self.ad_visible_hit = None
            self._nav.reset_verification(clear_presets=False, clear_tier=False, clear_hold=True)
            self._wave_last_scan = now_mono
            self._wave_changed_at = now_mono
            self.frozen = False
            self._freeze_notified = False
            self.ad_status = "starting" if self._cfg["ad_gems"]["enabled"] else "off"
            self.fg_status = "starting" if self._cfg["floating_gems"]["enabled"] else "off"
            flow_cfg = self._cfg.get("run_flow", {})
            self._nav.nav_state = "watching" if self._flow_any_enabled(flow_cfg) else "off"
            self._thread = threading.Thread(target=self._run_loop, name="gem-collector", daemon=True)
            self._thread.start()
            self.log(
                f"Harvesting ON ({self._cfg['mode'].upper()})",
                event="harvest_started",
                mode=self._cfg["mode"],
                ad_gems=bool(self._cfg["ad_gems"]["enabled"]),
                floating_gems=bool(self._cfg["floating_gems"]["enabled"]),
            )
            return True

    def stop(self) -> bool:
        self._stop_event.set()
        with self._lock:
            if not self.running:
                return False
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=3.0)
        with self._lock:
            self.running = False
            self._thread = None
            self.foreground_blocker = None
            self._last_battle_state = None
            self._last_capture_error = None
            self.ad_pending_due_at = None
            self.ad_visible_hit = None
            self._nav.reset_verification(clear_presets=False, clear_tier=False, clear_hold=True)
            self.frozen = False
            self._freeze_notified = False
            self.ad_status = "stopped" if self._cfg["ad_gems"]["enabled"] else "off"
            self.fg_status = "stopped" if self._cfg["floating_gems"]["enabled"] else "off"
            flow_cfg = self._cfg.get("run_flow", {})
            self._nav.nav_state = "stopped" if self._flow_any_enabled(flow_cfg) else "off"
            self.log(
                "Harvesting OFF",
                event="harvest_stopped",
                ad_count=self.ad_count,
                floating_count=self.fg_count,
            )
            return True

    def _grab_verified_frame(self) -> tuple[np.ndarray, int | None]:
        """Capture a fresh ADB frame atomically paired with its logical input display."""
        grab_paired = getattr(self._frames, "grab_adb_with_display", None)
        if callable(grab_paired):
            return grab_paired()
        frame = self._frames.grab_adb()
        return frame, self._frames.input_display

    def _resolve_input_display(self) -> tuple[bool, int | None, str]:
        try:
            return True, self._frames.input_display, "ok"
        except CaptureError as exc:
            return False, None, f"unpaired_display:{exc}"

    def _check_foreground(self, input_display: int | None) -> tuple[bool, str]:
        serial = self._cfg["adb"]["serial"]
        try:
            if input_display is not None:
                wins = adb.visible_windows(serial, timeout=4.0, display_id=input_display)
            else:
                wins = adb.visible_windows(serial, timeout=4.0)
            blocker = adb.foreground_blocker(wins)
        except Exception as exc:
            self.foreground_blocker = f"windows_unreadable:{type(exc).__name__}"
            return False, self.foreground_blocker
        self.foreground_blocker = blocker
        if blocker is not None:
            return False, blocker
        return True, "ok"

    def _check_safety_guard(
        self,
        frame: np.ndarray,
        *,
        check_foreground: bool = True,
        input_display: int | None = None,
    ) -> tuple[bool, str]:
        """Verify the emulator is unobstructed in a live battle before sending input."""
        self.menu_state = detectors.side_menu_state(frame)
        if not self._cfg["safety"]["battle_only"]:
            self.foreground_blocker = None
            self.battle_live = True
            return True, "guard_disabled"

        if self.menu_state == "obscured":
            self.battle_live = False
            return False, "hud_obscured"

        if check_foreground:
            fg_ok, fg_why = self._check_foreground(input_display)
            if not fg_ok:
                self.battle_live = False
                return False, fg_why

        self.battle_live = True
        return True, "ok"

    def _safe_tap_point(self, pt: tuple[int, int], frame: np.ndarray) -> tuple[bool, str]:
        if detectors.in_ability_row(pt, frame.shape):
            return False, "in_ability_row"
        pad = _TAP_JITTER_PX + 4
        if detectors.in_open_side_menu(pt, frame, pad=pad):
            return False, "under_open_side_menu"
        return True, "ok"

    def _dispatch_tap(
        self,
        pt: tuple[int, int],
        frame: np.ndarray,
        reason: str,
        *,
        input_display: int | None = None,
        display_resolved: bool = False,
    ) -> dict[str, Any] | None:
        if self._stop_event.is_set():
            return None
        if not display_resolved:
            disp_ok, input_display, disp_why = self._resolve_input_display()
            if not disp_ok:
                self.log(f"Skipped {reason}: {disp_why}", event="tap_skipped", reason=reason, why=disp_why)
                return None
        ok, why = self._safe_tap_point(pt, frame)
        if not ok:
            self.log(f"Skipped {reason}: {why}", event="tap_skipped", reason=reason, why=why, point=list(pt))
            return None
        if self._stop_event.is_set():
            return None
        try:
            return self._tapper.tap(
                self._cfg["adb"]["serial"],
                pt[0],
                pt[1],
                cfg=self._tap_cfg(),
                input_display=input_display,
                reason=reason,
                frame_size=(int(frame.shape[1]), int(frame.shape[0])),
                stop_event=self._stop_event,
            )
        except TapRefused as exc:
            self.log(f"Tap refused ({reason}): {exc}", event="tap_refused", reason=reason, error=str(exc), point=list(pt))
            return None

    def _dispatch_menu_tap(
        self,
        pt: tuple[int, int],
        frame: np.ndarray,
        *,
        reason: str,
        input_display: int | None = None,
    ) -> dict[str, Any] | None:
        """Dispatch a MenuNavigator-validated off-battle tap through Tapper."""
        if self._stop_event.is_set():
            return None
        try:
            return self._tapper.tap(
                self._cfg["adb"]["serial"],
                pt[0],
                pt[1],
                cfg=self._tap_cfg(),
                input_display=input_display,
                reason=reason,
                frame_size=(int(frame.shape[1]), int(frame.shape[0])),
                stop_event=self._stop_event,
            )
        except TapRefused as exc:
            self.log(f"Tap refused ({reason}): {exc}", event="tap_refused", reason=reason, error=str(exc), point=list(pt))
            return None

    def _fail_ad_attempt(self) -> None:
        self.ad_pending_due_at = None
        self.ad_visible_hit = None
        self.ad_cooldown_until = max(self.ad_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)

    def _collect_ad_gem(self, *, trigger: str, rect: tuple[int, int, int, int] | None = None) -> bool:
        """Verify live battle on a fresh ADB frame, then tap Ad Gem."""
        if self._stop_event.is_set():
            return False
        try:
            fresh, input_display = self._grab_verified_frame()
        except Exception as exc:
            self.ad_status = "capture error"
            self._fail_ad_attempt()
            self.log(f"Ad Gem capture failed: {exc}", event="ad_gem_error", trigger=trigger, error=str(exc))
            return False

        ok, why = self._check_safety_guard(fresh, check_foreground=True, input_display=input_display)
        if not ok:
            self.ad_status = f"skipped ({why})"
            self._fail_ad_attempt()
            self.log(f"Ad Gem skipped ({trigger}): {why}", event="ad_gem_skipped", trigger=trigger, reason=why)
            if trigger == "timer":
                self.ad_next_timer_at = time.monotonic() + _TIMER_SKIP_BACKOFF_SEC
            return False

        target_rect = rect
        if trigger == "ocr":
            try:
                confirmed = detectors.detect_ad_gem(fresh)
            except Exception as exc:
                self.ad_status = "ocr error"
                self._fail_ad_attempt()
                self.log(f"Ad Gem OCR recheck failed: {exc}", event="ad_gem_error", trigger=trigger, error=str(exc))
                return False
            if confirmed is None:
                self._fail_ad_attempt()
                self.ad_status = "offer gone"
                self.log("Ad Gem disappeared before tap", event="ad_gem_gone", trigger=trigger)
                return False
            target_rect = confirmed.rect
            self.ad_visible_hit = confirmed

        if target_rect is not None:
            pt = detectors.sample_interior_point(target_rect, rng=self._rng)
        else:
            sx, sy = detectors.scale_point(_AD_DEFAULT_TAP_POINT, fresh.shape)
            pt = (int(round(sx)), int(round(sy)))

        res = self._dispatch_tap(
            pt,
            fresh,
            reason=f"ad_gem:{trigger}",
            input_display=input_display,
            display_resolved=True,
        )
        if res is None:
            self._fail_ad_attempt()
            return False

        now = time.monotonic()
        self.ad_cooldown_until = now + _AD_COOLDOWN_SEC
        self.ad_next_timer_at = now + float(self._cfg["ad_gems"]["timer_interval_sec"])
        self.ad_pending_due_at = None
        self.ad_visible_hit = None
        if trigger == "timer":
            self.ad_status = "timer tapped"
            self.log(
                f"Ad Gem timer tap at {res['x']},{res['y']}",
                event="ad_gem_attempted",
                trigger=trigger,
                x=res["x"],
                y=res["y"],
            )
        else:
            self.ad_count += 1
            self.ad_status = "collected"
            self.log(
                f"Ad Gem collected ({trigger}) at {res['x']},{res['y']}",
                event="ad_gem_collected",
                trigger=trigger,
                x=res["x"],
                y=res["y"],
                count=self.ad_count,
            )
        return True

    def _collect_floating_gem(
        self,
        *,
        trigger: str,
        detected: detectors.FloatingGemHit | None = None,
    ) -> bool:
        """Verify live battle on a fresh ADB frame before EACH tap in the burst."""
        if self._stop_event.is_set():
            return False
        try:
            fresh, input_display = self._grab_verified_frame()
        except Exception as exc:
            self.fg_status = "capture error"
            self.fg_cooldown_until = max(self.fg_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)
            self.log(f"Floating Gem capture failed: {exc}", event="floating_gem_error", trigger=trigger, error=str(exc))
            return False

        ok, why = self._check_safety_guard(fresh, check_foreground=True, input_display=input_display)
        if not ok:
            self.fg_status = f"skipped ({why})"
            self.fg_cooldown_until = max(self.fg_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)
            self.log(f"Floating Gem skipped ({trigger}): {why}", event="floating_gem_skipped", trigger=trigger, reason=why)
            if trigger == "timer":
                self.fg_next_timer_at = time.monotonic() + _TIMER_SKIP_BACKOFF_SEC
            return False

        center = detectors.scale_point(_FG_ORBIT_CENTER, fresh.shape)
        radius = _FG_ORBIT_RADIUS * (fresh.shape[1] / detectors.REF_W)

        points: list[tuple[int, int]]
        if detected is not None:
            fresh_hit = detectors.detect_floating_gem(fresh)
            if fresh_hit is not None:
                points = [fresh_hit.center]
            else:
                measured_r = math.hypot(detected.center[0] - center[0], detected.center[1] - center[1])
                points = detectors.orbit_tap_points(
                    center,
                    measured_r if measured_r >= 30 else radius,
                    _FG_ORBIT_ANGLE_DEG,
                    self._fg_taps_per_burst,
                    _FG_ORBIT_SPREAD_DEG,
                    _FG_ORBIT_JITTER,
                    rng=self._rng,
                )
        else:
            points = detectors.orbit_tap_points(
                center,
                radius,
                _FG_ORBIT_ANGLE_DEG,
                self._fg_taps_per_burst,
                _FG_ORBIT_SPREAD_DEG,
                _FG_ORBIT_JITTER,
                rng=self._rng,
            )

        tapped = []
        current_frame = fresh
        for idx, pt in enumerate(points):
            if self._stop_event.is_set():
                break
            if idx > 0:
                try:
                    current_frame, input_display = self._grab_verified_frame()
                except Exception as exc:
                    self.log(
                        f"Floating Gem burst aborted on capture: {exc}",
                        event="floating_gem_error",
                        trigger=trigger,
                        error=str(exc),
                    )
                    break
                ok_step, why_step = self._check_safety_guard(
                    current_frame,
                    check_foreground=True,
                    input_display=input_display,
                )
                if not ok_step:
                    self.fg_status = f"aborted ({why_step})"
                    self.log(
                        f"Floating Gem burst aborted ({trigger}): {why_step}",
                        event="floating_gem_skipped",
                        trigger=trigger,
                        reason=why_step,
                    )
                    break
            res = self._dispatch_tap(
                pt,
                current_frame,
                reason=f"floating_gem:{trigger}",
                input_display=input_display,
                display_resolved=True,
            )
            if res is not None:
                tapped.append(res)

        if not tapped:
            self.fg_cooldown_until = max(self.fg_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)
            return False

        now = time.monotonic()
        self.fg_cooldown_until = now + _FG_COOLDOWN_SEC
        self.fg_next_timer_at = now + float(self._cfg["floating_gems"]["timer_interval_sec"])
        if trigger == "timer":
            self.fg_status = "timer tapped"
            self.log(
                f"Floating Gem timer tap ({len(tapped)} tap{'s' if len(tapped) != 1 else ''})",
                event="floating_gem_attempted",
                trigger=trigger,
                points=[[r["x"], r["y"]] for r in tapped],
            )
        else:
            self.fg_count += 1
            self.fg_status = "collected"
            self.log(
                f"Floating Gem collected ({trigger}, {len(tapped)} tap{'s' if len(tapped) != 1 else ''})",
                event="floating_gem_collected",
                trigger=trigger,
                points=[[r["x"], r["y"]] for r in tapped],
                count=self.fg_count,
            )
        return True

    def _on_battle_started(self, *, exact: bool, tier: int | None, kind: str) -> None:
        self._run_started_at = time.time()
        self._run_start_exact = exact
        if exact:
            self.current_wave = None
        if kind in ("home_battle", "home_resume"):
            self._stats_logged_for_run = False
        if tier is not None:
            self.current_tier = tier

    def step_once(self) -> None:
        """Execute one observation + decision pass (directly unit-testable)."""
        now = time.monotonic()
        try:
            frame, _backend = self._frames.latest_or_grab(max_age_sec=1.2)
        except Exception as exc:
            self.battle_live = False
            msg = str(exc)
            if msg != self._last_capture_error:
                self._last_capture_error = msg
                self.log(f"Capture error: {msg}", event="capture_error", error=msg)
            return
        self._last_capture_error = None

        ok, why = self._check_safety_guard(frame, check_foreground=False)
        in_battle_hud = self.menu_state in ("closed", "open")
        battle_state = (ok, why)
        if battle_state != self._last_battle_state:
            self._last_battle_state = battle_state
            if ok:
                self.log(f"Battle live (menu {self.menu_state})", event="battle_live", menu_state=self.menu_state)
            else:
                self.log(f"Waiting for battle ({why})", event="battle_waiting", reason=why, menu_state=self.menu_state)

        if not in_battle_hud:
            self.frozen = False
            self._freeze_notified = False
            self._saw_non_battle = True
            self._nav.current_tier = self.current_tier
            acted = self._nav.step(
                frame,
                now,
                cfg=self._cfg,
                profile_store=self._profile_store,
                on_run_ended_fn=self._record_run_ended,
                on_battle_started_fn=self._on_battle_started,
            )
            if self._nav.current_tier is not None:
                self.current_tier = self._nav.current_tier
            if acted:
                return
        else:
            flow_cfg = self._cfg.get("run_flow", {})
            self._nav.on_enter_battle(flow_enabled=self._flow_any_enabled(flow_cfg))
            self._stats_logged_for_run = False
            if self._run_started_at is None:
                self._run_started_at = time.time()
                self._run_start_exact = self._saw_non_battle
            self._step_wave_watch(frame, now)

        if not ok:
            if self._cfg["ad_gems"]["enabled"]:
                self.ad_status = f"waiting ({why})"
            else:
                self.ad_status = "off"
            if self._cfg["floating_gems"]["enabled"]:
                self.fg_status = f"waiting ({why})"
            else:
                self.fg_status = "off"
            self.ad_pending_due_at = None
            return

        self._step_ad_gems(frame, now)
        self._step_floating_gems(frame, now)

    def _step_wave_watch(self, frame: np.ndarray, now: float) -> None:
        """Passively read current wave every ~20s and alert if the emulator freezes."""
        if now - self._wave_last_scan < self._wave_scan_interval_sec:
            return
        self._wave_last_scan = now
        try:
            wave = detectors.read_wave_ocr(frame)
        except Exception:
            return
        if wave is None:
            return

        if self.current_wave is None or wave != self.current_wave:
            was_frozen = self.frozen
            self.current_wave = wave
            self._wave_changed_at = now
            self.frozen = False
            self._freeze_notified = False
            if was_frozen:
                self.log(f"Battle resumed at Wave {wave}", event="battle_unfrozen", wave=wave)
            return

        freeze_min = int(self._rules_cfg().get("freeze_timeout_min", 10) or 0)
        if freeze_min > 0 and (now - self._wave_changed_at) >= freeze_min * 60.0:
            if not self.frozen:
                self.frozen = True
                self.log(
                    f"Battle frozen at Wave {wave} for {freeze_min}+ min",
                    event="battle_frozen",
                    wave=wave,
                    minutes=freeze_min,
                )
            if not self._freeze_notified:
                self._freeze_notified = True
                self._notify(f"Battle frozen at Wave {wave} for {freeze_min}+ min")

    def _record_run_ended(self, frame: np.ndarray) -> dict[str, Any] | None:
        """Passively scrape GAME STATS once per run end, log to telemetry, and notify."""
        if self._stats_logged_for_run:
            return None
        try:
            parsed = detectors.read_end_stats(frame)
        except Exception:
            parsed = None
        if not parsed:
            return None

        self._stats_logged_for_run = True
        now_wall = time.time()
        duration_sec: float | None = None
        duration_exact = bool(self._run_start_exact)
        if self._run_started_at is not None and now_wall >= self._run_started_at:
            duration_sec = round(now_wall - self._run_started_at, 1)
        self._run_started_at = None
        self._run_start_exact = False

        tier = parsed["tier"] if parsed.get("tier") is not None else self.current_tier
        wave = parsed["wave"] if parsed.get("wave") is not None else self.current_wave
        if tier is not None:
            self.current_tier = tier

        total_coins = parsed.get("total_coins")
        coins_per_hour: float | None = None
        if (
            duration_exact
            and parsed.get("coins_verified", True)
            and isinstance(total_coins, (int, float))
            and total_coins > 0
            and duration_sec is not None
            and duration_sec >= 30.0
        ):
            coins_per_hour = total_coins / (duration_sec / 3600.0)

        rules = self._rules_cfg()
        snap = self._profile_store.snapshot()
        active_prof = self._profile_store.get(snap.get("active_id"))
        profile_label = (
            active_prof["name"]
            if active_prof is not None
            else str(rules.get("profile_name") or "").strip()
        )
        profile_id = active_prof["id"] if active_prof is not None else None
        record: dict[str, Any] = {
            "ts": round(now_wall, 3),
            "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now_wall)),
            "event": "run_ended",
            "tier": tier,
            "wave": wave,
            "highest_wave": parsed.get("highest_wave"),
            "killed_by": parsed.get("killed_by"),
            "coins_raw": parsed.get("coins_raw"),
            "ad_coins_raw": parsed.get("ad_coins_raw"),
            "total_coins_raw": parsed.get("total_coins_raw"),
            "coins_earned": parsed.get("coins_earned"),
            "ad_coins_earned": parsed.get("ad_coins_earned"),
            "total_coins": total_coins,
            "coins_verified": bool(parsed.get("coins_verified", False)),
            "duration_sec": duration_sec,
            "duration_exact": duration_exact,
            "coins_per_hour": coins_per_hour,
            "coins_per_hour_fmt": run_rules.format_coins(coins_per_hour) if coins_per_hour else None,
            "profile": profile_label,
            "profile_id": profile_id,
            "profile_name": profile_label or None,
        }
        summary = run_rules.format_death_toast(record)
        record["msg"] = f"Run ended: {summary}"

        self.log(
            record["msg"],
            event="run_ended",
            profile_id=profile_id,
            profile_name=profile_label or None,
            tier=tier,
            wave=wave,
            highest_wave=parsed.get("highest_wave"),
            killed_by=parsed.get("killed_by"),
            coins_raw=parsed.get("coins_raw"),
            ad_coins_raw=parsed.get("ad_coins_raw"),
            total_coins_raw=parsed.get("total_coins_raw"),
            coins_earned=parsed.get("coins_earned"),
            ad_coins_earned=parsed.get("ad_coins_earned"),
            total_coins=total_coins,
            coins_verified=bool(parsed.get("coins_verified", False)),
            duration_sec=duration_sec,
            duration_exact=duration_exact,
            coins_per_hour=coins_per_hour,
            coins_per_hour_fmt=record["coins_per_hour_fmt"],
            profile=profile_label,
        )
        if bool(rules.get("notify_on_death", True)):
            self._notify(summary)
        return record

    def _step_ad_gems(self, frame: np.ndarray, now: float) -> None:
        ad_cfg = self._cfg["ad_gems"]
        if not ad_cfg["enabled"]:
            self.ad_status = "off"
            return
        if now < self.ad_cooldown_until:
            self.ad_status = f"cooldown ({int(self.ad_cooldown_until - now)}s)"
            return

        mode = self._cfg["mode"]
        if mode == "ocr":
            if self.ad_pending_due_at is not None:
                if now >= self.ad_pending_due_at:
                    rect = self.ad_visible_hit.rect if self.ad_visible_hit is not None else None
                    self._collect_ad_gem(trigger="ocr", rect=rect)
                    return
                self.ad_status = f"tapping in {self.ad_pending_due_at - now:.1f}s"
                return

            if now - self.ad_last_scan >= _AD_SCAN_INTERVAL_SEC:
                self.ad_last_scan = now
                try:
                    hit = detectors.detect_ad_gem(frame)
                except Exception as exc:
                    self.ad_status = "ocr error"
                    self.log(f"Ad Gem OCR failed: {exc}", event="ad_gem_error", trigger="ocr", error=str(exc))
                    hit = None
                if hit is not None:
                    self.ad_visible_hit = hit
                    dmin, dmax = self._ad_delay_sec
                    delay = self._rng.uniform(float(dmin), float(dmax))
                    self.ad_pending_due_at = now + delay
                    self.ad_status = f"tapping in {delay:.1f}s"
                    self.log(
                        f"Ad Gem spotted ({hit.text}), tapping in {delay:.1f}s",
                        event="ad_gem_spotted",
                        ocr_text=hit.text,
                        rect=list(hit.rect),
                        delay_sec=round(delay, 2),
                    )
                    if delay <= 0.05:
                        self._collect_ad_gem(trigger="ocr", rect=hit.rect)
                    return
                self.ad_visible_hit = None

            self.ad_status = "watching"
            return

        if now >= self.ad_next_timer_at:
            self._collect_ad_gem(trigger="timer")
            return
        self.ad_status = "timer armed"

    def _step_floating_gems(self, frame: np.ndarray, now: float) -> None:
        fg_cfg = self._cfg["floating_gems"]
        if not fg_cfg["enabled"]:
            self.fg_status = "off"
            return
        if now < self.fg_cooldown_until:
            self.fg_status = f"cooldown ({int(self.fg_cooldown_until - now)}s)"
            return

        mode = self._cfg["mode"]
        if mode == "ocr":
            if now - self.fg_last_scan >= _FG_SCAN_INTERVAL_SEC:
                self.fg_last_scan = now
                hit = detectors.detect_floating_gem(frame)
                if hit is not None:
                    self.log(
                        f"Floating Gem spotted (score {hit.score})",
                        event="floating_gem_spotted",
                        score=hit.score,
                        center=list(hit.center),
                    )
                    self._collect_floating_gem(trigger="vision", detected=hit)
                    return
            self.fg_status = "watching"
            return

        if now >= self.fg_next_timer_at:
            self._collect_floating_gem(trigger="timer")
            return
        self.fg_status = "timer armed"

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            started = time.monotonic()
            try:
                with self._lock:
                    self.step_once()
            except Exception as exc:
                self.log(f"Collector error: {exc}", event="collector_error", error=str(exc))
            elapsed = time.monotonic() - started
            self._stop_event.wait(max(0.05, 0.5 - elapsed))

    def status(self) -> dict[str, Any]:
        """Minimal status payload matching the shared /api/status contract."""
        with self._lock:
            now = time.monotonic()
            mode = self._cfg["mode"]
            ad_cfg = self._cfg["ad_gems"]
            fg_cfg = self._cfg["floating_gems"]

            fw, fh = self._frames.last_frame_size or (
                self._cfg["screen"]["width"],
                self._cfg["screen"]["height"],
            )

            # Refresh battle HUD indicator passively from latest preview frame when idle
            battle_live = self.battle_live
            menu_state = self.menu_state
            blocker = self.foreground_blocker
            if not self.running:
                preview = getattr(self._frames, "last_frame", None)
                if preview is not None:
                    menu_state = detectors.side_menu_state(preview)
                    battle_live = (not self._cfg["safety"]["battle_only"]) or menu_state in ("closed", "open")
                    if battle_live:
                        self.foreground_blocker = None
                        blocker = None

            ad_status = "off" if not ad_cfg["enabled"] else (self.ad_status if self.running else "stopped")
            fg_status = "off" if not fg_cfg["enabled"] else (self.fg_status if self.running else "stopped")
            flow_cfg = self._cfg.get("run_flow", {})
            flow_any = self._flow_any_enabled(flow_cfg)
            flow_status = "off" if not flow_any else (self._nav.nav_state if self.running else "stopped")
            rules_cfg = self._rules_cfg()
            elapsed_sec: float | None = None
            if battle_live and self._run_started_at is not None:
                elapsed_sec = max(0.0, round(time.time() - self._run_started_at, 1))

            store_snap = self._profile_store.snapshot()
            by_id = {p["id"]: p for p in store_snap.get("profiles") or []}
            active_id = store_snap.get("active_id")
            queued_id = store_snap.get("queued_id")
            active_prof = by_id.get(active_id)
            queued_prof = by_id.get(queued_id)

            metrics_snap = self._telemetry.snapshot()
            all_time = metrics_snap["all_time"]
            screen_name = (
                "battle"
                if (not self.running and menu_state in ("closed", "open") and self._nav.current_screen == "unknown")
                else self._nav.current_screen
            )

            return {
                "running": self.running,
                "mode": mode,
                "ad_gems": {
                    "enabled": bool(ad_cfg["enabled"]),
                    "timer_interval_sec": float(ad_cfg["timer_interval_sec"]),
                    "status": ad_status,
                    "next_timer_sec": max(0.0, round(self.ad_next_timer_at - now, 1))
                    if self.running and mode == "timer" and ad_cfg["enabled"]
                    else None,
                    "count": self.ad_count,
                },
                "floating_gems": {
                    "enabled": bool(fg_cfg["enabled"]),
                    "timer_interval_sec": float(fg_cfg["timer_interval_sec"]),
                    "status": fg_status,
                    "next_timer_sec": max(0.0, round(self.fg_next_timer_at - now, 1))
                    if self.running and mode == "timer" and fg_cfg["enabled"]
                    else None,
                    "count": self.fg_count,
                },
                "run_flow": {
                    "auto_home": bool(flow_cfg.get("auto_home")),
                    "auto_battle": bool(flow_cfg.get("auto_battle")),
                    "auto_retry": bool(flow_cfg.get("auto_retry")),
                    "auto_resume": bool(flow_cfg.get("auto_resume")),
                    "status": flow_status,
                    "runs_restarted": self._nav.runs_restarted,
                    "holding": bool(self._nav.hold_reason),
                    "hold_reason": self._nav.hold_reason,
                    "runs_logged": int(all_time["runs_completed"]),
                },
                "run_rules": {
                    "profile_name": str(rules_cfg.get("profile_name", "")),
                    "finish_and_stop": bool(rules_cfg.get("finish_and_stop", False)),
                    "max_runs": int(rules_cfg.get("max_runs", 0) or 0),
                    "expected_tier": int(rules_cfg.get("expected_tier", 0) or 0),
                    "no_start_enabled": bool(rules_cfg.get("no_start_enabled", False)),
                    "no_start_from": str(rules_cfg.get("no_start_from", "23:00")),
                    "no_start_until": str(rules_cfg.get("no_start_until", "07:00")),
                    "freeze_timeout_min": int(rules_cfg.get("freeze_timeout_min", 10) or 0),
                    "notify_on_death": bool(rules_cfg.get("notify_on_death", True)),
                },
                "profile": {
                    "active_id": active_id,
                    "active_name": active_prof["name"] if active_prof else None,
                    "active_kind": active_prof["kind"] if active_prof else None,
                    "queued_id": queued_id,
                    "queued_name": queued_prof["name"] if queued_prof else None,
                    "screen": screen_name,
                    "nav_state": self._nav.nav_state,
                    "verified_cards": self._nav.verified_cards_preset,
                    "verified_modules": self._nav.verified_modules_preset,
                },
                "telemetry": {
                    "session_id": self._telemetry.session_id,
                    "iteration_id": self._telemetry.iteration_id,
                    "all_time_gems": int(all_time["total_gems"]),
                    "all_time_runs": int(all_time["runs_completed"]),
                },
                "stream": {
                    "backend": self._frames.active_backend,
                    "frame_size": [int(fw), int(fh)],
                    "error": self._frames.last_error,
                },
                "battle": {
                    "live": bool(battle_live),
                    "menu_state": menu_state,
                    "blocker": blocker,
                    "wave": self.current_wave,
                    "tier": self.current_tier,
                    "elapsed_sec": elapsed_sec,
                    "frozen": self.frozen,
                },
                "recent": self._telemetry.recent(limit=20),
            }
