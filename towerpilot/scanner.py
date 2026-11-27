"""Automated step-per-tick inventory scanner for Cards and Modules.

Drives off-battle inventory sweeps inside GemCollector's existing loop (0 extra
threads, at most 1 verified ADB tap or swipe per tick). Enforces all hard safety
rails: fresh ADB frame + unobstructed foreground check before every action,
immediate abort on live battle or foreground blocker, strict coordinate and
label allowlists, and 3-strike abort on unexpected screens.
"""
from __future__ import annotations

import random
import re
import threading
import time
from typing import Any, Callable

import numpy as np

from towerpilot import detectors, loadouts, screens

VALID_SCOPES: tuple[str, ...] = ("all", "cards", "modules")

_MAX_FAILURES = 3
_MAX_CARD_PAGES = 8
_CARD_STALL_THRESHOLD = 2
_CARD_STALL_MAD = 2.5
_MAX_SCROLL_TOP_SWIPES = 6
_SWIPE_DURATION_MS = 550

# Reference 1080x2560 geometry fences
_REF_INV_ROI = (30, 1000, 1020, 1360)
_REF_INV_SWIPE_X, _REF_INV_SWIPE_BOT_Y, _REF_INV_SWIPE_TOP_Y = 540, 2050, 1250
_REF_MOD_SLOT_X = (100, 980)
_REF_MOD_SLOT_Y = (450, 870)
_REF_MOD_SAFE_DISMISS = (540, 140)
_REF_MOD_CLOSE_X_MIN, _REF_MOD_CLOSE_Y = 680, (80, 900)
_REF_MOD_BUY_Y = (310, 420)


def _home_has_resume(screen: screens.Screen) -> bool:
    return screen.name == "home" and bool(screen.facts.get("has_resume") or "resume" in screen.targets)


def _is_forbidden_detail(detail: dict[str, Any]) -> bool:
    if detail.get("forbidden"):
        return True
    for key in ("name", "forbidden_text", "popup_text", "raw_text"):
        val = detail.get(key)
        if isinstance(val, str) and screens.is_forbidden_label(val):
            return True
    for sub in detail.get("substats") or ():
        if isinstance(sub, str) and screens.is_forbidden_label(sub):
            return True
    return False

_PRESET_NUM_RE = re.compile(r"preset\s*(\d+)", re.IGNORECASE)


def _preset_num(label: str | None) -> int | None:
    m = _PRESET_NUM_RE.search(label or "")
    return int(m.group(1)) if m else None


def _preset_target_name(screen_name: str, preset_label: str | None) -> str | None:
    num = _preset_num(preset_label)
    if num is None:
        return None
    if (screen_name == "cards" and 1 <= num <= 5) or (screen_name == "modules" and num in (1, 2)):
        return f"preset_{num}"
    return None


def _order_presets(presets: list[str] | None, active: str | None) -> list[str | None]:
    seen: list[str] = []
    for item in presets or []:
        clean = " ".join(str(item).strip().split())
        if clean and clean not in seen:
            seen.append(clean)
    seen.sort(key=lambda s: (_preset_num(s) or 999, s))
    clean_active = " ".join(active.strip().split()) if active else None
    if clean_active:
        return [clean_active] + [p for p in seen if p != clean_active]
    return list(seen) if seen else [None]


def _inventory_roi(frame: np.ndarray) -> np.ndarray:
    x, y, w, h = detectors.scale_rect(_REF_INV_ROI, frame.shape)
    return frame[y : y + h, x : x + w].copy()


def _roi_mad(prev_roi: np.ndarray, curr_roi: np.ndarray) -> float:
    if prev_roi.shape != curr_roi.shape or prev_roi.size == 0:
        return 255.0
    return float(np.mean(np.abs(curr_roi.astype(np.float32) - prev_roi.astype(np.float32))))


