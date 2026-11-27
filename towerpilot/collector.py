"""Minimal background gem collector supporting OCR/vision detection or timer mode.

Only taps Ad Gems and Floating Gems during verified battles, plus optional
OCR-verified End Stats -> HOME and Home -> BATTLE transitions when `run_flow`
is enabled. Never surrenders or cancels an active run.
"""
from __future__ import annotations

import json
import math
import random
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import numpy as np

from towerpilot import adb, detectors, run_rules
from towerpilot.capture import CaptureError, FrameSource
from towerpilot.input import TapRefused, Tapper

DEFAULT_EVENT_LOG_PATH = Path(__file__).resolve().parents[1] / "logs" / "events.jsonl"

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


class GemCollector:
    """Owns the background gem-collection thread, timers, detection state, and recent log."""

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

        # End-of-run continuity & run ledger state (GAME STATS -> HOME/RETRY, Home -> BATTLE/RESUME)
        flow_cfg = cfg.get("run_flow", {})
        self.flow_last_scan = 0.0
        self.flow_cooldown_until = 0.0
        self.flow_pending_action: tuple[str, detectors.ButtonHit, float] | None = None
        self.flow_status = "stopped" if self._flow_any_enabled(flow_cfg) else "off"
        self.flow_hold_reason: str | None = None
        self._last_hold_reason: str | None = None
        self.runs_restarted = 0
        self._stats_logged_for_run = False
        self._runs: deque[dict[str, Any]] = deque(
            run_rules.load_run_ledger(event_log_path, limit=100),
            maxlen=100,
        )
        self.runs_logged = len(self._runs)

        self._recent: deque[dict[str, Any]] = deque(maxlen=30)
        self._reset_timers(now_mono)

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

    def reset_runs_restarted(self) -> None:
        with self._lock:
            self.runs_restarted = 0
            if self.flow_hold_reason == "max_runs":
                self.flow_hold_reason = None
                self._last_hold_reason = None
                if self.running:
                    self.flow_status = "watching"
            self.log("Run counter reset to 0", event="run_count_reset")

    def runs_ledger(self, limit: int = 50) -> dict[str, Any]:
        with self._lock:
            all_runs = list(self._runs)
        return {
            "runs": all_runs[:limit],
            "by_tier": run_rules.summarize_by_tier(all_runs),
        }

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
        now = time.time()
        entry: dict[str, Any] = {
            "ts": round(now, 3),
            "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)),
            "event": event,
            "msg": msg,
        }
        if data:
            entry.update(data)
        with self._lock:
            self._recent.appendleft({"ts": entry["ts"], "event": event, "msg": msg})
            if self._event_log_path is not None:
                try:
                    self._event_log_path.parent.mkdir(parents=True, exist_ok=True)
                    with open(self._event_log_path, "a", encoding="utf-8") as fh:
                        fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
                except OSError:
                    pass

    def reconfigure(self, cfg: dict[str, Any]) -> None:
        with self._lock:
            old_mode = self._cfg["mode"]
            old_ad = self._cfg["ad_gems"]
            old_fg = self._cfg["floating_gems"]
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
            if not self._flow_any_enabled(flow_cfg):
                self.flow_pending_action = None
                self.flow_hold_reason = None
                self._last_hold_reason = None
                self.flow_status = "off"
            elif not self.running:
                self.flow_hold_reason = None
                self._last_hold_reason = None
                self.flow_status = "stopped"
            elif (flow_cfg.get("auto_battle") or flow_cfg.get("auto_retry")) and not self.battle_live:
                # Re-evaluate hold immediately when rules change while off-battle
                action, reason = run_rules.decide_home_action(
                    self._now_local_fn(),
                    runs_restarted=self.runs_restarted,
                    rules=self._rules_cfg(),
                    detected_tier=self.current_tier,
                    check_tier=(self.flow_hold_reason == "tier_mismatch"),
                )
                if action != "hold":
                    if self.flow_hold_reason is not None:
                        self.flow_hold_reason = None
                        self._last_hold_reason = None
                        self.flow_status = "watching"
                else:
                    if self.flow_pending_action is not None and self.flow_pending_action[0] in ("home_battle", "end_stats_retry"):
                        self.flow_pending_action = None
                    self.flow_hold_reason = reason
                    self.flow_status = run_rules.hold_label(
                        reason,
                        self._rules_cfg(),
                        self.runs_restarted,
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
            self.flow_pending_action = None
            self.flow_hold_reason = None
            self._last_hold_reason = None
            self._wave_last_scan = now_mono
            self._wave_changed_at = now_mono
            self.frozen = False
            self._freeze_notified = False
            self.ad_status = "starting" if self._cfg["ad_gems"]["enabled"] else "off"
            self.fg_status = "starting" if self._cfg["floating_gems"]["enabled"] else "off"
            flow_cfg = self._cfg.get("run_flow", {})
            self.flow_status = "watching" if self._flow_any_enabled(flow_cfg) else "off"
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
        # Signal cancellation before acquiring self._lock so an in-flight capture/OCR
        # pass aborts immediately before dispatching any tap.
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
            self.flow_pending_action = None
            self.flow_hold_reason = None
            self._last_hold_reason = None
            self.frozen = False
            self._freeze_notified = False
            self.ad_status = "stopped" if self._cfg["ad_gems"]["enabled"] else "off"
            self.fg_status = "stopped" if self._cfg["floating_gems"]["enabled"] else "off"
            flow_cfg = self._cfg.get("run_flow", {})
            self.flow_status = "stopped" if self._flow_any_enabled(flow_cfg) else "off"
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
            if self._step_run_flow(frame, now):
                return
        else:
            self.flow_pending_action = None
            self.flow_hold_reason = None
            self._last_hold_reason = None
            self._stats_logged_for_run = False
            if self._run_started_at is None:
                self._run_started_at = time.time()
                self._run_start_exact = self._saw_non_battle
            flow_cfg = self._cfg.get("run_flow", {})
            self.flow_status = "in battle" if self._flow_any_enabled(flow_cfg) else "off"
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
        """Passively scrape GAME STATS once per run end, log to JSONL, and notify."""
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
        profile = str(rules.get("profile_name") or "").strip()
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
            "profile": profile,
        }
        summary = run_rules.format_death_toast(record)
        record["msg"] = f"Run ended: {summary}"

        self._runs.appendleft(record)
        self.runs_logged += 1
        self.log(
            record["msg"],
            event="run_ended",
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
            profile=profile,
        )
        if bool(rules.get("notify_on_death", True)):
            self._notify(summary)
        return record

    def _set_hold(self, reason: str, rules: dict[str, Any], *, detected_tier: int | None = None) -> None:
        self.flow_hold_reason = reason
        self.flow_status = run_rules.hold_label(
            reason,
            rules,
            self.runs_restarted,
            detected_tier=detected_tier,
        )
        if self._last_hold_reason != reason:
            self._last_hold_reason = reason
            self.log(f"Auto-restart holding: {self.flow_status}", event="run_hold", reason=reason, tier=detected_tier)

    def _execute_flow_action(self, kind: str) -> bool:
        """Verify foreground game window and target OCR on a fresh ADB frame, then tap."""
        if self._stop_event.is_set():
            self.flow_pending_action = None
            return False
        rules = self._rules_cfg()
        if kind in ("home_battle", "end_stats_retry"):
            action, reason = run_rules.decide_home_action(
                self._now_local_fn(),
                runs_restarted=self.runs_restarted,
                rules=rules,
            )
            if action == "hold":
                self.flow_pending_action = None
                self._set_hold(reason, rules)
                return False
        try:
            fresh, input_display = self._grab_verified_frame()
        except Exception as exc:
            self.flow_status = "capture error"
            self.flow_pending_action = None
            self.flow_cooldown_until = max(self.flow_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)
            self.log(f"Auto-restart capture failed: {exc}", event="auto_restart_error", action=kind, error=str(exc))
            return False

        fg_ok, fg_why = self._check_foreground(input_display)
        if not fg_ok:
            self.flow_status = f"skipped ({fg_why})"
            self.flow_pending_action = None
            self.flow_cooldown_until = max(self.flow_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)
            self.log(f"Auto-restart skipped ({kind}): {fg_why}", event="auto_restart_skipped", action=kind, reason=fg_why)
            return False

        try:
            if kind == "end_stats_home":
                hit = detectors.detect_end_stats_home(fresh)
            elif kind == "end_stats_retry":
                hit = detectors.detect_end_stats_retry(fresh)
            elif kind == "home_resume":
                candidate = detectors.detect_home_battle(fresh, allow_resume=True)
                hit = candidate if (candidate is not None and candidate.label == "RESUME") else None
            else:
                hit = detectors.detect_home_battle(fresh)
        except Exception as exc:
            self.flow_status = "ocr error"
            self.flow_pending_action = None
            self.flow_cooldown_until = max(self.flow_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)
            self.log(f"Auto-restart OCR failed: {exc}", event="auto_restart_error", action=kind, error=str(exc))
            return False

        if hit is None:
            self.flow_pending_action = None
            self.flow_cooldown_until = max(self.flow_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)
            self.flow_status = "target gone"
            self.log(f"Auto-restart target disappeared ({kind})", event="auto_restart_gone", action=kind)
            return False

        if kind in ("end_stats_home", "end_stats_retry") and not self._stats_logged_for_run:
            self._record_run_ended(fresh)
        elif kind in ("home_battle", "home_resume") and hit.tier is not None:
            self.current_tier = hit.tier

        if kind in ("home_battle", "end_stats_retry"):
            tier_to_check = hit.tier if kind == "home_battle" else self.current_tier
            action, reason = run_rules.decide_home_action(
                self._now_local_fn(),
                runs_restarted=self.runs_restarted,
                rules=rules,
                detected_tier=tier_to_check,
                check_tier=True,
            )
            if action == "hold":
                self.flow_pending_action = None
                self._set_hold(reason, rules, detected_tier=tier_to_check)
                return False

        if self._stop_event.is_set():
            self.flow_pending_action = None
            return False

        pt = detectors.sample_interior_point(hit.rect, inset_px=16, rng=self._rng)
        serial = self._cfg["adb"]["serial"]
        try:
            res = self._tapper.tap(
                serial,
                pt[0],
                pt[1],
                cfg=self._tap_cfg(),
                input_display=input_display,
                reason=f"run_flow:{kind}",
                frame_size=(int(fresh.shape[1]), int(fresh.shape[0])),
                stop_event=self._stop_event,
            )
        except TapRefused as exc:
            self.flow_pending_action = None
            self.flow_cooldown_until = max(self.flow_cooldown_until, time.monotonic() + _FAILURE_BACKOFF_SEC)
            self.flow_status = "tap refused"
            self.log(f"Auto-restart tap refused ({kind}): {exc}", event="tap_refused", reason=kind, error=str(exc))
            return False

        now = time.monotonic()
        self.flow_pending_action = None
        self.flow_cooldown_until = now + _FLOW_COOLDOWN_SEC
        if kind == "end_stats_home":
            if self.flow_hold_reason:
                self.flow_status = run_rules.hold_label(
                    self.flow_hold_reason,
                    rules,
                    self.runs_restarted,
                    detected_tier=self.current_tier,
                )
            else:
                self.flow_status = "tapped HOME"
            self.log(
                f"End Stats -> HOME tapped at {res['x']},{res['y']}",
                event="end_stats_home_tapped",
                x=res["x"],
                y=res["y"],
            )
        elif kind == "end_stats_retry":
            self.runs_restarted += 1
            self._run_started_at = time.time()
            self._run_start_exact = True
            self.current_wave = None
            self.flow_hold_reason = None
            self._last_hold_reason = None
            self.flow_status = "tapped RETRY"
            self.log(
                f"End Stats -> RETRY tapped at {res['x']},{res['y']}",
                event="end_stats_retry_tapped",
                x=res["x"],
                y=res["y"],
                tier=self.current_tier,
                runs_restarted=self.runs_restarted,
            )
        elif kind == "home_resume":
            self._run_started_at = time.time()
            self._run_start_exact = False
            self._stats_logged_for_run = False
            self.flow_hold_reason = None
            self._last_hold_reason = None
            self.flow_status = "tapped RESUME"
            self.log(
                f"Home -> RESUME tapped at {res['x']},{res['y']}",
                event="home_resume_tapped",
                x=res["x"],
                y=res["y"],
                tier=self.current_tier,
            )
        else:
            self.runs_restarted += 1
            self._run_started_at = time.time()
            self._run_start_exact = True
            self.current_wave = None
            self._stats_logged_for_run = False
            self.flow_hold_reason = None
            self._last_hold_reason = None
            self.flow_status = "tapped BATTLE"
            self.log(
                f"Home -> BATTLE tapped at {res['x']},{res['y']}",
                event="home_battle_tapped",
                x=res["x"],
                y=res["y"],
                tier=self.current_tier,
                runs_restarted=self.runs_restarted,
            )
        return True

    def _step_run_flow(self, frame: np.ndarray, now: float) -> bool:
        """Scrape GAME STATS passively, and handle HOME/RETRY/BATTLE/RESUME boundaries."""
        flow_cfg = self._cfg.get("run_flow", {})
        auto_home = bool(flow_cfg.get("auto_home"))
        auto_battle = bool(flow_cfg.get("auto_battle"))
        auto_retry = bool(flow_cfg.get("auto_retry"))
        auto_resume = bool(flow_cfg.get("auto_resume"))
        rules = self._rules_cfg()

        if not self._flow_any_enabled(flow_cfg):
            self.flow_pending_action = None
            self.flow_hold_reason = None
            self._last_hold_reason = None
            self.flow_status = "off"
            # Still passively scrape GAME STATS once when a run ends (zero taps)
            if not self._stats_logged_for_run and now - self.flow_last_scan >= _FLOW_SCAN_INTERVAL_SEC:
                self.flow_last_scan = now
                try:
                    if detectors.detect_end_stats_home(frame) is not None:
                        self._record_run_ended(frame)
                except Exception:
                    pass
            return False

        if now < self.flow_cooldown_until:
            self.flow_status = f"cooldown ({int(self.flow_cooldown_until - now)}s)"
            return False

        if self.flow_pending_action is not None:
            kind, hit, due_at = self.flow_pending_action
            enabled_map = {
                "end_stats_home": auto_home,
                "end_stats_retry": auto_retry,
                "home_battle": auto_battle,
                "home_resume": auto_resume,
            }
            if not enabled_map.get(kind, False):
                self.flow_pending_action = None
                self.flow_status = "watching"
                return False
            if kind in ("home_battle", "end_stats_retry"):
                action, reason = run_rules.decide_home_action(
                    self._now_local_fn(),
                    runs_restarted=self.runs_restarted,
                    rules=rules,
                )
                if action == "hold":
                    self.flow_pending_action = None
                    self._set_hold(reason, rules)
                    return False
            if now >= due_at:
                return self._execute_flow_action(kind)
            self.flow_status = f"tapping {hit.label} in {due_at - now:.1f}s"
            return False

        if now - self.flow_last_scan < _FLOW_SCAN_INTERVAL_SEC:
            if self.flow_status in ("off", "stopped", "in battle"):
                self.flow_status = "watching"
            return False
        self.flow_last_scan = now

        if auto_home or auto_retry or not self._stats_logged_for_run:
            try:
                stats_hit = detectors.detect_end_stats_home(frame)
            except Exception as exc:
                if auto_home or auto_retry:
                    self.flow_status = "ocr error"
                    self.log(
                        f"End Stats OCR failed: {exc}",
                        event="auto_restart_error",
                        action="end_stats_home",
                        error=str(exc),
                    )
                stats_hit = None
            if stats_hit is not None:
                rec = self._record_run_ended(frame)
                ended_tier = rec["tier"] if (rec and rec.get("tier") is not None) else self.current_tier

                if auto_retry and stats_hit.retry_rect is not None:
                    action, reason = run_rules.decide_home_action(
                        self._now_local_fn(),
                        runs_restarted=self.runs_restarted,
                        rules=rules,
                        detected_tier=ended_tier,
                        check_tier=True,
                    )
                    if action == "battle":
                        self.flow_hold_reason = None
                        self._last_hold_reason = None
                        rx, ry, rw, rh = stats_hit.retry_rect
                        retry_hit = detectors.ButtonHit(
                            rect=stats_hit.retry_rect,
                            center=(rx + rw // 2, ry + rh // 2),
                            label="RETRY",
                            screen="game_stats",
                            retry_rect=stats_hit.retry_rect,
                        )
                        dmin, dmax = self._flow_delay_sec
                        delay = self._rng.uniform(float(dmin), float(dmax))
                        self.flow_pending_action = ("end_stats_retry", retry_hit, now + delay)
                        self.flow_status = f"tapping RETRY in {delay:.1f}s"
                        self.log(
                            f"GAME STATS detected -> RETRY in {delay:.1f}s",
                            event="end_stats_retry_detected",
                            rect=list(retry_hit.rect),
                            delay_sec=round(delay, 2),
                        )
                        if delay <= 0.05:
                            return self._execute_flow_action("end_stats_retry")
                        return False
                    self._set_hold(reason, rules, detected_tier=ended_tier)
                    if not auto_home:
                        return False
                    # Holding with auto_home ON: fall through to tap HOME and park safely while preserving hold state

                if auto_home:
                    dmin, dmax = self._flow_delay_sec
                    delay = self._rng.uniform(float(dmin), float(dmax))
                    self.flow_pending_action = ("end_stats_home", stats_hit, now + delay)
                    self.flow_status = f"tapping HOME in {delay:.1f}s"
                    self.log(
                        f"GAME STATS detected -> HOME in {delay:.1f}s",
                        event="end_stats_detected",
                        rect=list(stats_hit.rect),
                        delay_sec=round(delay, 2),
                    )
                    if delay <= 0.05:
                        return self._execute_flow_action("end_stats_home")
                    return False

        if auto_battle or auto_resume:
            pre_action, pre_reason = run_rules.decide_home_action(
                self._now_local_fn(),
                runs_restarted=self.runs_restarted,
                rules=rules,
            )
            if not auto_resume and pre_action == "hold":
                self._set_hold(pre_reason, rules)
                return False

            try:
                home_hit = (
                    detectors.detect_home_battle(frame, allow_resume=True)
                    if auto_resume
                    else detectors.detect_home_battle(frame)
                )
            except Exception as exc:
                self.flow_status = "ocr error"
                self.log(f"Home BATTLE OCR failed: {exc}", event="auto_restart_error", action="home_battle", error=str(exc))
                home_hit = None

            if home_hit is not None:
                if home_hit.tier is not None:
                    self.current_tier = home_hit.tier
                if home_hit.label == "RESUME" and auto_resume:
                    self.flow_hold_reason = None
                    self._last_hold_reason = None
                    dmin, dmax = self._flow_delay_sec
                    delay = self._rng.uniform(float(dmin), float(dmax))
                    self.flow_pending_action = ("home_resume", home_hit, now + delay)
                    self.flow_status = f"tapping RESUME in {delay:.1f}s"
                    self.log(
                        f"Crashed run detected -> RESUME in {delay:.1f}s",
                        event="home_resume_detected",
                        rect=list(home_hit.rect),
                        tier=home_hit.tier,
                        delay_sec=round(delay, 2),
                    )
                    if delay <= 0.05:
                        return self._execute_flow_action("home_resume")
                    return False

                if home_hit.label == "BATTLE" and auto_battle:
                    action, reason = run_rules.decide_home_action(
                        self._now_local_fn(),
                        runs_restarted=self.runs_restarted,
                        rules=rules,
                        detected_tier=home_hit.tier,
                        check_tier=True,
                    )
                    if action == "hold":
                        self._set_hold(reason, rules, detected_tier=home_hit.tier)
                        return False
                    self.flow_hold_reason = None
                    self._last_hold_reason = None
                    dmin, dmax = self._flow_delay_sec
                    delay = self._rng.uniform(float(dmin), float(dmax))
                    self.flow_pending_action = ("home_battle", home_hit, now + delay)
                    self.flow_status = f"tapping BATTLE in {delay:.1f}s"
                    self.log(
                        f"Home screen detected -> BATTLE in {delay:.1f}s",
                        event="home_battle_detected",
                        rect=list(home_hit.rect),
                        tier=home_hit.tier,
                        delay_sec=round(delay, 2),
                    )
                    if delay <= 0.05:
                        return self._execute_flow_action("home_battle")
                    return False

            if auto_battle and pre_action == "hold":
                self._set_hold(pre_reason, rules)
                return False

        if self.flow_hold_reason:
            self.flow_status = run_rules.hold_label(
                self.flow_hold_reason,
                rules,
                self.runs_restarted,
                detected_tier=self.current_tier,
            )
            return False

        self.flow_status = "watching"
        return False

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

        # Timer mode
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

        # Timer mode
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
            flow_status = "off" if not flow_any else (self.flow_status if self.running else "stopped")
            rules_cfg = self._rules_cfg()
            elapsed_sec: float | None = None
            if battle_live and self._run_started_at is not None:
                elapsed_sec = max(0.0, round(time.time() - self._run_started_at, 1))

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
                    "runs_restarted": self.runs_restarted,
                    "holding": bool(self.flow_hold_reason),
                    "hold_reason": self.flow_hold_reason,
                    "runs_logged": self.runs_logged,
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
                "recent": list(self._recent)[:20],
            }
