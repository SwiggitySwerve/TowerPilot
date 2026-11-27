"""Minimal background gem collector supporting OCR/vision detection or timer mode.

Never starts, surrenders, or navigates menus. Only taps Ad Gems and Floating Gems,
guarded by foreground window + undimmed battle HUD checks when safety.battle_only=True.
"""
from __future__ import annotations

import json
import math
import random
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np

from towerpilot import adb, detectors
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

_FLOW_SCAN_INTERVAL_SEC = 3.0
_FLOW_COOLDOWN_SEC = 15.0
_FLOW_DELAY_SEC = (2.0, 4.0)


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
        event_log_path: Path | None = None,
    ) -> None:
        self._frames = frame_source
        self._cfg = cfg
        self._tapper = tapper or Tapper()
        self._rng = rng or random.Random()
        self._ad_delay_sec = ad_delay_sec
        self._fg_taps_per_burst = fg_taps_per_burst
        self._max_taps_per_sec = max_taps_per_sec
        self._flow_delay_sec = flow_delay_sec
        self._event_log_path = event_log_path

        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        self.running = False

        # Live battle observation state
        self.battle_live = False
        self.menu_state = "unknown"
        self.foreground_blocker: str | None = None
        self._last_battle_state: tuple[bool, str] | None = None

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

        # End-of-run continuity state (GAME STATS -> HOME, Home -> BATTLE)
        flow_cfg = cfg.get("run_flow", {})
        self.flow_last_scan = 0.0
        self.flow_cooldown_until = 0.0
        self.flow_pending_action: tuple[str, detectors.ButtonHit, float] | None = None
        self.flow_status = "stopped" if (flow_cfg.get("auto_home") or flow_cfg.get("auto_battle")) else "off"
        self.runs_restarted = 0

        self._recent: deque[dict[str, Any]] = deque(maxlen=30)
        self._reset_timers(time.monotonic())

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
            if not (flow_cfg.get("auto_home") or flow_cfg.get("auto_battle")):
                self.flow_pending_action = None
                self.flow_status = "off"
            elif not self.running:
                self.flow_status = "stopped"

    def start(self) -> bool:
        with self._lock:
            if self.running:
                return False
            self._stop_event.clear()
            self.running = True
            self._reset_timers(time.monotonic())
            self.foreground_blocker = None
            self._last_battle_state = None
            self.ad_pending_due_at = None
            self.ad_visible_hit = None
            self.flow_pending_action = None
            self.ad_status = "starting" if self._cfg["ad_gems"]["enabled"] else "off"
            self.fg_status = "starting" if self._cfg["floating_gems"]["enabled"] else "off"
            flow_cfg = self._cfg.get("run_flow", {})
            self.flow_status = "watching" if (flow_cfg.get("auto_home") or flow_cfg.get("auto_battle")) else "off"
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
            self.ad_pending_due_at = None
            self.ad_visible_hit = None
            self.flow_pending_action = None
            self.ad_status = "stopped" if self._cfg["ad_gems"]["enabled"] else "off"
            self.fg_status = "stopped" if self._cfg["floating_gems"]["enabled"] else "off"
            flow_cfg = self._cfg.get("run_flow", {})
            self.flow_status = "stopped" if (flow_cfg.get("auto_home") or flow_cfg.get("auto_battle")) else "off"
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

    def _collect_ad_gem(self, *, trigger: str, rect: tuple[int, int, int, int] | None = None) -> bool:
        """Verify live battle on a fresh ADB frame, then tap Ad Gem."""
        if self._stop_event.is_set():
            return False
        try:
            fresh, input_display = self._grab_verified_frame()
        except Exception as exc:
            self.ad_status = "capture error"
            self.log(f"Ad Gem capture failed: {exc}", event="ad_gem_error", trigger=trigger, error=str(exc))
            return False

        ok, why = self._check_safety_guard(fresh, check_foreground=True, input_display=input_display)
        if not ok:
            self.ad_status = f"skipped ({why})"
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
                self.log(f"Ad Gem OCR recheck failed: {exc}", event="ad_gem_error", trigger=trigger, error=str(exc))
                return False
            if confirmed is None:
                self.ad_visible_hit = None
                self.ad_pending_due_at = None
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
            self.log(f"Floating Gem capture failed: {exc}", event="floating_gem_error", trigger=trigger, error=str(exc))
            return False

        ok, why = self._check_safety_guard(fresh, check_foreground=True, input_display=input_display)
        if not ok:
            self.fg_status = f"skipped ({why})"
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
            self.log(f"Capture error: {exc}", event="capture_error", error=str(exc))
            return

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
            if self._step_run_flow(frame, now):
                return
        else:
            self.flow_pending_action = None
            flow_cfg = self._cfg.get("run_flow", {})
            self.flow_status = "in battle" if (flow_cfg.get("auto_home") or flow_cfg.get("auto_battle")) else "off"

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

    def _execute_flow_action(self, kind: str) -> bool:
        """Verify foreground game window and target OCR on a fresh ADB frame, then tap."""
        if self._stop_event.is_set():
            self.flow_pending_action = None
            return False
        try:
            fresh, input_display = self._grab_verified_frame()
        except Exception as exc:
            self.flow_status = "capture error"
            self.flow_pending_action = None
            self.log(f"Auto-restart capture failed: {exc}", event="auto_restart_error", action=kind, error=str(exc))
            return False

        fg_ok, fg_why = self._check_foreground(input_display)
        if not fg_ok:
            self.flow_status = f"skipped ({fg_why})"
            self.flow_pending_action = None
            self.log(f"Auto-restart skipped ({kind}): {fg_why}", event="auto_restart_skipped", action=kind, reason=fg_why)
            return False

        try:
            hit = (
                detectors.detect_end_stats_home(fresh)
                if kind == "end_stats_home"
                else detectors.detect_home_battle(fresh)
            )
        except Exception as exc:
            self.flow_status = "ocr error"
            self.flow_pending_action = None
            self.log(f"Auto-restart OCR failed: {exc}", event="auto_restart_error", action=kind, error=str(exc))
            return False

        if hit is None:
            self.flow_pending_action = None
            self.flow_status = "target gone"
            self.log(f"Auto-restart target disappeared ({kind})", event="auto_restart_gone", action=kind)
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
            self.flow_status = "tap refused"
            self.log(f"Auto-restart tap refused ({kind}): {exc}", event="tap_refused", reason=kind, error=str(exc))
            return False

        now = time.monotonic()
        self.flow_pending_action = None
        self.flow_cooldown_until = now + _FLOW_COOLDOWN_SEC
        if kind == "end_stats_home":
            self.flow_status = "tapped HOME"
            self.log(
                f"End Stats -> HOME tapped at {res['x']},{res['y']}",
                event="end_stats_home_tapped",
                x=res["x"],
                y=res["y"],
            )
        else:
            self.runs_restarted += 1
            self.flow_status = "tapped BATTLE"
            self.log(
                f"Home -> BATTLE tapped at {res['x']},{res['y']}",
                event="home_battle_tapped",
                x=res["x"],
                y=res["y"],
                runs_restarted=self.runs_restarted,
            )
        return True

    def _step_run_flow(self, frame: np.ndarray, now: float) -> bool:
        """Check End Stats -> HOME or Home -> BATTLE; return True when input was dispatched."""
        flow_cfg = self._cfg.get("run_flow", {})
        auto_home = bool(flow_cfg.get("auto_home"))
        auto_battle = bool(flow_cfg.get("auto_battle"))
        if not (auto_home or auto_battle):
            self.flow_pending_action = None
            self.flow_status = "off"
            return False

        if now < self.flow_cooldown_until:
            self.flow_status = f"cooldown ({int(self.flow_cooldown_until - now)}s)"
            return False

        if self.flow_pending_action is not None:
            kind, hit, due_at = self.flow_pending_action
            still_enabled = (kind == "end_stats_home" and auto_home) or (kind == "home_battle" and auto_battle)
            if not still_enabled:
                self.flow_pending_action = None
                self.flow_status = "watching"
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

        if auto_home:
            try:
                stats_hit = detectors.detect_end_stats_home(frame)
            except Exception as exc:
                self.flow_status = "ocr error"
                self.log(f"End Stats OCR failed: {exc}", event="auto_restart_error", action="end_stats_home", error=str(exc))
                stats_hit = None
            if stats_hit is not None:
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

        if auto_battle:
            try:
                battle_hit = detectors.detect_home_battle(frame)
            except Exception as exc:
                self.flow_status = "ocr error"
                self.log(f"Home BATTLE OCR failed: {exc}", event="auto_restart_error", action="home_battle", error=str(exc))
                battle_hit = None
            if battle_hit is not None:
                dmin, dmax = self._flow_delay_sec
                delay = self._rng.uniform(float(dmin), float(dmax))
                self.flow_pending_action = ("home_battle", battle_hit, now + delay)
                self.flow_status = f"tapping BATTLE in {delay:.1f}s"
                self.log(
                    f"Home screen detected -> BATTLE in {delay:.1f}s",
                    event="home_battle_detected",
                    rect=list(battle_hit.rect),
                    delay_sec=round(delay, 2),
                )
                if delay <= 0.05:
                    return self._execute_flow_action("home_battle")
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
            flow_any = bool(flow_cfg.get("auto_home") or flow_cfg.get("auto_battle"))
            flow_status = "off" if not flow_any else (self.flow_status if self.running else "stopped")

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
                    "status": flow_status,
                    "runs_restarted": self.runs_restarted,
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
                },
                "recent": list(self._recent)[:20],
            }