class InventoryScanner:
    """Single-step-per-tick automated Cards & Modules inventory scanner."""

    def __init__(
        self,
        *,
        grab_verified_frame: Callable[[], tuple[np.ndarray, int | None]],
        check_foreground: Callable[[int | None], tuple[bool, str]],
        tap: Callable[..., dict[str, Any] | None],
        swipe: Callable[..., dict[str, Any] | None],
        log: Callable[..., Any],
        notify: Callable[[str, str], None],
        stop_event: threading.Event,
        account_store: loadouts.AccountStore,
        rng: random.Random | None = None,
        step_delay_sec: tuple[float, float] = (0.6, 1.0),
        identify_fn: Callable[[np.ndarray], screens.Screen] | None = None,
        parse_cards_fn: Callable[[np.ndarray], dict[str, Any]] | None = None,
        parse_modules_fn: Callable[[np.ndarray], dict[str, Any]] | None = None,
        parse_detail_fn: Callable[[np.ndarray], dict[str, Any] | None] | None = None,
    ) -> None:
        self._grab_verified_frame = grab_verified_frame
        self._check_foreground = check_foreground
        self._tap = tap
        self._swipe = swipe
        self._log = log
        self._notify = notify
        self._stop_event = stop_event
        self._account_store = account_store
        self._rng = rng or random.Random()
        self._step_delay_sec = step_delay_sec
        self._identify_fn = identify_fn
        self._parse_cards_fn = parse_cards_fn
        self._parse_modules_fn = parse_modules_fn
        self._parse_detail_fn = parse_detail_fn

        self.running: bool = False
        self.queued: bool = False
        self.scope: str = "all"
        self.phase: str = "idle"
        self.detail: str = ""
        self.progress: str = ""
        self.last_scan_at: float | None = None
        self.error: str | None = None
        self._reset_cursor()

    def _reset_cursor(self) -> None:
        self._phase_queue: list[str] = []
        self._substate: str = ""
        self._failures: int = 0
        self._next_step_at: float = 0.0
        self._awaiting_preset: str | None = None
        self._cancelling: bool = False
        self._abort_after_restore: tuple[str, str] | None = None

        self._orig_card_preset: str | None = None
        self._card_presets: list[str | None] = []
        self._card_preset_idx: int = 0
        self._card_page_idx: int = 0
        self._card_stall_count: int = 0
        self._card_prev_inv: np.ndarray | None = None
        self._card_scroll_top_count: int = 0

        self._orig_mod_preset: str | None = None
        self._mod_presets: list[str | None] = []
        self._mod_preset_idx: int = 0
        self._mod_slots: dict[str, dict[str, Any]] = {}
        self._mod_slot_idx: int = 0
        self._mod_current_slot: str | None = None
        self._mod_current_base: dict[str, Any] = {}

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "queued": self.queued,
            "scope": self.scope,
            "phase": self.phase,
            "detail": self.detail,
            "progress": self.progress,
            "last_scan_at": self.last_scan_at,
            "error": self.error,
        }

    def _start_now(self, scope: str, *, reason_detail: str = "Preparing scan") -> None:
        self._reset_cursor()
        self.scope, self.running, self.queued = scope, True, False
        self.phase, self.detail, self.progress, self.error = "starting", reason_detail, "", None
        self._phase_queue = [
            *([p for p in ("cards", "modules") if scope in ("all", p)]),
            "returning",
        ]

    def request_scan(self, *, scope: str = "all", battle_live: bool, queue_if_battle: bool = True) -> dict[str, Any]:
        if scope not in VALID_SCOPES:
            raise ValueError(f"scope must be one of {VALID_SCOPES}")
        if self.running:
            return self.status()
        if battle_live:
            if queue_if_battle:
                self._reset_cursor()
                self.scope, self.running, self.queued = scope, False, True
                self.phase, self.detail, self.progress, self.error = "queued", "Waiting for run boundary", "", None
                self._log(f"Inventory scan queued for next boundary ({scope})", event="inventory_scan_queued", scope=scope)
                return self.status()
            raise RuntimeError("Battle is live; queue for next boundary or wait until battle ends")

        self._start_now(scope)
        self._log(f"Inventory scan started ({scope})", event="inventory_scan_started", scope=scope)
        return self.status()

    def cancel(self, *, hard: bool = False) -> dict[str, Any]:
        if (
            not hard
            and self.running
            and not self._stop_event.is_set()
            and self._substate != "restore"
            and (
                (self.phase == "cards" and self._orig_card_preset)
                or (self.phase == "modules" and self._orig_mod_preset)
            )
        ):
            self._cancelling = True
            self._abort_after_restore = None
            self._phase_queue = []
            self._substate = "restore"
            self._failures = 0
            self._awaiting_preset = None
            self._next_step_at = 0.0
            self.detail = "Cancelling — restoring original preset"
            self._log("Inventory scan cancelling (restoring preset)", event="inventory_scan_cancelled", scope=self.scope)
            return self.status()
        self._reset_cursor()
        self.running = self.queued = False
        self.phase, self.detail, self.progress, self.error = "idle", "", "", None
        self._log("Inventory scan cancelled", event="inventory_scan_cancelled", scope=self.scope)
        return self.status()

    def abort_for_battle(self) -> None:
        if self.running:
            self._abort("Paused: live battle detected", reason="battle_live")

    def _abort(self, error_msg: str, *, reason: str = "aborted", notify: bool = True) -> None:
        if (
            reason not in ("battle_live", "forbidden_prompt", "forbidden_target", "home_resume_pending", "unsafe_swipe")
            and self.running
            and not self._stop_event.is_set()
            and self._substate != "restore"
            and self._abort_after_restore is None
            and (
                (self.phase == "cards" and self._orig_card_preset)
                or (self.phase == "modules" and self._orig_mod_preset)
            )
        ):
            self._abort_after_restore = (error_msg, reason)
            self._phase_queue = []
            self._substate = "restore"
            self._failures = 0
            self._awaiting_preset = None
            self._next_step_at = 0.0
            self.detail = f"Restoring preset before pausing ({error_msg})"
            return
        self._reset_cursor()
        self.running = self.queued = False
        self.phase, self.detail, self.progress, self.error = "error", "", "", error_msg
        self._log(f"Inventory scan aborted: {error_msg}", event="inventory_scan_aborted", scope=self.scope, reason=reason, error=error_msg)
        if notify:
            self._notify(f"Inventory scan paused: {error_msg}", "Tower Pilot")

    def _record_failure(self, msg: str) -> bool:
        self._failures += 1
        self._log(f"Inventory scan step failed ({self._failures}/{_MAX_FAILURES}): {msg}", event="inventory_scan_warning", phase=self.phase, failures=self._failures, error=msg)
        if self._failures >= _MAX_FAILURES:
            self._abort(msg, reason="max_failures", notify=True)
            return True
        return False

    def _arm_delay(self, now: float) -> None:
        dmin, dmax = self._step_delay_sec
        self._next_step_at = now + max(0.0, self._rng.uniform(float(dmin), float(dmax)))

    def _identify(self, frame: np.ndarray) -> screens.Screen:
        return self._identify_fn(frame) if self._identify_fn is not None else screens.identify(frame)

    def _parse_cards(self, frame: np.ndarray) -> dict[str, Any]:
        return self._parse_cards_fn(frame) if self._parse_cards_fn is not None else loadouts.parse_cards_page(frame)

    def _parse_modules(self, frame: np.ndarray) -> dict[str, Any]:
        return self._parse_modules_fn(frame) if self._parse_modules_fn is not None else loadouts.parse_modules_equipped(frame)

    def _parse_detail(self, frame: np.ndarray) -> dict[str, Any] | None:
        return self._parse_detail_fn(frame) if self._parse_detail_fn is not None else loadouts.parse_module_detail(frame)

    def try_start_from_frame(self, frame: np.ndarray, now: float) -> bool:
        """Promote a queued scan to running once cleanly on home, cards, or modules."""
        if self.running or not self.queued or self._stop_event.is_set() or detectors.menu_toggle_visible(frame):
            return False
        try:
            scr = self._identify(frame)
        except Exception:
            return False
        if scr.name not in ("home", "cards", "modules") or _home_has_resume(scr):
            return False
        self._start_now(self.scope, reason_detail=f"Starting from {scr.name}")
        self._log(f"Queued inventory scan started on {scr.name} ({self.scope})", event="inventory_scan_started", scope=self.scope, screen=scr.name)
        return True

    def _grab_and_verify(self) -> tuple[np.ndarray, int | None] | None:
        if self._stop_event.is_set():
            self.cancel()
            return None
        try:
            fresh, input_display = self._grab_verified_frame()
        except Exception as exc:
            self._record_failure(f"ADB capture failed: {exc}")
            return None
        if self._stop_event.is_set():
            self.cancel()
            return None
        if detectors.menu_toggle_visible(fresh):
            self.abort_for_battle()
            return None
        fg_ok, fg_why = self._check_foreground(input_display)
        if not fg_ok:
            self._abort(f"Foreground blocked ({fg_why})", reason=fg_why)
            return None
        return fresh, input_display

    def _tap_validated_target(
        self, fresh: np.ndarray, input_display: int | None, screen: screens.Screen, target_name: str, *, reason: str, now: float
    ) -> bool:
        target = screen.targets.get(target_name)
        if target is None or not screens.validate_target(screen.name, target, fresh.shape):
            self._record_failure(f"Target '{target_name}' rejected on {screen.name}")
            return False
        if screens.is_forbidden_label(target.label) or screens.is_forbidden_label(target.name):
            self._abort(f"Forbidden target label '{target.label}'", reason="forbidden_target")
            return False
        pt = detectors.sample_interior_point(target.rect, inset_px=target.inset_px, rng=self._rng)
        if self._tap(pt, fresh, reason=reason, input_display=input_display) is None:
            self._record_failure(f"Tap refused for {screen.name}.{target_name}")
            return False
        self._arm_delay(now)
        return True

    def _ensure_preset(
        self,
        fresh: np.ndarray,
        input_display: int | None,
        screen: screens.Screen,
        target_preset: str | None,
        *,
        detail_prefix: str,
        reason_prefix: str,
        now: float,
    ) -> bool:
        """Return True when already on target_preset; otherwise tap pill and return False."""
        active_preset = screen.facts.get("active_preset")
        if not target_preset or active_preset == target_preset:
            self._awaiting_preset = None
            self._failures = 0
            return True
        if self._awaiting_preset == target_preset:
            if self._record_failure(f"{screen.name.title()} preset did not switch to {target_preset}"):
                return False
        tname = _preset_target_name(screen.name, target_preset)
        if tname is None or tname not in screen.targets:
            self._record_failure(f"{screen.name.title()} preset target missing for {target_preset}")
            return False
        self._awaiting_preset = target_preset
        self.detail = f"{detail_prefix} {target_preset}"
        self._tap_validated_target(fresh, input_display, screen, tname, reason=f"{reason_prefix}_{tname}", now=now)
        return False

    def _swipe_inventory(self, fresh: np.ndarray, input_display: int | None, *, direction: str, reason: str, now: float) -> bool:
        ref_start = (_REF_INV_SWIPE_X, _REF_INV_SWIPE_BOT_Y if direction == "down" else _REF_INV_SWIPE_TOP_Y)
        ref_end = (_REF_INV_SWIPE_X, _REF_INV_SWIPE_TOP_Y if direction == "down" else _REF_INV_SWIPE_BOT_Y)
        sx1, sy1 = detectors.scale_point(ref_start, fresh.shape)
        sx2, sy2 = detectors.scale_point(ref_end, fresh.shape)
        start_pt, end_pt = (int(round(sx1)), int(round(sy1))), (int(round(sx2)), int(round(sy2)))
        fh, fw = fresh.shape[:2]
        y_lo, y_hi = int(round(1000 * (fh / detectors.REF_H))), int(round(2350 * (fh / detectors.REF_H)))
        if not (y_lo <= start_pt[1] <= y_hi and y_lo <= end_pt[1] <= y_hi and 0 < start_pt[0] < fw):
            self._abort("Inventory swipe outside safe bounds", reason="unsafe_swipe")
            return False
        res = self._swipe(start_pt, end_pt, fresh, duration_ms=_SWIPE_DURATION_MS, reason=reason, input_display=input_display)
        if res is None:
            self._record_failure(f"Swipe refused ({reason})")
            return False
        self._arm_delay(now)
        return True

    def _safe_module_slot_point(self, center: Any, slot: str, frame_shape: tuple[int, ...]) -> tuple[int, int] | None:
        fh, fw = int(frame_shape[0]), int(frame_shape[1])
        sx, sy = fw / detectors.REF_W, fh / detectors.REF_H
        if isinstance(center, (tuple, list)) and len(center) == 2:
            cx, cy = int(round(center[0])), int(round(center[1]))
        else:
            rx, ry, rw, rh = detectors.scale_rect(loadouts.REF_MODULE_SLOTS[slot], frame_shape)
            cx, cy = rx + rw // 2, ry + rh // 2
        if (
            int(round(_REF_MOD_SLOT_X[0] * sx)) <= cx <= int(round(_REF_MOD_SLOT_X[1] * sx))
            and int(round(_REF_MOD_SLOT_Y[0] * sy)) <= cy <= int(round(_REF_MOD_SLOT_Y[1] * sy))
        ):
            return (cx, cy)
        return None

    def _safe_module_dismiss_point(self, close_center: Any, frame_shape: tuple[int, ...]) -> tuple[int, int]:
        fh, fw = int(frame_shape[0]), int(frame_shape[1])
        sx, sy = fw / detectors.REF_W, fh / detectors.REF_H
        if isinstance(close_center, (tuple, list)) and len(close_center) == 2:
            cx, cy = int(round(close_center[0])), int(round(close_center[1]))
            in_buy_band = int(round(_REF_MOD_BUY_Y[0] * sy)) <= cy <= int(round(_REF_MOD_BUY_Y[1] * sy))
            if (
                not in_buy_band
                and int(round(_REF_MOD_CLOSE_X_MIN * sx)) <= cx < fw
                and int(round(_REF_MOD_CLOSE_Y[0] * sy)) <= cy <= int(round(_REF_MOD_CLOSE_Y[1] * sy))
            ):
                return (cx, cy)
        dx, dy = detectors.scale_point(_REF_MOD_SAFE_DISMISS, frame_shape)
        return (int(round(dx)), int(round(dy)))

    def _advance_phase(self) -> None:
        if self._cancelling:
            self.cancel(hard=True)
            return
        if self._abort_after_restore is not None:
            err_msg, err_reason = self._abort_after_restore
            self._abort(err_msg, reason=err_reason, notify=True)
            return
        self.phase = self._phase_queue.pop(0) if self._phase_queue else "returning"
        self._substate = "route"
        self._failures = 0
        self._awaiting_preset = None

    def _route_to(self, fresh: np.ndarray, input_display: int | None, screen: screens.Screen, dst: str, now: float) -> bool:
        if _home_has_resume(screen):
            self._abort("Paused: crashed-run RESUME pending on Home", reason="home_resume_pending")
            return False
        path = screens.plan_path(screen.name, dst)
        if not path:
            self._record_failure(f"Unexpected screen '{screen.name}' while routing to {dst}")
            return False
        edge = path[0]
        self.detail = f"Navigating {screen.name} -> {edge.dst}"
        return self._tap_validated_target(fresh, input_display, screen, edge.target_name, reason=f"scan:nav_{dst}", now=now)

    def step(self, frame: np.ndarray, now: float) -> bool:
        """Advance the inventory scan by at most one verified ADB action."""
        if self._stop_event.is_set():
            if self.running:
                self.cancel()
            return False
        if not self.running:
            if not (self.queued and self.try_start_from_frame(frame, now)):
                return False
        if detectors.menu_toggle_visible(frame):
            self.abort_for_battle()
            return False
        if now < self._next_step_at:
            return True

        verified = self._grab_and_verify()
        if verified is None:
            return self.running
        fresh, input_display = verified
        if self.phase == "starting":
            self._advance_phase()

        screen_cache: list[screens.Screen | None] = [None]

        def _get_screen() -> screens.Screen:
            if screen_cache[0] is None:
                screen_cache[0] = self._identify(fresh)
            return screen_cache[0]

        for _ in range(8):
            if not self.running:
                return False
            if self.phase == "cards":
                done_tick = self._step_cards(fresh, input_display, now, _get_screen)
            elif self.phase == "modules":
                done_tick = self._step_modules(fresh, input_display, now, _get_screen)
            elif self.phase == "returning":
                done_tick = self._step_returning(fresh, input_display, now, _get_screen)
            else:
                return False
            if done_tick:
                return self.running
        return self.running

    def _step_cards(self, fresh: np.ndarray, input_display: int | None, now: float, get_screen: Callable[[], screens.Screen]) -> bool:
        try:
            screen = get_screen()
        except Exception as exc:
            self._record_failure(f"Cards identify failed: {exc}")
            return True
        if screen.name != "cards":
            self._route_to(fresh, input_display, screen, "cards", now)
            return True

        active_preset = screen.facts.get("active_preset")
        if self._substate == "route":
            self._failures = 0
            self._orig_card_preset = active_preset
            self._card_presets = _order_presets(screen.facts.get("presets"), active_preset)
            self._card_preset_idx = 0
            self._substate = "preset_select"

        if self._substate == "preset_select":
            target_preset = self._card_presets[self._card_preset_idx]
            self.progress = f"Preset {self._card_preset_idx + 1}/{len(self._card_presets)}"
            if not self._ensure_preset(fresh, input_display, screen, target_preset, detail_prefix="Switching to", reason_prefix="scan:cards", now=now):
                return True
            self._card_page_idx = self._card_stall_count = 0
            self._card_prev_inv = None
            self._substate = "scan_page"

        if self._substate == "scan_page":
            preset_label = self._card_presets[self._card_preset_idx] or active_preset
            self.progress = f"Preset {self._card_preset_idx + 1}/{len(self._card_presets)}"
            inv_roi = _inventory_roi(fresh)
            mad = 255.0
            if self._card_page_idx > 0 and self._card_prev_inv is not None:
                mad = _roi_mad(self._card_prev_inv, inv_roi)
                self._card_stall_count = self._card_stall_count + 1 if mad < _CARD_STALL_MAD else 0

            if self._card_page_idx == 0 or mad >= _CARD_STALL_MAD:
                try:
                    parsed = self._parse_cards(fresh)
                except Exception as exc:
                    self._record_failure(f"Cards parse failed: {exc}")
                    return True
                self._account_store.record_cards_scan(
                    preset_label or parsed.get("active_preset"),
                    list(parsed.get("cards") or []),
                    active_slots=parsed.get("active_slots"),
                    replace_preset=(self._card_page_idx == 0),
                )
                self._card_prev_inv = inv_roi
                self._failures = 0

            if self._card_stall_count >= _CARD_STALL_THRESHOLD or self._card_page_idx >= _MAX_CARD_PAGES:
                self._card_preset_idx += 1
                if self._card_preset_idx < len(self._card_presets):
                    self._substate, self._card_scroll_top_count, self._card_prev_inv = "scroll_top", 0, inv_roi
                else:
                    self._substate = "restore"
                return False

            self._card_page_idx += 1
            self.detail = f"{preset_label or 'Cards'} · page {self._card_page_idx + 1}"
            self._swipe_inventory(fresh, input_display, direction="down", reason="scan:cards_scroll_down", now=now)
            return True

        if self._substate == "scroll_top":
            inv_roi = _inventory_roi(fresh)
            if (self._card_scroll_top_count > 0 and self._card_prev_inv is not None and _roi_mad(self._card_prev_inv, inv_roi) < _CARD_STALL_MAD) or self._card_scroll_top_count >= _MAX_SCROLL_TOP_SWIPES:
                self._substate = "preset_select"
                return False
            self._card_prev_inv = inv_roi
            self._card_scroll_top_count += 1
            self.detail = "Scrolling to top"
            self._swipe_inventory(fresh, input_display, direction="up", reason="scan:cards_scroll_top", now=now)
            return True

        if self._substate == "restore":
            if not self._ensure_preset(fresh, input_display, screen, self._orig_card_preset, detail_prefix="Restoring", reason_prefix="scan:cards_restore", now=now):
                return True
            self._advance_phase()
            return False
        return True

    def _step_modules(self, fresh: np.ndarray, input_display: int | None, now: float, get_screen: Callable[[], screens.Screen]) -> bool:
        if self._substate == "read_detail":
            return self._step_module_read_detail(fresh, input_display, now, get_screen)

        try:
            screen = get_screen()
        except Exception as exc:
            self._record_failure(f"Modules identify failed: {exc}")
            return True

        if self._substate == "verify_closed":
            if screen.name == "modules":
                self._failures = 0
                self._substate = "tap_slot"
            else:
                if self._record_failure(f"Expected modules after closing detail, got {screen.name}"):
                    return True
                detail = self._parse_detail(fresh)
                if detail is not None:
                    if _is_forbidden_detail(detail):
                        self._abort("Forbidden prompt detected on module popup", reason="forbidden_prompt")
                        return True
                    pt = self._safe_module_dismiss_point(detail.get("close_center"), fresh.shape)
                    self._tap(pt, fresh, reason="scan:module_close_retry", input_display=input_display)
                    self._arm_delay(now)
                return True

        if screen.name != "modules":
            self._route_to(fresh, input_display, screen, "modules", now)
            return True

        active_preset = screen.facts.get("active_preset")
        if self._substate == "route":
            self._failures = 0
            self._orig_mod_preset = active_preset
            self._mod_presets = _order_presets(screen.facts.get("presets"), active_preset)
            self._mod_preset_idx = 0
            self._substate = "preset_select"

        if self._substate == "preset_select":
            target_preset = self._mod_presets[self._mod_preset_idx]
            self.progress = f"Preset {self._mod_preset_idx + 1}/{len(self._mod_presets)}"
            if not self._ensure_preset(fresh, input_display, screen, target_preset, detail_prefix="Switching to", reason_prefix="scan:modules", now=now):
                return True
            try:
                eq = self._parse_modules(fresh)
            except Exception as exc:
                self._record_failure(f"Modules equipped parse failed: {exc}")
                return True
            self._mod_slots = dict(eq.get("slots") or {})
            self._mod_slot_idx = 0
            self._substate = "tap_slot"

        if self._substate == "tap_slot":
            if self._mod_slot_idx >= len(loadouts.MODULE_SLOT_ORDER):
                self._mod_preset_idx += 1
                self._substate = "preset_select" if self._mod_preset_idx < len(self._mod_presets) else "restore"
                return False

            slot = loadouts.MODULE_SLOT_ORDER[self._mod_slot_idx]
            preset_label = self._mod_presets[self._mod_preset_idx] or active_preset
            slot_info = dict(self._mod_slots.get(slot) or {})
            self._account_store.record_module_slot(preset_label, slot, {"level": slot_info.get("level"), "rarity": slot_info.get("rarity") or ""})
            pt = self._safe_module_slot_point(slot_info.get("center"), slot, fresh.shape)
            if pt is None:
                self._record_failure(f"Module slot '{slot}' tap point outside safe y=450..870 fence")
                return True
            if self._tap(pt, fresh, reason=f"scan:module_slot_{slot}", input_display=input_display) is None:
                self._record_failure(f"Tap refused for module slot {slot}")
                return True
            self._mod_current_slot, self._mod_current_base = slot, slot_info
            self._substate = "read_detail"
            self.detail = f"{preset_label or 'Modules'} · {slot.title()}"
            self.progress = f"Preset {self._mod_preset_idx + 1}/{len(self._mod_presets)} · Slot {self._mod_slot_idx + 1}/4"
            self._arm_delay(now)
            return True

        if self._substate == "restore":
            if not self._ensure_preset(fresh, input_display, screen, self._orig_mod_preset, detail_prefix="Restoring", reason_prefix="scan:modules_restore", now=now):
                return True
            self._advance_phase()
            return False
        return True

    def _step_module_read_detail(self, fresh: np.ndarray, input_display: int | None, now: float, get_screen: Callable[[], screens.Screen]) -> bool:
        slot = self._mod_current_slot or loadouts.MODULE_SLOT_ORDER[min(self._mod_slot_idx, 3)]
        target_preset = self._mod_presets[self._mod_preset_idx] if self._mod_preset_idx < len(self._mod_presets) else None
        base = self._mod_current_base
        try:
            detail = self._parse_detail(fresh)
        except Exception as exc:
            self._record_failure(f"Module detail parse failed: {exc}")
            return True

        if detail is not None:
            if _is_forbidden_detail(detail):
                self._abort("Forbidden prompt detected on module popup", reason="forbidden_prompt")
                return True
            merged = {
                "slug": detail.get("slug"),
                "name": detail.get("name"),
                "slot": detail.get("slot") or slot,
                "level": detail.get("level") if detail.get("level") is not None else base.get("level"),
                "rarity": detail.get("rarity") or base.get("rarity") or "",
                "substats": list(detail.get("substats") or []),
            }
            self._account_store.record_module_slot(target_preset, slot, merged)
            pt = self._safe_module_dismiss_point(detail.get("close_center"), fresh.shape)
            if self._tap(pt, fresh, reason=f"scan:module_close_{slot}", input_display=input_display) is None:
                self._record_failure(f"Tap refused dismissing module detail for {slot}")
                return True
            self._mod_slot_idx += 1
            self._substate = "verify_closed"
            self._failures = 0
            self._arm_delay(now)
            return True

        try:
            scr = get_screen()
        except Exception as exc:
            self._record_failure(f"Identify failed on module detail check: {exc}")
            return True
        if scr.name == "modules":
            self._mod_slot_idx += 1
            self._substate = "tap_slot"
            self._failures = 0
            return False
        self._record_failure(f"Unexpected screen '{scr.name}' while reading module detail for {slot}")
        return True

    def _step_returning(self, fresh: np.ndarray, input_display: int | None, now: float, get_screen: Callable[[], screens.Screen]) -> bool:
        try:
            screen = get_screen()
        except Exception as exc:
            self._record_failure(f"Return-home identify failed: {exc}")
            return True
        if screen.name == "home":
            counts = (self._account_store.snapshot(include_catalog=False)).get("counts") or {}
            self._reset_cursor()
            self.running = self.queued = False
            self.phase = "done"
            self.detail = f"Cards {counts.get('cards_owned', 0)}/{counts.get('cards_total', 0)} · Modules {counts.get('modules_owned', 0)}/{counts.get('modules_total', 0)}"
            self.progress, self.last_scan_at, self.error = "", time.time(), None
            self._log(f"Inventory scan completed ({self.detail})", event="inventory_scan_completed", scope=self.scope, counts=counts)
            return True
        self._route_to(fresh, input_display, screen, "home", now)
        return True
