"""Single background gem-collector loop supporting OCR/vision detection + timers.

Never starts, surrenders, or navigates menus. Only taps Ad Gems and Floating Gems,
guarded by foreground window + undimmed battle HUD checks when battle_only=True.
"""
from __future__ import annotations

import math
import random
import threading
import time
from collections import deque
from typing import Any

import numpy as np

from towerpilot import adb, detectors
from towerpilot.capture import FrameSource
from towerpilot.input import TapRefused, Tapper


class GemCollector:
    """Owns the background gem-collection thread, timers, detection state, and logs."""

    def __init__(
        self,
        frame_source: FrameSource,
        cfg: dict[str, Any],
        *,
        tapper: Tapper | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self._frames = frame_source
        self._cfg = cfg
        self._tapper = tapper or Tapper()
        self._rng = rng or random.Random()
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        self.running = False
        self.started_at: float | None = None

        # Live battle observation state
        self.battle_live = False
        self.menu_state = "unknown"
        self.foreground_blocker: str | None = None
        self.last_wave: int | None = None
        self.last_error: str | None = None
        self._last_wave_scan = 0.0

        # Ad Gem routine state
        self.ad_last_scan = 0.0
        self.ad_cooldown_until = 0.0
        self.ad_next_timer_at = 0.0
        self.ad_pending_due_at: float | None = None
        self.ad_visible_hit: detectors.AdGemHit | None = None
        self.ad_last_ocr_text: str = ""
        self.ad_status = "idle"

        # Floating Gem routine state
        self.fg_last_scan = 0.0
        self.fg_cooldown_until = 0.0
        self.fg_next_timer_at = 0.0
        self.fg_visible_hit: detectors.FloatingGemHit | None = None
        self.fg_status = "idle"

        # Counters & logs
        self.stats = {
            "ad_gems": 0,
            "floating_gems": 0,
            "taps": 0,
            "dry_taps": 0,
            "skips": 0,
            "errors": 0,
        }
        self._events: deque[dict[str, Any]] = deque(maxlen=200)
        self._reset_timers(time.monotonic())

    def _reset_timers(self, now: float) -> None:
        self.ad_next_timer_at = now + float(self._cfg["ad_gems"]["timer_interval_sec"])
        self.fg_next_timer_at = now + float(self._cfg["floating_gems"]["timer_interval_sec"])

    def log(self, category: str, message: str, **details: Any) -> None:
        entry = {
            "ts": time.time(),
            "category": category,
            "message": message,
            "details": details,
        }
        with self._lock:
            self._events.appendleft(entry)

    def clear_events(self) -> None:
        with self._lock:
            self._events.clear()

    def reconfigure(self, cfg: dict[str, Any]) -> None:
        with self._lock:
            old_ad_interval = float(self._cfg["ad_gems"]["timer_interval_sec"])
            old_fg_interval = float(self._cfg["floating_gems"]["timer_interval_sec"])
            self._cfg = cfg
            now = time.monotonic()
            if float(cfg["ad_gems"]["timer_interval_sec"]) != old_ad_interval:
                self.ad_next_timer_at = now + float(cfg["ad_gems"]["timer_interval_sec"])
            if float(cfg["floating_gems"]["timer_interval_sec"]) != old_fg_interval:
                self.fg_next_timer_at = now + float(cfg["floating_gems"]["timer_interval_sec"])
            if cfg["ad_gems"]["mode"] in ("off", "timer"):
                self.ad_pending_due_at = None
                self.ad_visible_hit = None
            if cfg["floating_gems"]["mode"] in ("off", "timer"):
                self.fg_visible_hit = None

    def start(self) -> bool:
        with self._lock:
            if self.running:
                return False
            self._stop_event.clear()
            self.running = True
            self.started_at = time.time()
            self._reset_timers(time.monotonic())
            self.ad_pending_due_at = None
            self.ad_visible_hit = None
            self.fg_visible_hit = None
            self._thread = threading.Thread(target=self._run_loop, name="gem-collector", daemon=True)
            self._thread.start()
            self.log(
                "system",
                "Collector started",
                ad_mode=self._cfg["ad_gems"]["mode"],
                floating_mode=self._cfg["floating_gems"]["mode"],
                allow_taps=self._cfg["safety"]["allow_taps"],
                dry_run=self._cfg["safety"]["dry_run"],
            )
            return True

    def stop(self) -> bool:
        with self._lock:
            if not self.running:
                return False
            self._stop_event.set()
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=3.0)
        with self._lock:
            self.running = False
            self._thread = None
            self.ad_pending_due_at = None
            self.ad_status = "stopped"
            self.fg_status = "stopped"
            self.log("system", "Collector stopped")
            return True

    def _check_safety_guard(self, frame: np.ndarray, *, check_foreground: bool = True) -> tuple[bool, str]:
        """Verify the emulator is unobstructed in a live battle before sending input."""
        cfg = self._cfg
        self.menu_state = detectors.side_menu_state(frame)
        if not cfg["safety"]["battle_only"]:
            self.foreground_blocker = None
            self.battle_live = True
            return True, "guard_disabled"

        if self.menu_state == "obscured":
            self.battle_live = False
            return False, "hud_obscured"

        if check_foreground:
            serial = cfg["adb"]["serial"]
            try:
                wins = adb.visible_windows(serial, timeout=4.0)
                blocker = adb.foreground_blocker(wins)
            except Exception as exc:
                self.foreground_blocker = f"windows_unreadable:{type(exc).__name__}"
                self.battle_live = False
                return False, self.foreground_blocker
            self.foreground_blocker = blocker
            if blocker is not None:
                self.battle_live = False
                return False, blocker

        self.battle_live = True
        return True, "ok"

    def _safe_tap_point(self, pt: tuple[int, int], frame: np.ndarray) -> tuple[bool, str]:
        if detectors.in_ability_row(pt, frame.shape):
            return False, "in_ability_row"
        pad = int(self._cfg["safety"]["jitter_px"]) + 4
        if detectors.in_open_side_menu(pt, frame, pad=pad):
            return False, "under_open_side_menu"
        return True, "ok"

    def _dispatch_tap(self, pt: tuple[int, int], frame: np.ndarray, reason: str) -> dict[str, Any] | None:
        ok, why = self._safe_tap_point(pt, frame)
        if not ok:
            self.stats["skips"] += 1
            self.log("guard", f"Skipped {reason}: {why}", point=list(pt))
            return None
        try:
            res = self._tapper.tap(
                self._cfg["adb"]["serial"],
                pt[0],
                pt[1],
                cfg=self._cfg,
                input_display=self._frames.input_display,
                reason=reason,
                frame_size=(int(frame.shape[1]), int(frame.shape[0])),
            )
        except TapRefused as exc:
            self.stats["skips"] += 1
            self.log("guard", f"Tap refused ({reason}): {exc}", point=list(pt))
            return None
        if res["dry_run"]:
            self.stats["dry_taps"] += 1
        else:
            self.stats["taps"] += 1
        return res

    def _collect_ad_gem(self, *, trigger: str, rect: tuple[int, int, int, int] | None = None) -> bool:
        """Verify live battle on a fresh ADB frame, then tap Ad Gem."""
        try:
            fresh = self._frames.grab_adb()
        except Exception as exc:
            self.stats["errors"] += 1
            self.log("error", f"Ad Gem fresh capture failed: {exc}")
            return False

        ok, why = self._check_safety_guard(fresh, check_foreground=True)
        if not ok:
            self.stats["skips"] += 1
            self.ad_status = f"skipped ({why})"
            self.log("guard", f"Ad Gem skipped ({trigger}): {why}")
            return False

        target_rect = rect
        if trigger == "ocr":
            # Re-verify CLAIM on the fresh frame so we never tap a disappeared/moved offer.
            try:
                confirmed = detectors.detect_ad_gem(
                    fresh,
                    search_roi=self._cfg["ad_gems"]["search_roi"],
                )
            except Exception as exc:
                self.stats["errors"] += 1
                self.log("error", f"Ad Gem re-verify OCR failed: {exc}")
                return False
            if confirmed is None:
                self.ad_visible_hit = None
                self.ad_status = "offer_gone_on_recheck"
                self.log("detect", "Ad Gem disappeared before tap")
                return False
            target_rect = confirmed.rect
            self.ad_visible_hit = confirmed
            self._cfg["ad_gems"]["tap_point"] = [confirmed.center[0], confirmed.center[1]]

        if target_rect is not None:
            pt = detectors.sample_interior_point(target_rect, rng=self._rng)
        else:
            tx, ty = self._cfg["ad_gems"]["tap_point"]
            pt = (int(tx), int(ty))

        res = self._dispatch_tap(pt, fresh, reason=f"ad_gem:{trigger}")
        if res is None:
            return False

        now = time.monotonic()
        self.stats["ad_gems"] += 1
        self.ad_cooldown_until = now + float(self._cfg["ad_gems"]["cooldown_sec"])
        self.ad_next_timer_at = now + float(self._cfg["ad_gems"]["timer_interval_sec"])
        self.ad_pending_due_at = None
        self.ad_visible_hit = None
        self.ad_status = "collected (dry)" if res["dry_run"] else "collected"
        self.log(
            "collect",
            f"Ad Gem tapped via {trigger}" + (" [DRY RUN]" if res["dry_run"] else ""),
            x=res["x"],
            y=res["y"],
            trigger=trigger,
        )
        return True

    def _collect_floating_gem(
        self,
        *,
        trigger: str,
        detected: detectors.FloatingGemHit | None = None,
    ) -> bool:
        """Verify live battle on a fresh ADB frame, then tap floating gem / orbit arc."""
        try:
            fresh = self._frames.grab_adb()
        except Exception as exc:
            self.stats["errors"] += 1
            self.log("error", f"Floating Gem fresh capture failed: {exc}")
            return False

        ok, why = self._check_safety_guard(fresh, check_foreground=True)
        if not ok:
            self.stats["skips"] += 1
            self.fg_status = f"skipped ({why})"
            self.log("guard", f"Floating Gem skipped ({trigger}): {why}")
            return False

        fg_cfg = self._cfg["floating_gems"]
        center = detectors.scale_point(tuple(fg_cfg["orbit_center"]), fresh.shape)
        radius = float(fg_cfg["orbit_radius"]) * (fresh.shape[1] / detectors.REF_W)

        points: list[tuple[int, int]]
        if detected is not None and fg_cfg["tap_detected_directly"]:
            # Re-verify position on the fresh frame if still visible, else tap orbit at measured radius.
            fresh_hit = detectors.detect_floating_gem(fresh)
            if fresh_hit is not None:
                points = [fresh_hit.center]
            else:
                measured_r = math.hypot(detected.center[0] - center[0], detected.center[1] - center[1])
                points = detectors.orbit_tap_points(
                    center,
                    measured_r if measured_r >= 30 else radius,
                    float(fg_cfg["orbit_angle_deg"]),
                    int(fg_cfg["taps_per_burst"]),
                    float(fg_cfg["orbit_spread_deg"]),
                    float(fg_cfg["orbit_jitter"]),
                    rng=self._rng,
                )
        else:
            use_r = radius
            if detected is not None:
                measured_r = math.hypot(detected.center[0] - center[0], detected.center[1] - center[1])
                if measured_r >= 30:
                    use_r = measured_r
            points = detectors.orbit_tap_points(
                center,
                use_r,
                float(fg_cfg["orbit_angle_deg"]),
                int(fg_cfg["taps_per_burst"]),
                float(fg_cfg["orbit_spread_deg"]),
                float(fg_cfg["orbit_jitter"]),
                rng=self._rng,
            )

        tapped = []
        for pt in points:
            res = self._dispatch_tap(pt, fresh, reason=f"floating_gem:{trigger}")
            if res is not None:
                tapped.append(res)

        if not tapped:
            return False

        now = time.monotonic()
        self.stats["floating_gems"] += 1
        self.fg_cooldown_until = now + float(fg_cfg["cooldown_sec"])
        self.fg_next_timer_at = now + float(fg_cfg["timer_interval_sec"])
        self.fg_visible_hit = None
        dry = all(r["dry_run"] for r in tapped)
        self.fg_status = "collected (dry)" if dry else "collected"
        self.log(
            "collect",
            f"Floating Gem tapped ({len(tapped)} tap{'s' if len(tapped) != 1 else ''}) via {trigger}"
            + (" [DRY RUN]" if dry else ""),
            points=[[r["x"], r["y"]] for r in tapped],
            trigger=trigger,
        )
        return True

    def trigger_ad_gem_now(self) -> dict[str, Any]:
        """Manual one-shot Ad Gem tap (tries OCR first, falls back to configured point)."""
        with self._lock:
            frame, _ = self._frames.latest_or_grab()
            hit = None
            try:
                hit = detectors.detect_ad_gem(frame, search_roi=self._cfg["ad_gems"]["search_roi"])
            except Exception:
                hit = None
            ok = self._collect_ad_gem(
                trigger="manual_ocr" if hit is not None else "manual",
                rect=hit.rect if hit is not None else None,
            )
            return {"ok": ok, "status": self.ad_status}

    def trigger_floating_gem_now(self) -> dict[str, Any]:
        """Manual one-shot Floating Gem tap (uses detected gem if spotted, else orbit arc)."""
        with self._lock:
            frame, _ = self._frames.latest_or_grab()
            hit = detectors.detect_floating_gem(frame)
            ok = self._collect_floating_gem(
                trigger="manual_vision" if hit is not None else "manual",
                detected=hit,
            )
            return {"ok": ok, "status": self.fg_status}

    def step_once(self) -> None:
        """Execute one observation + decision pass (also directly unit-testable)."""
        now = time.monotonic()
        try:
            frame, _backend = self._frames.latest_or_grab(max_age_sec=1.2)
        except Exception as exc:
            self.last_error = str(exc)
            self.battle_live = False
            self.stats["errors"] += 1
            self.log("error", f"Capture error: {exc}")
            return

        self.last_error = None
        ok, why = self._check_safety_guard(frame, check_foreground=False)
        if not ok:
            self.ad_status = f"waiting ({why})"
            self.fg_status = f"waiting ({why})"
            self.ad_pending_due_at = None
            return

        # Periodically read wave via WinRT OCR (every 15s, purely informational)
        if now - self._last_wave_scan >= 15.0:
            self._last_wave_scan = now
            wave = detectors.read_wave_ocr(frame)
            if wave is not None:
                self.last_wave = wave

        self._step_ad_gems(frame, now)
        self._step_floating_gems(frame, now)

    def _step_ad_gems(self, frame: np.ndarray, now: float) -> None:
        cfg = self._cfg["ad_gems"]
        mode = cfg["mode"]
        if mode == "off":
            self.ad_status = "off"
            return
        if now < self.ad_cooldown_until:
            self.ad_status = f"cooldown ({int(self.ad_cooldown_until - now)}s)"
            return

        # 1) Pending OCR hit whose human delay has elapsed
        if self.ad_pending_due_at is not None:
            if now >= self.ad_pending_due_at:
                rect = self.ad_visible_hit.rect if self.ad_visible_hit is not None else None
                self._collect_ad_gem(trigger="ocr", rect=rect)
                return
            self.ad_status = f"seen -> tapping in {self.ad_pending_due_at - now:.1f}s"
            return

        # 2) OCR detection pass
        if mode in ("detect", "both") and now - self.ad_last_scan >= float(cfg["scan_interval_sec"]):
            self.ad_last_scan = now
            try:
                hit = detectors.detect_ad_gem(frame, search_roi=cfg["search_roi"])
            except Exception as exc:
                self.stats["errors"] += 1
                self.ad_status = "ocr_error"
                self.log("error", f"Ad Gem OCR failed: {exc}")
                hit = None
            if hit is not None:
                self.ad_visible_hit = hit
                self.ad_last_ocr_text = hit.text
                self._cfg["ad_gems"]["tap_point"] = [hit.center[0], hit.center[1]]
                dmin, dmax = cfg["delay_sec"]
                delay = self._rng.uniform(float(dmin), float(dmax))
                self.ad_pending_due_at = now + delay
                self.ad_status = f"seen -> tapping in {delay:.1f}s"
                self.log("detect", f"Ad Gem spotted by OCR ({hit.text!r})", rect=list(hit.rect), delay_sec=round(delay, 1))
                if delay <= 0.05:
                    self._collect_ad_gem(trigger="ocr", rect=hit.rect)
                return
            self.ad_visible_hit = None

        # 3) Timer pass
        if mode in ("timer", "both") and now >= self.ad_next_timer_at:
            self._collect_ad_gem(trigger="timer")
            return

        self.ad_status = "watching" if mode in ("detect", "both") else "timer_armed"

    def _step_floating_gems(self, frame: np.ndarray, now: float) -> None:
        cfg = self._cfg["floating_gems"]
        mode = cfg["mode"]
        if mode == "off":
            self.fg_status = "off"
            return
        if now < self.fg_cooldown_until:
            self.fg_status = f"cooldown ({int(self.fg_cooldown_until - now)}s)"
            return

        # 1) Vision detection pass
        if mode in ("detect", "both") and now - self.fg_last_scan >= float(cfg["scan_interval_sec"]):
            self.fg_last_scan = now
            hit = detectors.detect_floating_gem(frame)
            if hit is not None:
                self.fg_visible_hit = hit
                self.log("detect", f"Floating Gem spotted (score {hit.score})", center=list(hit.center))
                self._collect_floating_gem(trigger="vision", detected=hit)
                return
            self.fg_visible_hit = None

        # 2) Timer orbit sweep pass
        if mode in ("timer", "both") and now >= self.fg_next_timer_at:
            self._collect_floating_gem(trigger="timer")
            return

        self.fg_status = "watching" if mode in ("detect", "both") else "timer_armed"

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            started = time.monotonic()
            try:
                with self._lock:
                    self.step_once()
            except Exception as exc:
                self.stats["errors"] += 1
                self.last_error = str(exc)
                self.log("error", f"Collector loop error: {exc}")
            elapsed = time.monotonic() - started
            wait = max(0.05, 0.5 - elapsed)
            self._stop_event.wait(wait)

    def status(self) -> dict[str, Any]:
        """Current collector state, countdowns, overlay shapes, and recent logs."""
        with self._lock:
            now = time.monotonic()
            fw, fh = self._frames.last_frame_size or (self._cfg["screen"]["width"], self._cfg["screen"]["height"])
            fg_cfg = self._cfg["floating_gems"]
            orbit_pts = detectors.orbit_tap_points(
                detectors.scale_point(tuple(fg_cfg["orbit_center"]), (fh, fw)),
                float(fg_cfg["orbit_radius"]) * (fw / detectors.REF_W),
                float(fg_cfg["orbit_angle_deg"]),
                int(fg_cfg["taps_per_burst"]),
                float(fg_cfg["orbit_spread_deg"]),
                0.0,
            )
            return {
                "running": self.running,
                "uptime_sec": round(time.time() - self.started_at, 1) if self.running and self.started_at else 0.0,
                "stream": {
                    "backend": self._frames.active_backend,
                    "requested_backend": self._cfg["stream"]["backend"],
                    "fps": self._frames.effective_fps(),
                    "frame_size": [fw, fh],
                    "last_error": self._frames.last_error,
                },
                "battle": {
                    "live": self.battle_live,
                    "menu_state": self.menu_state,
                    "foreground_blocker": self.foreground_blocker,
                    "wave": self.last_wave,
                    "last_error": self.last_error,
                },
                "ad_gems": {
                    "mode": self._cfg["ad_gems"]["mode"],
                    "status": self.ad_status,
                    "cooldown_sec": max(0.0, round(self.ad_cooldown_until - now, 1)),
                    "next_timer_sec": max(0.0, round(self.ad_next_timer_at - now, 1))
                    if self.running and self._cfg["ad_gems"]["mode"] in ("timer", "both")
                    else None,
                    "last_ocr_text": self.ad_last_ocr_text,
                    "tap_point": list(self._cfg["ad_gems"]["tap_point"]),
                    "visible_rect": list(self.ad_visible_hit.rect) if self.ad_visible_hit else None,
                },
                "floating_gems": {
                    "mode": fg_cfg["mode"],
                    "status": self.fg_status,
                    "cooldown_sec": max(0.0, round(self.fg_cooldown_until - now, 1)),
                    "next_timer_sec": max(0.0, round(self.fg_next_timer_at - now, 1))
                    if self.running and fg_cfg["mode"] in ("timer", "both")
                    else None,
                    "visible_rect": list(self.fg_visible_hit.rect) if self.fg_visible_hit else None,
                },
                "overlays": {
                    "frame_size": [fw, fh],
                    "ad_rail": list(detectors.scale_rect(tuple(self._cfg["ad_gems"]["search_roi"]), (fh, fw))),
                    "ad_tap": list(self._cfg["ad_gems"]["tap_point"]),
                    "ad_hit": list(self.ad_visible_hit.rect) if self.ad_visible_hit else None,
                    "floating_hit": list(self.fg_visible_hit.rect) if self.fg_visible_hit else None,
                    "orbit_points": [list(p) for p in orbit_pts],
                    "ability_row": list(detectors.scale_rect(detectors.REF_ABILITY_ROW, (fh, fw))),
                    "menu_toggle": list(detectors.scale_rect(detectors.REF_SIDE_MENU_TOGGLE, (fh, fw))),
                },
                "stats": dict(self.stats),
                "events": list(self._events)[:80],
            }
