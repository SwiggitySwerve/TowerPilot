"""Explicit user-triggered Battle Setup Test & gated low-wave surrender controller.

Allows iterating on battle setup (enter battle -> verify wave/HUD -> surrender ->
GAME STATS -> HOME -> hold) WITHOUT ever risking a live farming or tournament run:
- Never scheduled or triggered automatically; requires explicit user command.
- Hard-refuses tournament battles.
- Hard-refuses surrender whenever wave is unreadable or exceeds `max_wave` (hard cap <= 100).
- Runs 1 step per collector tick (zero extra threads) with fresh ADB + foreground checks.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

import numpy as np

from towerpilot import detectors, screens

MAX_ALLOWED_WAVE_CAP = 100
DEFAULT_MAX_WAVE = 50
_STEP_COOLDOWN_SEC = 1.2
_MAX_FAILURES = 4


class SetupTester:
    """Single-step-per-tick gated setup-test iteration & low-wave surrender controller."""

    def __init__(
        self,
        *,
        grab_verified_frame: Callable[[], tuple[np.ndarray, int | None]],
        check_foreground: Callable[[int | None], tuple[bool, str]],
        tap: Callable[..., dict[str, Any] | None],
        log: Callable[..., Any],
        notify: Callable[[str], None] | None = None,
        stop_event: threading.Event | None = None,
        step_cooldown_sec: float = _STEP_COOLDOWN_SEC,
    ) -> None:
        self._grab = grab_verified_frame
        self._check_fg = check_foreground
        self._tap = tap
        self._log = log
        self._notify = notify
        self._stop_event = stop_event or threading.Event()
        self._cooldown_sec = step_cooldown_sec

        self._lock = threading.RLock()
        self.active: bool = False
        self.mode: str = "idle"  # idle | iteration | surrender_only
        self.phase: str = "idle"  # idle | enter_battle | wait_battle | open_menu | tap_exit | confirm_surrender | tap_home | done | aborted
        self.max_wave: int = DEFAULT_MAX_WAVE
        self.detail: str = ""
        self.error: str | None = None
        self.iterations_completed: int = 0
        self._next_step_at: float = 0.0
        self._failures: int = 0

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "active": self.active,
                "mode": self.mode,
                "phase": self.phase,
                "max_wave": self.max_wave,
                "detail": self.detail,
                "error": self.error,
                "iterations_completed": self.iterations_completed,
            }

    @staticmethod
    def _validate_max_wave(max_wave: int) -> int:
        if isinstance(max_wave, bool) or not isinstance(max_wave, int):
            raise ValueError("max_wave must be an integer")
        if not (1 <= max_wave <= MAX_ALLOWED_WAVE_CAP):
            raise ValueError(f"max_wave must be between 1 and {MAX_ALLOWED_WAVE_CAP}")
        return max_wave

    def start_surrender(
        self,
        *,
        battle_live: bool,
        current_wave: int | None,
        is_tournament: bool = False,
        max_wave: int = DEFAULT_MAX_WAVE,
    ) -> dict[str, Any]:
        """Request an immediate gated surrender of a low-wave non-tournament battle."""
        cap = self._validate_max_wave(max_wave)
        if not battle_live:
            raise RuntimeError("No live battle to surrender")
        if is_tournament:
            raise RuntimeError("Refused: setup-test surrender never cancels a tournament run")
        if current_wave is None:
            raise RuntimeError("Refused: current wave is unreadable; refusing blind surrender")
        if current_wave > cap:
            raise RuntimeError(
                f"Refused: live battle is at Wave {current_wave} (exceeds safety cap {cap})"
            )
        with self._lock:
            self.active = True
            self.mode = "surrender_only"
            self.phase = "open_menu"
            self.max_wave = cap
            self.detail = f"Surrendering Wave {current_wave} (cap {cap})"
            self.error = None
            self._next_step_at = 0.0
            self._failures = 0
            self._log(
                f"Setup test surrender armed at Wave {current_wave} (cap {cap})",
                event="setup_test_started",
                mode="surrender_only",
                wave=current_wave,
                max_wave=cap,
            )
            return self.status()

    def start_iteration(
        self,
        *,
        battle_live: bool,
        current_wave: int | None,
        max_wave: int = DEFAULT_MAX_WAVE,
    ) -> dict[str, Any]:
        """Start a Home -> Battle -> verify wave <= cap -> Surrender -> Home setup test."""
        cap = self._validate_max_wave(max_wave)
        if battle_live and (current_wave is None or current_wave > cap):
            raise RuntimeError(
                f"Live battle in progress (wave={current_wave}); wait until it finishes before running a setup test"
            )
        with self._lock:
            self.active = True
            self.mode = "iteration"
            self.phase = "open_menu" if battle_live else "enter_battle"
            self.max_wave = cap
            self.detail = "Entering battle for setup test" if not battle_live else f"Surrendering Wave {current_wave}"
            self.error = None
            self._next_step_at = 0.0
            self._failures = 0
            self._log(
                f"Setup test iteration armed (cap Wave {cap})",
                event="setup_test_started",
                mode="iteration",
                max_wave=cap,
            )
            return self.status()

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            was_active = self.active
            self.active = False
            self.mode = "idle"
            self.phase = "idle"
            self.detail = ""
            self.error = None
            if was_active:
                self._log("Setup test cancelled", event="setup_test_cancelled")
            return self.status()

    def _abort(self, reason: str) -> bool:
        self.active = False
        self.mode = "idle"
        self.phase = "aborted"
        self.detail = reason
        self.error = reason
        self._log(f"Setup test aborted: {reason}", event="setup_test_aborted", reason=reason)
        if callable(self._notify):
            try:
                self._notify(f"Setup test aborted: {reason}")
            except Exception:
                pass
        return False

    def _verified_grab_and_fg(self) -> tuple[np.ndarray, int | None] | None:
        if self._stop_event.is_set():
            self.cancel()
            return None
        try:
            fresh, input_display = self._grab()
        except Exception as exc:
            self._failures += 1
            if self._failures >= _MAX_FAILURES:
                self._abort(f"capture failed: {exc}")
            return None
        fg_ok, fg_why = self._check_fg(input_display)
        if not fg_ok:
            self._abort(f"foreground blocked: {fg_why}")
            return None
        return fresh, input_display

    def _check_wave_and_tourney_guard(self, frame: np.ndarray, *, known_wave: int | None) -> tuple[bool, str]:
        meta = detectors.read_battle_hud_meta(frame)
        if meta.get("tournament"):
            return False, "tournament battle detected — surrender strictly forbidden"
        wave = detectors.read_wave_ocr(frame)
        eff_wave = wave if wave is not None else known_wave
        if eff_wave is None:
            return False, "wave unreadable — refusing blind surrender"
        if eff_wave > self.max_wave:
            return False, f"Wave {eff_wave} exceeds safety cap {self.max_wave}"
        return True, f"Wave {eff_wave}"

    def step(self, frame: np.ndarray, now: float, *, known_wave: int | None = None) -> bool:
        """Execute at most one verified setup-test step; returns True when owning control."""
        with self._lock:
            if not self.active:
                return False
            if now < self._next_step_at:
                return True

            in_battle = detectors.menu_toggle_visible(frame)

            if self.phase == "enter_battle":
                if in_battle:
                    self.phase = "wait_battle"
                    self.detail = "Battle started; verifying wave"
                    self._next_step_at = now + self._cooldown_sec
                    return True
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return True
                fresh, input_display = grabbed
                scr = screens.identify(fresh)
                if scr.name == "battle":
                    self.phase = "wait_battle"
                    self._next_step_at = now + self._cooldown_sec
                    return True
                if scr.name == "home" and "battle" in scr.targets:
                    target = scr.targets["battle"]
                    if not screens.validate_target("home", target, fresh.shape):
                        return self._abort("battle target failed safety validation")
                    pt = detectors.sample_interior_point(target.rect, inset_px=target.inset_px)
                    res = self._tap(pt, fresh, reason="setup_test:enter_battle", input_display=input_display)
                    if res is not None:
                        self.phase = "wait_battle"
                        self.detail = "Tapped BATTLE; waiting for wave"
                        self._failures = 0
                        self._next_step_at = now + 2.0
                    return True
                if scr.name == "game_stats" and "home" in scr.targets:
                    target = scr.targets["home"]
                    pt = detectors.sample_interior_point(target.rect, inset_px=target.inset_px)
                    self._tap(pt, fresh, reason="setup_test:clear_stats", input_display=input_display)
                    self._next_step_at = now + 1.5
                    return True
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort(f"expected home screen to start battle, saw {scr.name}")
                self._next_step_at = now + self._cooldown_sec
                return True

            if self.phase == "wait_battle":
                if not in_battle:
                    self._failures += 1
                    if self._failures >= _MAX_FAILURES:
                        return self._abort("battle HUD did not appear after tapping BATTLE")
                    self._next_step_at = now + self._cooldown_sec
                    return True
                ok, info = self._check_wave_and_tourney_guard(frame, known_wave=known_wave)
                if not ok:
                    return self._abort(info)
                self.phase = "open_menu"
                self.detail = f"Verified {info}; opening side menu"
                self._failures = 0
                self._next_step_at = now + 0.5
                return True

            if self.phase == "open_menu":
                if not in_battle:
                    # Already left battle (confirm dialog or stats)
                    self.phase = "confirm_surrender"
                    self._next_step_at = now + 0.5
                    return True
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return True
                fresh, input_display = grabbed
                ok, info = self._check_wave_and_tourney_guard(fresh, known_wave=known_wave)
                if not ok:
                    return self._abort(info)
                mstate = detectors.side_menu_state(fresh)
                if mstate == "open":
                    self.phase = "tap_exit"
                    self.detail = "Side menu open; locating EXIT BATTLE"
                    self._failures = 0
                    self._next_step_at = now + 0.4
                    return True
                if mstate == "closed":
                    rect = detectors.scale_rect(detectors.REF_SIDE_MENU_TOGGLE, fresh.shape)
                    pt = detectors.sample_interior_point(rect, inset_px=12)
                    res = self._tap(pt, fresh, reason="setup_test:open_side_menu", input_display=input_display)
                    if res is not None:
                        self.phase = "tap_exit"
                        self.detail = "Opening side menu"
                        self._failures = 0
                        self._next_step_at = now + 1.0
                    return True
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort("side menu toggle obscured")
                self._next_step_at = now + self._cooldown_sec
                return True

            if self.phase == "tap_exit":
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return True
                fresh, input_display = grabbed
                if not detectors.menu_toggle_visible(fresh):
                    self.phase = "confirm_surrender"
                    self._next_step_at = now + 0.5
                    return True
                ok, info = self._check_wave_and_tourney_guard(fresh, known_wave=known_wave)
                if not ok:
                    return self._abort(info)
                if detectors.side_menu_state(fresh) == "closed":
                    self.phase = "open_menu"
                    self._next_step_at = now + 0.5
                    return True
                hit = detectors.detect_exit_battle_button(fresh)
                if hit is not None:
                    pt = detectors.sample_interior_point(hit.rect, inset_px=10)
                    res = self._tap(pt, fresh, reason=f"setup_test:{hit.label.lower()}", input_display=input_display)
                    if res is not None:
                        self.phase = "confirm_surrender"
                        self.detail = f"Tapped {hit.label}; waiting for confirmation"
                        self._failures = 0
                        self._next_step_at = now + 1.2
                    return True
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort("EXIT BATTLE / END ROUND button not found")
                self._next_step_at = now + self._cooldown_sec
                return True

            if self.phase == "confirm_surrender":
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return True
                fresh, input_display = grabbed
                # Check if GAME STATS already appeared
                if detectors.detect_end_stats_home(fresh) is not None:
                    self.phase = "tap_home"
                    self.detail = "GAME STATS up; tapping HOME"
                    self._failures = 0
                    self._next_step_at = now + 0.6
                    return True
                hit = detectors.detect_surrender_confirm(fresh)
                if hit is not None:
                    pt = detectors.sample_interior_point(hit.rect, inset_px=12)
                    res = self._tap(pt, fresh, reason=f"setup_test:confirm_{hit.label.lower()}", input_display=input_display)
                    if res is not None:
                        self.phase = "tap_home"
                        self.detail = f"Confirmed {hit.label}; waiting for GAME STATS"
                        self._failures = 0
                        self._log(
                            f"Setup test surrendered ({hit.label})",
                            event="setup_test_surrendered",
                            label=hit.label,
                            max_wave=self.max_wave,
                        )
                        self._next_step_at = now + 1.5
                    return True
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort("Surrender confirmation dialog not found")
                self._next_step_at = now + self._cooldown_sec
                return True

            if self.phase == "tap_home":
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return True
                fresh, input_display = grabbed
                scr = screens.identify(fresh)
                if scr.name == "home":
                    self.active = False
                    self.mode = "idle"
                    self.phase = "done"
                    self.iterations_completed += 1
                    self.detail = f"Returned to Home (iteration #{self.iterations_completed})"
                    self._log(
                        self.detail,
                        event="setup_test_completed",
                        iterations_completed=self.iterations_completed,
                    )
                    return False
                if scr.name == "game_stats" and "home" in scr.targets:
                    target = scr.targets["home"]
                    pt = detectors.sample_interior_point(target.rect, inset_px=target.inset_px)
                    res = self._tap(pt, fresh, reason="setup_test:stats_home", input_display=input_display)
                    if res is not None:
                        self.detail = "Tapped HOME; verifying Home screen"
                        self._failures = 0
                        self._next_step_at = now + 1.5
                    return True
                # Dialog might still be up if fade swallowed the confirm tap
                confirm_hit = detectors.detect_surrender_confirm(fresh)
                if confirm_hit is not None:
                    self.phase = "confirm_surrender"
                    self._next_step_at = now + 0.5
                    return True
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort(f"did not return to Home after surrender (saw {scr.name})")
                self._next_step_at = now + self._cooldown_sec
                return True

            return False
