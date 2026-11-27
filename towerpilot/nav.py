"""Menu navigation state machine for verified off-battle transitions.

Owns out-of-battle screen tracking, single-tap-per-tick execution, unified
fresh-ADB + foreground + allowlisted-target verification, post-condition checks
with 3-strike abort-and-hold, and modular profile execution.
"""
from __future__ import annotations

import random
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

import numpy as np

from towerpilot import detectors, profiles, run_rules, screens
from towerpilot.profiles import ProfileStore

_ORIG_DETECT_END_STATS_HOME = detectors.detect_end_stats_home
_ORIG_DETECT_END_STATS_RETRY = detectors.detect_end_stats_retry
_ORIG_DETECT_HOME_BATTLE = detectors.detect_home_battle
_ORIG_SCREENS_IDENTIFY = screens.identify

_PRESET_NUM_RE = re.compile(r"preset\s*(\d+)", re.IGNORECASE)
_MAX_STEP_FAILURES = 3
_MAX_TIER_STEPS = 25
_CEILING_STALL_THRESHOLD = 2
_HARD_NAV_HOLDS = frozenset({"nav_verify_failed", "tier_step_failed", "preset_verify_failed", "tier_step_limit"})


@dataclass
class VerifiedTapContext:
    """Callbacks injected by GemCollector so MenuNavigator stays decoupled from ADB/Tapper."""

    grab_verified_frame: Callable[[], tuple[np.ndarray, int | None]]
    check_foreground: Callable[[int | None], tuple[bool, str]]
    tap: Callable[..., dict[str, Any] | None]
    log: Callable[..., Any]
    notify: Callable[[str, str], None]
    stop_event: threading.Event
    rng: random.Random
    now_local_fn: Callable[[], datetime]
    delay_sec: tuple[float, float] = (2.0, 4.0)
    scan_interval_sec: float = 3.0
    cooldown_sec: float = 15.0
    menu_cooldown_sec: float = 1.5
    failure_backoff_sec: float = 5.0


def _flow_any_enabled(flow_cfg: dict[str, Any]) -> bool:
    return bool(
        flow_cfg.get("auto_home")
        or flow_cfg.get("auto_battle")
        or flow_cfg.get("auto_retry")
        or flow_cfg.get("auto_resume")
    )


def _preset_target_name(screen_name: str, preset_label: str | None) -> str | None:
    m = _PRESET_NUM_RE.search(preset_label or "")
    if not m:
        return None
    num = int(m.group(1))
    if (screen_name == "cards" and 1 <= num <= 5) or (screen_name == "modules" and num in (1, 2)):
        return f"preset_{num}"
    return None


def _legacy_detectors_patched() -> bool:
    return screens.identify is _ORIG_SCREENS_IDENTIFY and (
        detectors.detect_end_stats_home is not _ORIG_DETECT_END_STATS_HOME
        or detectors.detect_end_stats_retry is not _ORIG_DETECT_END_STATS_RETRY
        or detectors.detect_home_battle is not _ORIG_DETECT_HOME_BATTLE
    )


def _identify_via_legacy_detectors(
    frame: np.ndarray, *, allow_resume: bool = False, legacy_kind: str | None = None
) -> screens.Screen:
    """Wrap monkeypatched legacy detectors.* calls into validated screens.Screen objects."""
    ms = detectors.side_menu_state(frame)
    if ms in ("closed", "open"):
        return screens.Screen("battle", {"menu_state": ms}, {})

    if legacy_kind in (None, "end_stats_home", "end_stats_retry"):
        if legacy_kind == "end_stats_retry":
            hit = detectors.detect_end_stats_retry(frame)
            if hit is not None:
                raw = {"retry": screens.Target("retry", hit.rect, "RETRY", ("battle",))}
                return screens.Screen(
                    "game_stats",
                    {"has_retry": True},
                    {k: v for k, v in raw.items() if screens.validate_target("game_stats", v, frame.shape)},
                )
        else:
            hit = detectors.detect_end_stats_home(frame)
            if hit is not None:
                raw = {"home": screens.Target("home", hit.rect, "HOME", ("home",))}
                if hit.retry_rect is not None:
                    raw["retry"] = screens.Target("retry", hit.retry_rect, "RETRY", ("battle",))
                return screens.Screen(
                    "game_stats",
                    {"has_retry": hit.retry_rect is not None},
                    {k: v for k, v in raw.items() if screens.validate_target("game_stats", v, frame.shape)},
                )
        if legacy_kind in ("end_stats_home", "end_stats_retry"):
            return screens.Screen("unknown", {}, {})

    if legacy_kind in (None, "home_battle", "home_resume"):
        home_hit = (
            detectors.detect_home_battle(frame, allow_resume=True)
            if (allow_resume or legacy_kind == "home_resume")
            else detectors.detect_home_battle(frame)
        )
        if home_hit is not None:
            key = home_hit.label.lower()
            raw = {key: screens.Target(key, home_hit.rect, home_hit.label, ("battle",))}
            facts = {
                "tier": home_hit.tier, "highest_wave": None,
                "has_resume": home_hit.label == "RESUME",
                "tournament_open": False, "tournament_timer": None,
            }
            return screens.Screen(
                "home", facts, {k: v for k, v in raw.items() if screens.validate_target("home", v, frame.shape)}
            )

    return screens.Screen("unknown", {}, {})


class MenuNavigator:
    """State machine owning out-of-battle screen tracking and verified menu taps."""

    def __init__(
        self,
        ctx: VerifiedTapContext,
        *,
        identify_fn: Callable[[np.ndarray], screens.Screen] | None = None,
    ) -> None:
        self._ctx = ctx
        self._identify_fn = identify_fn

        self.current_screen: str = "unknown"
        self.nav_state: str = "off"
        self.hold_reason: str | None = None
        self._last_hold_reason: str | None = None

        self.verified_cards_preset: str | None = None
        self.verified_modules_preset: str | None = None
        self.ceiling_tier_reached: bool = False
        self.tier_stall_count: int = 0
        self.step_failures: int = 0

        self.last_scan: float = 0.0
        self.cooldown_until: float = 0.0
        self.pending_action: tuple[str, Any, float] | None = None
        self.runs_restarted: int = 0
        self.current_tier: int | None = None

        self._expected_next: tuple[str, ...] | None = None
        self._expected_from: str | None = None
        self._expected_target: str | None = None
        self._expected_tier_step: tuple[str, int | None, bool] | None = None
        self._expected_preset: tuple[str, str] | None = None
        self._tier_steps_taken: int = 0
        self._tournament_notified: bool = False
        self._last_tournament_open: bool = False
        self._active_profile_id: str | None = None
        self._last_hold_profile: dict[str, Any] | None = None

    def reset_verification(self, *, clear_presets: bool = True, clear_tier: bool = True, clear_hold: bool = False) -> None:
        """Clear in-flight expectations and optionally preset/tier/hold verification state."""
        if clear_presets:
            self.verified_cards_preset = None
            self.verified_modules_preset = None
        if clear_tier:
            self.ceiling_tier_reached = False
            self.tier_stall_count = 0
            self._tier_steps_taken = 0
        if clear_hold:
            self.hold_reason = None
            self._last_hold_reason = None
            self._last_hold_profile = None
        self.step_failures = 0
        self.pending_action = None
        self._expected_next = self._expected_from = self._expected_target = None
        self._expected_tier_step = None
        self._expected_preset = None
        self._tournament_notified = False

    def on_enter_battle(self, *, flow_enabled: bool) -> None:
        """Reset transient off-battle & tier-ceiling state while preserving verified loadout presets."""
        self.current_screen = "battle"
        self.reset_verification(clear_presets=False, clear_tier=True, clear_hold=True)
        self.nav_state = "in battle" if flow_enabled else "off"

    def _format_hold_label(
        self,
        reason: str | None,
        rules: dict[str, Any],
        *,
        profile: dict[str, Any] | None = None,
        detected_tier: int | None = None,
    ) -> str:
        prof = profile if profile is not None else self._last_hold_profile
        if prof is not None:
            if reason == "max_runs":
                prof_max = int(prof.get("max_runs", 0) or 0)
                if prof_max > 0:
                    done = int((prof.get("runtime") or {}).get("runs_completed", 0) or 0)
                    return f"holding (max runs {done}/{prof_max})"
            elif reason == "no_start_window":
                qw = prof.get("quiet_window") or {}
                if qw.get("enabled"):
                    return f"holding (quiet {qw.get('from', '')}-{qw.get('until', '')})"
            elif reason == "outside_window":
                win = prof.get("window") or {}
                if isinstance(win, dict) and win.get("enabled"):
                    return f"holding (window {win.get('from', '')}-{win.get('until', '')})"
            elif reason == "tier_mismatch":
                tier_cfg = prof.get("tier") or {}
                if tier_cfg.get("mode") == "fixed" and int(tier_cfg.get("value", 0) or 0) > 0:
                    got = f"T{detected_tier}" if detected_tier is not None else "T?"
                    return f"holding (tier {got} != T{int(tier_cfg['value'])})"
                if tier_cfg.get("mode") == "highest_unlocked":
                    return "holding (tier ceiling unverified)"
        return run_rules.hold_label(reason, rules, self.runs_restarted, detected_tier=detected_tier)

    def _set_hold(
        self,
        reason: str,
        rules: dict[str, Any],
        *,
        profile: dict[str, Any] | None = None,
        detected_tier: int | None = None,
        label_override: str | None = None,
        notify_msg: str | None = None,
    ) -> None:
        self.hold_reason = reason
        if profile is not None:
            self._last_hold_profile = profile
        self.nav_state = label_override or self._format_hold_label(
            reason, rules, profile=profile, detected_tier=detected_tier
        )
        if self._last_hold_reason != reason:
            self._last_hold_reason = reason
            self._ctx.log(f"Auto-restart holding: {self.nav_state}", event="run_hold", reason=reason, tier=detected_tier)
            if notify_msg:
                self._ctx.notify(notify_msg, "Tower Pilot")

    def _identify_screen(
        self, frame: np.ndarray, *, allow_resume: bool = False, legacy_kind: str | None = None
    ) -> screens.Screen:
        if self._identify_fn is not None:
            return self._identify_fn(frame)
        if _legacy_detectors_patched():
            return _identify_via_legacy_detectors(frame, allow_resume=allow_resume, legacy_kind=legacy_kind)
        return screens.identify(frame)

    def _verify_post_condition(self, screen: screens.Screen, rules: dict[str, Any]) -> bool:
        """Verify previous tap reached expected screen/tier/preset; abort & hold after 3 failures."""
        if self._expected_next is None:
            return True
        exp_next, exp_from, exp_target = self._expected_next, self._expected_from, self._expected_target
        exp_tier, exp_preset = self._expected_tier_step, self._expected_preset
        self._expected_next = self._expected_from = self._expected_target = None
        self._expected_tier_step = None
        self._expected_preset = None

        if screen.name not in exp_next:
            self.step_failures += 1
            self._ctx.log(
                f"Nav verify failed ({exp_from} --[{exp_target}]--> expected {list(exp_next)}, got {screen.name}, {self.step_failures}/{_MAX_STEP_FAILURES})",
                event="nav_verify_failed", src=exp_from, target=exp_target,
                expected=list(exp_next), actual=screen.name, failures=self.step_failures,
            )
            if self.step_failures >= _MAX_STEP_FAILURES:
                self._set_hold(
                    "nav_verify_failed", rules, detected_tier=self.current_tier,
                    label_override=f"holding (nav failed 3x on {screen.name})",
                    notify_msg=f"Navigation paused: unexpected screen '{screen.name}' after 3 attempts.",
                )
                return False
            return True

        if exp_tier is not None:
            direction, prev_tier, is_ceiling = exp_tier
            new_tier = screen.facts.get("tier")
            if is_ceiling and direction == "next":
                if new_tier is not None and prev_tier is not None and new_tier > prev_tier:
                    self.tier_stall_count = self.step_failures = 0
                else:
                    self.tier_stall_count += 1
                    if self.tier_stall_count >= _CEILING_STALL_THRESHOLD:
                        self.ceiling_tier_reached = True
                        self.step_failures = 0
                        self._ctx.log(
                            f"Highest unlocked tier ceiling reached at T{new_tier}",
                            event="nav_tier_ceiling", src="home", dst="home", target="tier_ceiling", tier=new_tier,
                        )
            else:
                moved = new_tier is not None and prev_tier is not None and (
                    (direction == "next" and new_tier > prev_tier) or (direction == "prev" and new_tier < prev_tier)
                )
                if moved:
                    self.step_failures = 0
                else:
                    self.step_failures += 1
                    if self.step_failures >= _MAX_STEP_FAILURES:
                        self._set_hold(
                            "tier_step_failed", rules, detected_tier=new_tier,
                            label_override="holding (tier step failed 3x)",
                            notify_msg="Navigation paused: tier failed to change after 3 attempts.",
                        )
                        return False
            return True

        if exp_preset is not None:
            preset_kind, wanted = exp_preset
            if screen.facts.get("active_preset") == wanted:
                if preset_kind == "cards":
                    self.verified_cards_preset = wanted
                else:
                    self.verified_modules_preset = wanted
                self.step_failures = 0
            else:
                self.step_failures += 1
                if self.step_failures >= _MAX_STEP_FAILURES:
                    self._set_hold(
                        "preset_verify_failed", rules,
                        label_override=f"holding ({preset_kind} preset verify failed 3x)",
                        notify_msg=f"Navigation paused: {preset_kind} preset did not switch to {wanted}.",
                    )
                    return False
            return True

        self.step_failures = 0
        return True

    def _fail_tap(
        self, status: str, event: str, msg: str, *, screen_obj: screens.Screen | None = None, **meta: Any
    ) -> tuple[bool, dict[str, Any] | None, screens.Screen | None]:
        self.pending_action = None
        self.nav_state = status
        self.cooldown_until = max(self.cooldown_until, time.monotonic() + self._ctx.failure_backoff_sec)
        self._ctx.log(msg, event=event, **meta)
        return False, None, screen_obj

    def _execute_verified_tap(
        self,
        *,
        expected_screen: str,
        target_name: str,
        reason: str,
        profile_id: str | None = None,
        dst_screen: str | None = None,
        allow_resume: bool = False,
        legacy_kind: str | None = None,
        cooldown_sec: float | None = None,
        before_tap_fn: Callable[[np.ndarray, screens.Screen, screens.Target], bool] | None = None,
    ) -> tuple[bool, dict[str, Any] | None, screens.Screen | None]:
        """Unified menu tap pipeline: fresh ADB -> foreground -> identify -> validate -> 16px inset -> tap."""
        if self._ctx.stop_event.is_set():
            self.pending_action = None
            return False, None, None
        try:
            fresh, input_display = self._ctx.grab_verified_frame()
        except Exception as exc:
            return self._fail_tap("capture error", "auto_restart_error", f"Auto-restart capture failed: {exc}", action=reason, error=str(exc))

        fg_ok, fg_why = self._ctx.check_foreground(input_display)
        if not fg_ok:
            return self._fail_tap(f"skipped ({fg_why})", "auto_restart_skipped", f"Auto-restart skipped ({reason}): {fg_why}", action=reason, reason=fg_why)

        try:
            screen = self._identify_screen(fresh, allow_resume=allow_resume, legacy_kind=legacy_kind)
        except Exception as exc:
            return self._fail_tap("ocr error", "auto_restart_error", f"Auto-restart OCR failed: {exc}", action=reason, error=str(exc))

        self.current_screen = screen.name
        if screen.name in ("battle", "unknown") or screen.name != expected_screen:
            return self._fail_tap(
                "target gone", "auto_restart_gone",
                f"Auto-restart target disappeared ({reason}: expected {expected_screen}, got {screen.name})",
                screen_obj=screen, action=reason, expected_screen=expected_screen, actual_screen=screen.name,
            )

        target = screen.targets.get(target_name)
        if target is None or not screens.validate_target(screen.name, target, fresh.shape):
            return self._fail_tap(
                "target gone" if target is None else "tap refused",
                "tap_refused" if target is not None else "auto_restart_gone",
                f"Nav target rejected ({screen.name}.{target_name})",
                screen_obj=screen, action=reason, screen=screen.name, target=target_name,
            )

        if before_tap_fn is not None and not before_tap_fn(fresh, screen, target):
            self.pending_action = None
            return False, None, screen
        if self._ctx.stop_event.is_set():
            self.pending_action = None
            return False, None, screen

        pt = detectors.sample_interior_point(target.rect, inset_px=target.inset_px, rng=self._ctx.rng)
        res = self._ctx.tap(pt, fresh, reason=reason, input_display=input_display)
        if res is None:
            self.pending_action = None
            self.cooldown_until = max(self.cooldown_until, time.monotonic() + self._ctx.failure_backoff_sec)
            self.nav_state = "tap refused"
            return False, None, screen

        self.pending_action = None
        self.cooldown_until = time.monotonic() + (self._ctx.cooldown_sec if cooldown_sec is None else cooldown_sec)
        self._expected_next, self._expected_from, self._expected_target = target.expects, screen.name, target.name
        dst = dst_screen or (target.expects[0] if target.expects else screen.name)
        self._ctx.log(
            f"Nav {screen.name} --[{target.name}]--> {dst} at {res['x']},{res['y']}",
            event="nav_step", src=screen.name, dst=dst, target=target.name,
            profile_id=profile_id, x=res["x"], y=res["y"],
        )
        return True, res, screen

    def _schedule_or_execute(
        self, *, action_key: str, target: screens.Target, now: float, status_prefix: str,
        detect_event: str, detect_msg: str, execute_fn: Callable[[], bool], **detect_meta: Any,
    ) -> bool:
        delay = self._ctx.rng.uniform(float(self._ctx.delay_sec[0]), float(self._ctx.delay_sec[1]))
        self.pending_action = (action_key, target, now + delay)
        self.nav_state = f"{status_prefix} in {delay:.1f}s"
        self._ctx.log(
            f"{detect_msg} in {delay:.1f}s", event=detect_event,
            rect=list(target.rect), delay_sec=round(delay, 2), **detect_meta,
        )
        return execute_fn() if delay <= 0.05 else False

    def _sync_active_profile(self, profile_store: ProfileStore, next_profile: dict[str, Any] | None) -> None:
        if next_profile is None:
            return
        next_id = next_profile["id"]
        if self._active_profile_id is None:
            self._active_profile_id = next_id
            return
        if next_id != self._active_profile_id:
            old_id = self._active_profile_id
            self._active_profile_id = next_id
            profile_store.activate(next_id)
            self.reset_verification(clear_presets=True, clear_tier=True)
            self._ctx.log(
                f"Active profile switched: {old_id} -> {next_profile['name']}",
                event="profile_switched", profile_id=next_id, profile_name=next_profile["name"], previous_profile_id=old_id,
            )

    def _legacy_guard(
        self, rules: dict[str, Any], *, profile: dict[str, Any] | None,
        detected_tier: int | None, check_tier: bool, has_tier_arrows: bool,
    ) -> str | None:
        prof_tier_mode = (profile or {}).get("tier", {}).get("mode", "current")
        action, reason = run_rules.decide_home_action(
            self._ctx.now_local_fn(), runs_restarted=self.runs_restarted, rules=rules,
            detected_tier=detected_tier, check_tier=check_tier and (prof_tier_mode == "current" or not has_tier_arrows),
        )
        return reason if action == "hold" else None

    def _record_profile_run(self, profile_store: ProfileStore, profile_id: str, record: dict[str, Any]) -> None:
        try:
            res = profile_store.record_run_ended(profile_id, record)
        except KeyError:
            return
        if res.get("new_pb"):
            self._ctx.notify(f"New PB on {res['profile']['name']}! Wave {record.get('wave')}", "Tower Pilot")
        if res.get("transition_to"):
            self._ctx.log(
                f"Profile {profile_id} completed -> queued {res['transition_to']}",
                event="profile_switched", queued_profile_id=res["transition_to"], completed_profile_id=profile_id,
            )

    def _dispatch_boundary(
        self, action_key: str, *, rules: dict[str, Any], profile_store: ProfileStore,
        on_run_ended_fn: Callable[[np.ndarray], dict[str, Any] | None], on_battle_started_fn: Callable[..., None],
    ) -> bool:
        eff_pid = profile_store.snapshot().get("active_id")

        def _scrape_once(fresh: np.ndarray) -> None:
            rec = on_run_ended_fn(fresh)
            if rec is not None and eff_pid:
                self._record_profile_run(profile_store, eff_pid, rec)

        if action_key == "end_stats_home":
            ok, res, _ = self._execute_verified_tap(
                expected_screen="game_stats", target_name="home", reason="run_flow:end_stats_home",
                profile_id=eff_pid, dst_screen="home", legacy_kind="end_stats_home",
                before_tap_fn=lambda f, _s, _t: (_scrape_once(f), True)[1],
            )
            if not ok or res is None:
                return False
            self.nav_state = (
                self._format_hold_label(self.hold_reason, rules, detected_tier=self.current_tier)
                if self.hold_reason else "tapped HOME"
            )
            self._ctx.log(f"End Stats -> HOME tapped at {res['x']},{res['y']}", event="end_stats_home_tapped", x=res["x"], y=res["y"])
            return True

        if action_key == "end_stats_retry":
            def _before_retry(fresh: np.ndarray, _s: screens.Screen, _t: screens.Target) -> bool:
                _scrape_once(fresh)
                why = self._legacy_guard(rules, profile=profile_store.get(eff_pid), detected_tier=self.current_tier, check_tier=True, has_tier_arrows=False)
                if why is not None:
                    self._set_hold(why, rules, detected_tier=self.current_tier)
                    return False
                return True

            ok, res, _ = self._execute_verified_tap(
                expected_screen="game_stats", target_name="retry", reason="run_flow:end_stats_retry",
                profile_id=eff_pid, dst_screen="battle", legacy_kind="end_stats_retry", before_tap_fn=_before_retry,
            )
            if not ok or res is None:
                return False
            self.runs_restarted += 1
            self.hold_reason = self._last_hold_reason = None
            self.nav_state = "tapped RETRY"
            self._clear_queued_after_battle(profile_store, eff_pid)
            on_battle_started_fn(exact=True, tier=self.current_tier, kind="end_stats_retry")
            self._ctx.log(
                f"End Stats -> RETRY tapped at {res['x']},{res['y']}",
                event="end_stats_retry_tapped", x=res["x"], y=res["y"], tier=self.current_tier, runs_restarted=self.runs_restarted,
            )
            return True

        if action_key == "home_resume":
            ok, res, scr = self._execute_verified_tap(
                expected_screen="home", target_name="resume", reason="run_flow:home_resume",
                profile_id=eff_pid, dst_screen="battle", allow_resume=True, legacy_kind="home_resume",
            )
            if not ok or res is None:
                return False
            if scr is not None and scr.facts.get("tier") is not None:
                self.current_tier = scr.facts["tier"]
            self.hold_reason = self._last_hold_reason = None
            self.nav_state = "tapped RESUME"
            on_battle_started_fn(exact=False, tier=self.current_tier, kind="home_resume")
            self._ctx.log(
                f"Home -> RESUME tapped at {res['x']},{res['y']}",
                event="home_resume_tapped", x=res["x"], y=res["y"], tier=self.current_tier,
            )
            return True

        def _before_battle(_f: np.ndarray, scr: screens.Screen, _t: screens.Target) -> bool:
            tval = scr.facts.get("tier")
            if tval is not None:
                self.current_tier = tval
            prof = profile_store.get(eff_pid)
            if prof is not None and not profiles.tier_matches(prof, tval, ceiling_reached=self.ceiling_tier_reached):
                self._set_hold("tier_mismatch", rules, profile=prof, detected_tier=tval)
                return False
            why = self._legacy_guard(
                rules, profile=prof, detected_tier=tval,
                check_tier=True, has_tier_arrows=("tier_next" in scr.targets or "tier_prev" in scr.targets),
            )
            if why is not None:
                self._set_hold(why, rules, profile=prof, detected_tier=tval)
                return False
            return True

        ok, res, scr = self._execute_verified_tap(
            expected_screen="home", target_name="battle", reason="run_flow:home_battle",
            profile_id=eff_pid, dst_screen="battle", legacy_kind="home_battle", before_tap_fn=_before_battle,
        )
        if not ok or res is None:
            return False
        if scr is not None and scr.facts.get("tier") is not None:
            self.current_tier = scr.facts["tier"]
        self.runs_restarted += 1
        self.hold_reason = self._last_hold_reason = None
        self.nav_state = "tapped BATTLE"
        self._clear_queued_after_battle(profile_store, eff_pid)
        on_battle_started_fn(exact=True, tier=self.current_tier, kind="home_battle")
        self._ctx.log(
            f"Home -> BATTLE tapped at {res['x']},{res['y']}",
            event="home_battle_tapped", x=res["x"], y=res["y"], tier=self.current_tier, runs_restarted=self.runs_restarted,
        )
        return True

    @staticmethod
    def _clear_queued_after_battle(profile_store: ProfileStore, profile_id: str | None) -> None:
        if not profile_id:
            return
        clear_q = getattr(profile_store, "clear_queued", None)
        if callable(clear_q):
            clear_q(profile_id)
        elif profile_store.snapshot().get("queued_id") == profile_id:
            profile_store.queue_next(None)

    def step(
        self,
        frame: np.ndarray,
        now: float,
        *,
        cfg: dict[str, Any],
        profile_store: ProfileStore,
        on_run_ended_fn: Callable[[np.ndarray], dict[str, Any] | None],
        on_battle_started_fn: Callable[..., None],
    ) -> bool:
        """One-tap-per-tick off-battle navigation & passive run-end scraping."""
        flow_cfg = cfg.get("run_flow", {})
        auto_home, auto_battle = bool(flow_cfg.get("auto_home")), bool(flow_cfg.get("auto_battle"))
        auto_retry, auto_resume = bool(flow_cfg.get("auto_retry")), bool(flow_cfg.get("auto_resume"))
        rules = cfg.get("run_rules", {}) if isinstance(cfg.get("run_rules"), dict) else {}

        if not _flow_any_enabled(flow_cfg):
            self.pending_action = self.hold_reason = self._last_hold_reason = None
            self.nav_state = "off"
            if now - self.last_scan >= self._ctx.scan_interval_sec:
                self.last_scan = now
                try:
                    if detectors.detect_end_stats_home(frame) is not None:
                        self.current_screen = "game_stats"
                        rec = on_run_ended_fn(frame)
                        aid = profile_store.snapshot().get("active_id")
                        if rec is not None and aid:
                            self._record_profile_run(profile_store, aid, rec)
                except Exception:
                    pass
            return False

        if now < self.cooldown_until:
            self.nav_state = f"cooldown ({int(self.cooldown_until - now)}s)"
            return False

        if self.pending_action is not None:
            key, tgt, due = self.pending_action
            enabled_map = {"end_stats_home": auto_home, "end_stats_retry": auto_retry, "home_battle": auto_battle, "home_resume": auto_resume}
            if key in enabled_map and not enabled_map[key]:
                self.pending_action = None
                self.nav_state = "watching"
                return False
            if key in ("home_battle", "end_stats_retry"):
                why = self._legacy_guard(rules, profile=profile_store.get(profile_store.snapshot().get("active_id")), detected_tier=self.current_tier, check_tier=False, has_tier_arrows=False)
                if why is not None:
                    self.pending_action = None
                    self._set_hold(why, rules)
                    return False
            if now < due:
                self.nav_state = f"tapping {tgt.label} in {due - now:.1f}s"
                return False
            return self._dispatch_boundary(key, rules=rules, profile_store=profile_store, on_run_ended_fn=on_run_ended_fn, on_battle_started_fn=on_battle_started_fn)

        if now - self.last_scan < self._ctx.scan_interval_sec:
            if self.nav_state in ("off", "stopped", "in battle"):
                self.nav_state = "watching"
            return False
        self.last_scan = now

        try:
            screen = self._identify_screen(frame, allow_resume=auto_resume)
        except Exception as exc:
            self.nav_state = "ocr error"
            self._ctx.log(f"Screen identify OCR failed: {exc}", event="auto_restart_error", error=str(exc))
            return False

        self.current_screen = screen.name
        if screen.name == "battle":
            self.on_enter_battle(flow_enabled=True)
            return False
        if not self._verify_post_condition(screen, rules):
            return False
        if self.hold_reason in _HARD_NAV_HOLDS and not (auto_resume and screen.name == "home" and "resume" in screen.targets):
            return False

        if screen.name == "home":
            if screen.facts.get("tier") is not None:
                self.current_tier = screen.facts["tier"]
            self._last_tournament_open = bool(screen.facts.get("tournament_open", False))
        elif screen.name == "cards" and screen.facts.get("active_preset"):
            self.verified_cards_preset = screen.facts["active_preset"]
        elif screen.name == "modules" and screen.facts.get("active_preset"):
            self.verified_modules_preset = screen.facts["active_preset"]

        # Priority 1: Crash RESUME overrides holds; when auto_resume is OFF, never tap Home controls over a crashed run!
        if auto_resume and screen.name == "home" and "resume" in screen.targets:
            self.hold_reason = self._last_hold_reason = None
            return self._schedule_or_execute(
                action_key="home_resume", target=screen.targets["resume"], now=now,
                status_prefix="tapping RESUME", detect_event="home_resume_detected",
                detect_msg="Crashed run detected -> RESUME", tier=screen.facts.get("tier"),
                execute_fn=lambda: self._dispatch_boundary("home_resume", rules=rules, profile_store=profile_store, on_run_ended_fn=on_run_ended_fn, on_battle_started_fn=on_battle_started_fn),
            )
        if screen.name == "home" and (screen.facts.get("has_resume") or "resume" in screen.targets):
            self.nav_state = "watching (resume pending)"
            return False

        if screen.name == "unknown":
            self.nav_state = (
                self._format_hold_label(self.hold_reason, rules, detected_tier=self.current_tier)
                if self.hold_reason else "watching"
            )
            return False

        store_snap = profile_store.snapshot()
        active_id = store_snap.get("active_id")
        current_prof = profile_store.get(active_id)
        if self._active_profile_id is None and active_id is not None:
            self._active_profile_id = active_id

        # Priority 2: GAME STATS boundary (scrape once, decide RETRY vs HOME).
        if screen.name == "game_stats":
            rec = on_run_ended_fn(frame)
            if rec is not None and active_id:
                self._record_profile_run(profile_store, active_id, rec)
                store_snap = profile_store.snapshot()
                current_prof = profile_store.get(store_snap.get("active_id"))
            ended_tier = (
                rec["tier"] if (rec and rec.get("tier") is not None)
                else (screen.facts.get("tier") if screen.facts.get("tier") is not None else self.current_tier)
            )
            if ended_tier is not None:
                self.current_tier = ended_tier

            next_prof, pick_hold = profiles.pick_active(
                self._ctx.now_local_fn(), store_snap,
                tournament_open=self._last_tournament_open, global_finish_and_stop=bool(rules.get("finish_and_stop", False)),
            )
            eff_hold = pick_hold or self._legacy_guard(
                rules, profile=next_prof or current_prof, detected_tier=ended_tier, check_tier=True, has_tier_arrows=False
            )
            if auto_retry and "retry" in screen.targets:
                p_ok = next_prof is not None and profiles.presets_match(next_prof, self.verified_cards_preset, self.verified_modules_preset)
                t_ok = next_prof is not None and profiles.tier_matches(next_prof, ended_tier, ceiling_reached=self.ceiling_tier_reached)
                if profiles.should_direct_retry(current_prof, next_prof, hold_reason=eff_hold, presets_verified=p_ok, tier_verified=t_ok):
                    self.hold_reason = self._last_hold_reason = None
                    return self._schedule_or_execute(
                        action_key="end_stats_retry", target=screen.targets["retry"], now=now,
                        status_prefix="tapping RETRY", detect_event="end_stats_retry_detected",
                        detect_msg="GAME STATS detected -> RETRY",
                        execute_fn=lambda: self._dispatch_boundary("end_stats_retry", rules=rules, profile_store=profile_store, on_run_ended_fn=on_run_ended_fn, on_battle_started_fn=on_battle_started_fn),
                    )
                if eff_hold is not None:
                    self._set_hold(eff_hold, rules, profile=next_prof or current_prof, detected_tier=ended_tier)
                    if not auto_home:
                        return False
            if auto_home and "home" in screen.targets:
                return self._schedule_or_execute(
                    action_key="end_stats_home", target=screen.targets["home"], now=now,
                    status_prefix="tapping HOME", detect_event="end_stats_detected",
                    detect_msg="GAME STATS detected -> HOME",
                    execute_fn=lambda: self._dispatch_boundary("end_stats_home", rules=rules, profile_store=profile_store, on_run_ended_fn=on_run_ended_fn, on_battle_started_fn=on_battle_started_fn),
                )
            return False

        # Priority 3: Menu navigation & battle start on home / cards / modules.
        if not auto_battle:
            self.nav_state = (
                self._format_hold_label(self.hold_reason, rules, detected_tier=self.current_tier)
                if self.hold_reason else "watching"
            )
            return False

        next_prof, pick_hold = profiles.pick_active(
            self._ctx.now_local_fn(), store_snap,
            tournament_open=self._last_tournament_open, global_finish_and_stop=bool(rules.get("finish_and_stop", False)),
        )
        has_arrows = screen.name == "home" and ("tier_next" in screen.targets or "tier_prev" in screen.targets)
        eff_hold = pick_hold or self._legacy_guard(
            rules, profile=next_prof or current_prof, detected_tier=self.current_tier,
            check_tier=(screen.name == "home"), has_tier_arrows=has_arrows,
        )
        if eff_hold is not None:
            self._set_hold(eff_hold, rules, profile=next_prof or current_prof, detected_tier=self.current_tier)
            return False

        self._sync_active_profile(profile_store, next_prof)
        assert next_prof is not None
        pid = next_prof["id"]
        if screen.name == "home":
            hw = screen.facts.get("highest_wave")
            if isinstance(hw, int) and not isinstance(hw, bool) and next_prof.get("runtime", {}).get("baseline_highest_wave") != hw:
                profile_store.set_baseline_wave(pid, hw)

        goal = profiles.next_goal(
            next_prof, verified_cards_preset=self.verified_cards_preset,
            verified_modules_preset=self.verified_modules_preset,
            current_tier=self.current_tier, ceiling_reached=self.ceiling_tier_reached,
        )
        action = goal["action"]
        if action != "enter_tournament" and self.hold_reason == "tournament_capture_needed":
            self.hold_reason = self._last_hold_reason = None
            self._tournament_notified = False
        if action == "hold":
            self._set_hold(str(goal.get("reason") or "hold"), rules, detected_tier=self.current_tier)
            return False

        target_screen = str(goal.get("target_screen") or "home")
        if screen.name != target_screen:
            path = screens.plan_path(screen.name, target_screen)
            if not path:
                self._set_hold("nav_no_path", rules, label_override=f"holding (no path {screen.name} -> {target_screen})")
                return False
            edge = path[0]
            if edge.target_name not in screen.targets:
                self.nav_state = f"waiting ({edge.target_name})"
                return False
            self.nav_state = f"navigating {screen.name} -> {edge.dst}"
            ok, _, _ = self._execute_verified_tap(
                expected_screen=screen.name, target_name=edge.target_name, reason=f"nav:{edge.src}_{edge.dst}",
                profile_id=pid, dst_screen=edge.dst, cooldown_sec=self._ctx.menu_cooldown_sec,
            )
            return ok

        if action in ("select_card_preset", "select_module_preset"):
            wanted, kind_lbl = str(goal["preset"]), ("cards" if action == "select_card_preset" else "modules")
            tname = _preset_target_name(kind_lbl, wanted)
            if tname is None or tname not in screen.targets:
                self._set_hold("preset_missing", rules, label_override=f"holding ({kind_lbl} {wanted} not visible)")
                return False
            self.nav_state = f"switching {kind_lbl} -> {wanted}"
            ok, _, _ = self._execute_verified_tap(
                expected_screen=kind_lbl, target_name=tname, reason=f"nav:{kind_lbl}_{tname}",
                profile_id=pid, dst_screen=kind_lbl, cooldown_sec=self._ctx.menu_cooldown_sec,
            )
            if ok:
                self._expected_preset = (kind_lbl, wanted)
            return ok

        if action == "set_tier":
            if self._tier_steps_taken >= _MAX_TIER_STEPS:
                self._set_hold(
                    "tier_step_limit", rules, detected_tier=self.current_tier,
                    label_override="holding (tier step limit reached)",
                    notify_msg="Navigation paused: reached max 25 tier steps.",
                )
                return False
            cur = self.current_tier
            if goal.get("mode") == "fixed":
                if cur is None:
                    self.nav_state = "watching (tier unreadable)"
                    return False
                direction = "next" if cur < int(goal.get("value", 0)) else "prev"
                tname = "tier_next" if direction == "next" else "tier_prev"
                self.nav_state = f"stepping tier T{cur} -> T{cur + (1 if direction == 'next' else -1)}"
                tier_info = (direction, cur, False)
            else:
                tname, tier_info = "tier_next", ("next", cur, True)
                self.nav_state = f"pushing tier T{cur} -> max" if cur is not None else "pushing tier -> max"
            ok, _, _ = self._execute_verified_tap(
                expected_screen="home", target_name=tname, reason=f"nav:{tname}",
                profile_id=pid, dst_screen="home", cooldown_sec=self._ctx.menu_cooldown_sec,
            )
            if ok:
                self._expected_tier_step = tier_info
                self._tier_steps_taken += 1
            return ok

        if action == "enter_tournament":
            if not screens.plan_path("home", "tournament_modal"):
                msg = None if self._tournament_notified else "Tournament is open! Capture a tournament screen to enable auto-entry."
                self._tournament_notified = True
                self._set_hold(
                    "tournament_capture_needed", rules, detected_tier=self.current_tier,
                    label_override="holding (tournament capture needed)", notify_msg=msg,
                )
                return False

        if action == "start_battle" and "battle" in screen.targets:
            self.hold_reason = self._last_hold_reason = None
            return self._schedule_or_execute(
                action_key="home_battle", target=screen.targets["battle"], now=now,
                status_prefix="tapping BATTLE", detect_event="home_battle_detected",
                detect_msg="Home screen detected -> BATTLE", tier=screen.facts.get("tier"),
                execute_fn=lambda: self._dispatch_boundary("home_battle", rules=rules, profile_store=profile_store, on_run_ended_fn=on_run_ended_fn, on_battle_started_fn=on_battle_started_fn),
            )

        self.nav_state = "watching"
        return False
