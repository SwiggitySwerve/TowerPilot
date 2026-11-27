"""Offline unit tests for MenuNavigator, GemCollector profile/telemetry wiring, and /api/profiles + /api/metrics."""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

import numpy as np

from app import create_app
from towerpilot import adb, detectors, run_rules, screens
from towerpilot.collector import GemCollector
from towerpilot.config import DEFAULT_CONFIG
from towerpilot.profiles import ProfileStore
from towerpilot.telemetry import Telemetry

_SHAPE = (2560, 1080, 3)


def _blank_frame() -> np.ndarray:
    return np.zeros(_SHAPE, dtype=np.uint8)


class SpyFrames:
    def __init__(self, frame: np.ndarray | None = None) -> None:
        self.frame = frame if frame is not None else _blank_frame()
        self.last_frame = self.frame
        self.active_backend = "mumu"
        self.last_error = None
        self.last_frame_size = (self.frame.shape[1], self.frame.shape[0])
        self.input_display = None
        self.adb_grabs = 0

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self.frame.copy(), "mumu"

    def grab_adb(self):
        self.adb_grabs += 1
        return self.frame.copy()

    def close(self) -> None:
        pass


def _make_game_stats_screen(tier: int = 9) -> screens.Screen:
    return screens.Screen(
        "game_stats",
        {"has_retry": True, "tier": tier},
        {
            "home": screens.Target("home", screens.REF_STATS_DEFAULT_HOME, "HOME", ("home",)),
            "retry": screens.Target("retry", screens.REF_STATS_DEFAULT_RETRY, "RETRY", ("battle",)),
        },
    )


def _make_home_screen(
    tier: int = 9,
    *,
    highest_wave: int = 9020,
    tournament_open: bool = False,
    has_resume: bool = False,
) -> screens.Screen:
    btn_key = "resume" if has_resume else "battle"
    btn_label = "RESUME" if has_resume else "BATTLE"
    targets: dict[str, screens.Target] = {
        btn_key: screens.Target(btn_key, detectors.REF_HOME_BATTLE_BTN, btn_label, ("battle",)),
        "tier_prev": screens.Target("tier_prev", screens.REF_HOME_TIER_PREV, "<", ("home",)),
        "tier_next": screens.Target("tier_next", screens.REF_HOME_TIER_NEXT, ">", ("home",)),
        "nav_cards": screens.Target("nav_cards", screens.REF_NAV_CARDS, "CARDS", ("cards",)),
        "nav_modules": screens.Target("nav_modules", screens.REF_NAV_MODULES, "MODULES", ("modules",)),
    }
    if tournament_open:
        targets["tournament"] = screens.Target(
            "tournament", screens.REF_HOME_DEFAULT_TROPHY, "TOURNAMENT", ("tournament_modal",)
        )
    return screens.Screen(
        "home",
        {
            "tier": tier,
            "highest_wave": highest_wave,
            "has_resume": has_resume,
            "tournament_open": tournament_open,
            "tournament_timer": "Ends in 12h" if tournament_open else "Next in 1d",
        },
        targets,
    )


def _make_cards_screen(active_preset: str = "Preset 1") -> screens.Screen:
    targets: dict[str, screens.Target] = {
        f"preset_{idx}": screens.Target(f"preset_{idx}", rect, f"Preset {idx}", ("cards",))
        for idx, rect in enumerate(screens.REF_CARDS_DEFAULT_PILLS, start=1)
    }
    targets["nav_home"] = screens.Target("nav_home", screens.REF_NAV_HOME, "HOME", ("home",))
    targets["nav_modules"] = screens.Target("nav_modules", screens.REF_NAV_MODULES, "MODULES", ("modules",))
    return screens.Screen(
        "cards",
        {"active_preset": active_preset, "presets": [f"Preset {i}" for i in range(1, 6)]},
        targets,
    )


def _make_modules_screen(active_preset: str = "Preset 1") -> screens.Screen:
    targets: dict[str, screens.Target] = {
        f"preset_{idx}": screens.Target(f"preset_{idx}", rect, f"Preset {idx}", ("modules",))
        for idx, rect in enumerate(screens.REF_MODULES_DEFAULT_PILLS, start=1)
    }
    targets["nav_home"] = screens.Target("nav_home", screens.REF_NAV_HOME, "HOME", ("home",))
    targets["nav_cards"] = screens.Target("nav_cards", screens.REF_NAV_CARDS, "CARDS", ("cards",))
    return screens.Screen(
        "modules",
        {"active_preset": active_preset, "presets": ["Preset 1", "Preset 2"]},
        targets,
    )


def _point_in_rect(x: int, y: int, rect: tuple[int, int, int, int]) -> bool:
    rx, ry, rw, rh = rect
    return rx <= x <= rx + rw and ry <= y <= ry + rh


class SpyTapper:
    """Records every tap call and drives simulated screen transitions."""

    def __init__(self, on_tap=None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._on_tap = on_tap

    def tap(self, serial, x, y, *, cfg, input_display=None, reason="", frame_size=None, stop_event=None):
        rec = {"serial": serial, "x": int(x), "y": int(y), "reason": reason, "input_display": input_display}
        self.calls.append(rec)
        if self._on_tap is not None:
            self._on_tap(rec)
        return rec


def _tick_now(collector: GemCollector) -> None:
    collector.flow_cooldown_until = 0.0
    collector.flow_last_scan = 0.0
    collector.step_once()


def test_end_to_end_multistep_navigation_cards_modules_tier_battle(tmp_path: Path, monkeypatch):
    """game_stats -> home -> cards (Preset 3) -> modules (Preset 2) -> home (T9 -> T11) -> battle."""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"] = {"auto_home": True, "auto_battle": True, "auto_retry": True, "auto_resume": True}

    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(cfg)
    store.upsert(
        {
            "id": "farm-t11",
            "name": "T11 Farm",
            "kind": "farm",
            "enabled": True,
            "priority": 25,
            "tier": {"mode": "fixed", "value": 11},
            "presets": {"cards": "Preset 3", "modules": "Preset 2"},
            "max_runs": 0,
        }
    )

    log_path = tmp_path / "events.jsonl"
    telemetry = Telemetry(event_log_path=log_path)
    frames = SpyFrames()

    sim = {"screen": "game_stats", "cards_preset": "Preset 1", "modules_preset": "Preset 1", "tier": 9}

    def fake_identify(_frame: np.ndarray) -> screens.Screen:
        if sim["screen"] == "game_stats":
            return _make_game_stats_screen(tier=sim["tier"])
        if sim["screen"] == "home":
            return _make_home_screen(tier=sim["tier"], highest_wave=9020)
        if sim["screen"] == "cards":
            return _make_cards_screen(active_preset=sim["cards_preset"])
        if sim["screen"] == "modules":
            return _make_modules_screen(active_preset=sim["modules_preset"])
        return screens.Screen("battle", {"menu_state": "closed"}, {})

    fg_checks = 0

    def fake_visible_windows(*_a, **_kw):
        nonlocal fg_checks
        fg_checks += 1
        return [f"{adb.GAME_PKG}/Activity"]

    val_calls: list[tuple[str, str]] = []
    orig_validate = screens.validate_target

    def spy_validate(screen_name: str, target: screens.Target, frame_shape=_SHAPE) -> bool:
        val_calls.append((screen_name, target.name))
        return orig_validate(screen_name, target, frame_shape)

    def on_tap(rec: dict[str, Any]) -> None:
        x, y = rec["x"], rec["y"]
        cur = sim["screen"]
        if cur == "game_stats" and _point_in_rect(x, y, screens.REF_STATS_DEFAULT_HOME):
            sim["screen"] = "home"
        elif cur == "home" and _point_in_rect(x, y, screens.REF_NAV_CARDS):
            sim["screen"] = "cards"
        elif cur == "cards" and _point_in_rect(x, y, screens.REF_CARDS_DEFAULT_PILLS[2]):
            sim["cards_preset"] = "Preset 3"
        elif cur == "cards" and _point_in_rect(x, y, screens.REF_NAV_MODULES):
            sim["screen"] = "modules"
        elif cur == "modules" and _point_in_rect(x, y, screens.REF_MODULES_DEFAULT_PILLS[1]):
            sim["modules_preset"] = "Preset 2"
        elif cur == "modules" and _point_in_rect(x, y, screens.REF_NAV_HOME):
            sim["screen"] = "home"
        elif cur == "home" and _point_in_rect(x, y, screens.REF_HOME_TIER_NEXT):
            sim["tier"] += 1
        elif cur == "home" and _point_in_rect(x, y, detectors.REF_HOME_BATTLE_BTN):
            sim["screen"] = "battle"
        else:
            raise AssertionError(f"Unexpected tap at ({x},{y}) on {cur} ({rec['reason']})")

    monkeypatch.setattr(screens, "identify", fake_identify)
    monkeypatch.setattr(screens, "validate_target", spy_validate)
    monkeypatch.setattr(adb, "visible_windows", fake_visible_windows)
    monkeypatch.setattr(
        detectors,
        "read_end_stats",
        lambda _f: run_rules.parse_end_stats("GAME STATS Wave 8996 Tier 9 Highest Wave: 9020 Killed By Scatter", "10T + 5T = 15T"),
    )

    tapper = SpyTapper(on_tap=on_tap)
    collector = GemCollector(
        frames,
        cfg,
        tapper=tapper,
        flow_delay_sec=(0.0, 0.0),
        max_taps_per_sec=100.0,
        profile_store=store,
        telemetry=telemetry,
    )

    # 9 steps:
    # 1: game_stats -> home
    # 2: home -> cards
    # 3: cards -> Preset 3
    # 4: cards -> modules
    # 5: modules -> Preset 2
    # 6: modules -> home
    # 7: home -> tier_next (9 -> 10)
    # 8: home -> tier_next (10 -> 11)
    # 9: home -> battle
    for _ in range(9):
        _tick_now(collector)

    assert sim == {"screen": "battle", "cards_preset": "Preset 3", "modules_preset": "Preset 2", "tier": 11}
    assert len(tapper.calls) == 9
    # Every single tap went through fresh ADB grab + foreground check + validate_target!
    assert frames.adb_grabs == 9
    assert fg_checks == 9
    assert len(val_calls) >= 9
    assert collector.runs_restarted == 1
    assert collector.navigator.verified_cards_preset == "Preset 3"
    assert collector.navigator.verified_modules_preset == "Preset 2"
    assert collector.navigator.step_failures == 0
    assert collector.navigator.hold_reason is None

    # Structured nav_step events recorded in JSONL
    rows = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    nav_steps = [r for r in rows if r["event"] == "nav_step"]
    assert [r["target"] for r in nav_steps] == [
        "home",
        "nav_cards",
        "preset_3",
        "nav_modules",
        "preset_2",
        "nav_home",
        "tier_next",
        "tier_next",
        "battle",
    ]
    assert store.get("farm-t11")["runtime"]["baseline_highest_wave"] == 9020


def test_tier_push_highest_unlocked_ceiling_detection_and_battle(tmp_path: Path, monkeypatch):
    """Steps tier_next until 2 non-advancing taps confirm ceiling, records baseline_highest_wave, taps battle."""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"] = {"auto_home": True, "auto_battle": True, "auto_retry": False, "auto_resume": False}

    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(cfg)
    push = store.get("tier-push")
    push["enabled"] = True
    store.upsert(push)

    frames = SpyFrames()
    sim = {"tier": 14, "max_unlocked": 15, "highest_waves": {14: 320, 15: 75}, "screen": "home"}

    def fake_identify(_frame: np.ndarray) -> screens.Screen:
        if sim["screen"] == "home":
            return _make_home_screen(tier=sim["tier"], highest_wave=sim["highest_waves"][sim["tier"]])
        return screens.Screen("battle", {"menu_state": "closed"}, {})

    def on_tap(rec: dict[str, Any]) -> None:
        if _point_in_rect(rec["x"], rec["y"], screens.REF_HOME_TIER_NEXT):
            sim["tier"] = min(sim["max_unlocked"], sim["tier"] + 1)
        elif _point_in_rect(rec["x"], rec["y"], detectors.REF_HOME_BATTLE_BTN):
            sim["screen"] = "battle"
        else:
            raise AssertionError(f"Unexpected tap: {rec}")

    monkeypatch.setattr(screens, "identify", fake_identify)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])

    tapper = SpyTapper(on_tap=on_tap)
    collector = GemCollector(
        frames,
        cfg,
        tapper=tapper,
        flow_delay_sec=(0.0, 0.0),
        max_taps_per_sec=100.0,
        profile_store=store,
        telemetry=Telemetry(event_log_path=tmp_path / "events.jsonl"),
    )

    # Tick 1: T14 -> taps tier_next (becomes T15)
    _tick_now(collector)
    assert sim["tier"] == 15
    assert collector.navigator.ceiling_tier_reached is False

    # Tick 2: T15 -> taps tier_next (stays T15, stall_count will become 1 on next tick)
    _tick_now(collector)
    assert sim["tier"] == 15
    assert collector.navigator.ceiling_tier_reached is False

    # Tick 3: sees stall_count=1 -> taps tier_next again (stays T15, stall_count will become 2)
    _tick_now(collector)
    assert collector.navigator.tier_stall_count == 1
    assert collector.navigator.ceiling_tier_reached is False

    # Tick 4: sees stall_count=2 -> ceiling_tier_reached=True -> immediately taps battle!
    _tick_now(collector)
    assert collector.navigator.ceiling_tier_reached is True
    assert sim["screen"] == "battle"
    assert collector.runs_restarted == 1
    assert store.get("tier-push")["runtime"]["baseline_highest_wave"] == 75
    assert len(tapper.calls) == 4


def test_tournament_switches_presets_then_holds_without_tapping_modal(tmp_path: Path, monkeypatch):
    """Tournament profile equips tournament Cards & Modules presets, returns to Home, and holds cleanly."""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"] = {"auto_home": True, "auto_battle": True, "auto_retry": False, "auto_resume": False}

    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(cfg)
    tourney = store.get("tournament")
    tourney["enabled"] = True
    tourney["presets"] = {"cards": "Preset 4", "modules": "Preset 2"}
    store.upsert(tourney)

    frames = SpyFrames()
    sim = {"screen": "home", "cards_preset": "Preset 1", "modules_preset": "Preset 1"}

    def fake_identify(_frame: np.ndarray) -> screens.Screen:
        if sim["screen"] == "home":
            return _make_home_screen(tier=9, tournament_open=True)
        if sim["screen"] == "cards":
            return _make_cards_screen(active_preset=sim["cards_preset"])
        if sim["screen"] == "modules":
            return _make_modules_screen(active_preset=sim["modules_preset"])
        return screens.Screen("unknown", {}, {})

    def on_tap(rec: dict[str, Any]) -> None:
        x, y = rec["x"], rec["y"]
        cur = sim["screen"]
        # Hard invariant: tournament trophy MUST NEVER be tapped
        assert not _point_in_rect(x, y, screens.REF_HOME_DEFAULT_TROPHY), "Must not tap unverified tournament modal!"
        if cur == "home" and _point_in_rect(x, y, screens.REF_NAV_CARDS):
            sim["screen"] = "cards"
        elif cur == "cards" and _point_in_rect(x, y, screens.REF_CARDS_DEFAULT_PILLS[3]):
            sim["cards_preset"] = "Preset 4"
        elif cur == "cards" and _point_in_rect(x, y, screens.REF_NAV_MODULES):
            sim["screen"] = "modules"
        elif cur == "modules" and _point_in_rect(x, y, screens.REF_MODULES_DEFAULT_PILLS[1]):
            sim["modules_preset"] = "Preset 2"
        elif cur == "modules" and _point_in_rect(x, y, screens.REF_NAV_HOME):
            sim["screen"] = "home"
        else:
            raise AssertionError(f"Unexpected tap {rec} on {cur}")

    monkeypatch.setattr(screens, "identify", fake_identify)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])

    toasts: list[tuple[str, str]] = []
    tapper = SpyTapper(on_tap=on_tap)
    collector = GemCollector(
        frames,
        cfg,
        tapper=tapper,
        flow_delay_sec=(0.0, 0.0),
        max_taps_per_sec=100.0,
        on_notify=lambda m, t: toasts.append((m, t)),
        profile_store=store,
        telemetry=Telemetry(event_log_path=tmp_path / "events.jsonl"),
    )

    # 1: home -> cards, 2: cards -> Preset 4, 3: cards -> modules, 4: modules -> Preset 2, 5: modules -> home
    for _ in range(5):
        _tick_now(collector)
    assert sim == {"screen": "home", "cards_preset": "Preset 4", "modules_preset": "Preset 2"}
    assert len(tapper.calls) == 5

    # 6 & 7: back on home -> holds cleanly with tournament_capture_needed and notifies once (zero further taps!)
    _tick_now(collector)
    _tick_now(collector)
    assert len(tapper.calls) == 5
    assert collector.flow_hold_reason == "tournament_capture_needed"
    assert len(toasts) == 1
    assert "Capture a tournament screen" in toasts[0][0]


def test_abort_and_hold_after_three_unexpected_transitions(tmp_path: Path, monkeypatch):
    """After 3 failed screen transition verifications, navigator aborts, holds, notifies once, and stops tapping."""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"] = {"auto_home": True, "auto_battle": True, "auto_retry": False, "auto_resume": False}

    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(cfg)
    prof = store.get("farm-default")
    prof["presets"]["cards"] = "Preset 3"
    store.upsert(prof)

    frames = SpyFrames()
    # Always stuck on home even after tapping nav_cards -> expected ("cards",) but got "home"
    monkeypatch.setattr(screens, "identify", lambda _f: _make_home_screen(tier=9))
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])

    toasts: list[tuple[str, str]] = []
    tapper = SpyTapper()
    collector = GemCollector(
        frames,
        cfg,
        tapper=tapper,
        flow_delay_sec=(0.0, 0.0),
        max_taps_per_sec=100.0,
        on_notify=lambda m, t: toasts.append((m, t)),
        profile_store=store,
        telemetry=Telemetry(event_log_path=tmp_path / "events.jsonl"),
    )

    # Tick 1: tap nav_cards (attempt 1)
    _tick_now(collector)
    assert len(tapper.calls) == 1
    # Tick 2: verify fail #1 -> retry tap nav_cards (attempt 2)
    _tick_now(collector)
    assert collector.navigator.step_failures == 1
    assert len(tapper.calls) == 2
    # Tick 3: verify fail #2 -> retry tap nav_cards (attempt 3)
    _tick_now(collector)
    assert collector.navigator.step_failures == 2
    assert len(tapper.calls) == 3
    # Tick 4: verify fail #3 -> ABORT & HOLD, no more taps!
    _tick_now(collector)
    assert collector.navigator.step_failures == 3
    assert collector.flow_hold_reason == "nav_verify_failed"
    assert len(tapper.calls) == 3
    assert len(toasts) == 1

    # Tick 5: remains held with zero additional taps
    _tick_now(collector)
    assert len(tapper.calls) == 3
    assert len(toasts) == 1


def test_never_taps_unknown_or_forbidden_target_or_blocked_foreground(tmp_path: Path, monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"] = {"auto_home": True, "auto_battle": True, "auto_retry": False, "auto_resume": False}
    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(cfg)
    frames = SpyFrames()
    tapper = SpyTapper()

    # 1) Unknown screen -> never taps
    monkeypatch.setattr(screens, "identify", lambda _f: screens.Screen("unknown", {}, {}))
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    collector = GemCollector(frames, cfg, tapper=tapper, flow_delay_sec=(0.0, 0.0), profile_store=store)
    _tick_now(collector)
    assert tapper.calls == []

    # 2) Forged target with forbidden label ("BUY $9.99") -> validate_target blocks tap
    bad_home = screens.Screen(
        "home",
        {"tier": 9, "highest_wave": 100, "has_resume": False, "tournament_open": False},
        {"battle": screens.Target("battle", detectors.REF_HOME_BATTLE_BTN, "BUY $9.99", ("battle",))},
    )
    monkeypatch.setattr(screens, "identify", lambda _f: bad_home)
    _tick_now(collector)
    assert tapper.calls == []

    # 3) Foreground covered -> never taps
    monkeypatch.setattr(screens, "identify", lambda _f: _make_home_screen(tier=9))
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: ["com.mumu.store/Ad", f"{adb.GAME_PKG}/Activity"])
    _tick_now(collector)
    assert tapper.calls == []


def test_app_profiles_crud_activate_and_metrics_endpoints(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    frames = SpyFrames()
    app = create_app(config_path=cfg_path, frame_source=frames)
    client = app.test_client()
    ext = app.extensions["towerpilot"]

    try:
        # GET /api/profiles returns seeded starter profiles
        r_list = client.get("/api/profiles")
        assert r_list.status_code == 200
        snap = r_list.get_json()
        assert snap["schema_version"] == 1
        assert snap["active_id"] == "farm-default"
        assert {p["id"] for p in snap["profiles"]} == {"farm-default", "tier-push", "tournament"}

        # POST /api/profiles upserts a custom profile
        r_create = client.post(
            "/api/profiles",
            json={
                "id": "night-t10",
                "name": "Night T10",
                "kind": "farm",
                "enabled": True,
                "priority": 15,
                "tier": {"mode": "fixed", "value": 10},
                "presets": {"cards": "Preset 2", "modules": "Preset 1"},
                "max_runs": 3,
            },
        )
        assert r_create.status_code == 200
        created = r_create.get_json()
        assert created["profile"]["id"] == "night-t10"
        assert len(created["store"]["profiles"]) == 4

        # Invalid profile returns 400
        assert client.post("/api/profiles", json={"id": "BAD ID!", "name": "x"}).status_code == 400

        # POST /api/profiles/<id>/activate (mode="now" when off-battle switches immediately & clears verified presets)
        collector = ext["collector"]
        collector.battle_live = False
        collector.navigator.verified_cards_preset = "Preset 1"
        r_now = client.post("/api/profiles/night-t10/activate", json={"mode": "now"})
        assert r_now.status_code == 200
        body_now = r_now.get_json()
        assert body_now["store"]["active_id"] == "night-t10"
        assert body_now["status"]["profile"]["active_id"] == "night-t10"
        assert body_now["status"]["profile"]["active_name"] == "Night T10"
        assert collector.navigator.verified_cards_preset is None

        # mode="now" while battle_live queues for next instead of disrupting live run
        collector.battle_live = True
        r_queue = client.post("/api/profiles/tier-push/activate", json={"mode": "now"})
        assert r_queue.status_code == 200
        assert r_queue.get_json()["store"]["active_id"] == "night-t10"
        assert r_queue.get_json()["store"]["queued_id"] == "tier-push"

        # mode="cancel" clears queued_id
        r_cancel = client.post("/api/profiles/tier-push/activate", json={"mode": "cancel"})
        assert r_cancel.status_code == 200
        assert r_cancel.get_json()["store"]["queued_id"] is None

        # Invalid mode -> 400, missing profile -> 404
        assert client.post("/api/profiles/tier-push/activate", json={"mode": "bogus"}).status_code == 400
        assert client.post("/api/profiles/missing/activate", json={"mode": "next"}).status_code == 404

        # POST /api/profiles/<id>/reset resets runtime counters
        ext["profile_store"].record_run_ended("night-t10", {"wave": 5000})
        assert ext["profile_store"].get("night-t10")["runtime"]["runs_completed"] == 1
        r_reset = client.post("/api/profiles/night-t10/reset")
        assert r_reset.status_code == 200
        assert r_reset.get_json()["profile"]["runtime"]["runs_completed"] == 0
        assert client.post("/api/profiles/missing/reset").status_code == 404

        # DELETE /api/profiles/<id> deletes profile (and 404 on missing)
        r_del = client.delete("/api/profiles/night-t10")
        assert r_del.status_code == 200
        assert all(p["id"] != "night-t10" for p in r_del.get_json()["store"]["profiles"])
        assert client.delete("/api/profiles/night-t10").status_code == 404

        # Cannot delete last remaining profile -> 400
        assert client.delete("/api/profiles/tier-push").status_code == 200
        assert client.delete("/api/profiles/tournament").status_code == 200
        assert client.delete("/api/profiles/farm-default").status_code == 400

        # Loopback guard rejects foreign Origin on /api/profiles
        assert (
            client.post(
                "/api/profiles",
                json={"id": "evil", "name": "Evil"},
                headers={"Origin": "http://evil.example"},
            ).status_code
            == 403
        )

        # GET /api/metrics in JSON, Prometheus, and OTLP formats
        ext["telemetry"].log("Ad Gem collected", event="ad_gem_collected", count=1)
        r_json = client.get("/api/metrics")
        assert r_json.status_code == 200
        m_json = r_json.get_json()
        assert m_json["schema_version"] == 1
        assert m_json["all_time"]["ad_gems"] == 1

        r_prom = client.get("/api/metrics?format=prometheus")
        assert r_prom.status_code == 200
        assert r_prom.headers["Content-Type"] == "text/plain; version=0.0.4; charset=utf-8"
        assert "towerpilot_gems_collected_total" in r_prom.get_data(as_text=True)

        r_otlp = client.get("/api/metrics?format=otlp")
        assert r_otlp.status_code == 200
        otlp = r_otlp.get_json()
        assert "resourceMetrics" in otlp
        names = {m["name"] for m in otlp["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]}
        assert "towerpilot.gems.collected" in names
    finally:
        ext["shutdown"]()


def test_profile_hold_labels_reset_run_count_and_profile_attribution(tmp_path: Path, monkeypatch):
    """Profile max_runs/quiet_window hold labels, reset_runs_restarted, and active_prof name attribution."""
    from datetime import datetime

    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"] = {"auto_home": True, "auto_battle": True, "auto_retry": False, "auto_resume": False}
    cfg["run_rules"]["profile_name"] = "Legacy Stale Name"
    cfg["run_rules"]["max_runs"] = 0
    cfg["run_rules"]["no_start_from"] = "23:00"
    cfg["run_rules"]["no_start_until"] = "07:00"

    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(cfg)
    farm = store.get("farm-default")
    farm["max_runs"] = 1
    farm["quiet_window"] = {"enabled": True, "from": "21:30", "until": "05:30"}
    farm["runtime"]["runs_completed"] = 1
    farm["runtime"]["baseline_highest_wave"] = 8500
    store.upsert(farm)

    frames = SpyFrames()
    tapper = SpyTapper()
    monkeypatch.setattr(screens, "identify", lambda _f: _make_home_screen(tier=9))
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])

    now_box = {"dt": datetime(2026, 11, 26, 12, 0)}
    collector = GemCollector(
        frames,
        cfg,
        tapper=tapper,
        flow_delay_sec=(0.0, 0.0),
        max_taps_per_sec=100.0,
        now_local_fn=lambda: now_box["dt"],
        profile_store=store,
        telemetry=Telemetry(event_log_path=tmp_path / "events.jsonl"),
    )

    # 1) Profile max_runs hold formats profile's 1/1 (not legacy 0/0)
    _tick_now(collector)
    assert collector.flow_hold_reason == "max_runs"
    assert collector.flow_status == "holding (max runs 1/1)"
    assert tapper.calls == []

    # 2) reset_runs_restarted clears profile runtime.runs_completed (preserving baseline_highest_wave) so hold unblocks
    collector.reset_runs_restarted()
    assert store.get("farm-default")["runtime"]["runs_completed"] == 0
    assert store.get("farm-default")["runtime"]["baseline_highest_wave"] == 8500

    # 3) Profile quiet_window hold formats profile's 21:30-05:30 (not legacy 23:00-07:00)
    now_box["dt"] = datetime(2026, 11, 26, 22, 0)
    _tick_now(collector)
    assert collector.flow_hold_reason == "no_start_window"
    assert collector.flow_status == "holding (quiet 21:30-05:30)"
    assert tapper.calls == []

    # 4) Outside quiet window -> resumes and starts battle!
    now_box["dt"] = datetime(2026, 11, 26, 12, 0)
    _tick_now(collector)
    assert collector.flow_hold_reason is None
    assert len(tapper.calls) == 1

    # 5) _record_run_ended attributes run to active profile ("Tier Push"), NOT stale config profile_name
    store.activate("tier-push")
    collector._stats_logged_for_run = False
    monkeypatch.setattr(
        detectors,
        "read_end_stats",
        lambda _f: run_rules.parse_end_stats("GAME STATS Wave 4500 Tier 12 Killed By Boss", "2.00T + 1.00T = 3.00T"),
    )
    rec = collector._record_run_ended(_blank_frame())
    assert rec is not None
    assert rec["profile_id"] == "tier-push"
    assert rec["profile_name"] == "Tier Push"
    assert rec["profile"] == "Tier Push"
    assert "tier-push" in collector.telemetry.snapshot()["by_profile"]
    assert collector.telemetry.snapshot()["by_profile"]["tier-push"]["profile_name"] == "Tier Push"


def test_fable_safety_and_contract_regressions(tmp_path: Path, monkeypatch):
    """Covers Fable #1 (resume guard), #3 (sticky queued_id), #4 (fresh tier check), #5 (safety hold preservation), #6 (nav_tier_ceiling + nav_taps), and ceiling reset."""
    # --- Fable #1: has_resume=True with auto_resume=False must NEVER tap tier arrows or nav tabs ---
    cfg1 = copy.deepcopy(DEFAULT_CONFIG)
    cfg1["run_flow"] = {"auto_home": True, "auto_battle": True, "auto_retry": False, "auto_resume": False}
    store1 = ProfileStore(tmp_path / "p1.json")
    store1.seed_from_config(cfg1)
    farm1 = store1.get("farm-default")
    farm1["presets"]["cards"] = "Preset 3"
    farm1["tier"] = {"mode": "fixed", "value": 11}
    store1.upsert(farm1)

    tapper1 = SpyTapper()
    monkeypatch.setattr(screens, "identify", lambda _f: _make_home_screen(tier=9, has_resume=True))
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    c1 = GemCollector(SpyFrames(), cfg1, tapper=tapper1, flow_delay_sec=(0.0, 0.0), profile_store=store1)
    _tick_now(c1)
    assert tapper1.calls == []
    assert c1.flow_status == "watching (resume pending)"

    # --- Fable #3: Disabled profile activated via immediate=True sticks across multi-step nav and clears ONLY after BATTLE ---
    cfg3 = copy.deepcopy(DEFAULT_CONFIG)
    cfg3["run_flow"] = {"auto_home": True, "auto_battle": True, "auto_retry": False, "auto_resume": False}
    store3 = ProfileStore(tmp_path / "p3.json")
    store3.seed_from_config(cfg3)
    push3 = store3.get("tier-push")
    push3["enabled"] = False
    push3["presets"]["cards"] = "Preset 3"
    push3["tier"] = {"mode": "fixed", "value": 11}
    store3.upsert(push3)
    store3.queue_next("tier-push", immediate=True)
    assert store3.snapshot()["queued_id"] == "tier-push"

    sim3 = {"screen": "home", "cards": "Preset 1", "tier": 11}

    def id3(_f):
        if sim3["screen"] == "home":
            return _make_home_screen(tier=sim3["tier"])
        if sim3["screen"] == "cards":
            return _make_cards_screen(active_preset=sim3["cards"])
        return screens.Screen("battle", {"menu_state": "closed"}, {})

    def tap3(rec):
        x, y = rec["x"], rec["y"]
        if sim3["screen"] == "home" and _point_in_rect(x, y, screens.REF_NAV_CARDS):
            sim3["screen"] = "cards"
        elif sim3["screen"] == "cards" and _point_in_rect(x, y, screens.REF_CARDS_DEFAULT_PILLS[2]):
            sim3["cards"] = "Preset 3"
        elif sim3["screen"] == "cards" and _point_in_rect(x, y, screens.REF_NAV_HOME):
            sim3["screen"] = "home"
        elif sim3["screen"] == "home" and _point_in_rect(x, y, detectors.REF_HOME_BATTLE_BTN):
            sim3["screen"] = "battle"

    monkeypatch.setattr(screens, "identify", id3)
    tapper3 = SpyTapper(on_tap=tap3)
    c3 = GemCollector(SpyFrames(), cfg3, tapper=tapper3, flow_delay_sec=(0.0, 0.0), profile_store=store3)
    # 1: home -> cards, 2: cards -> Preset 3, 3: cards -> home: queued_id MUST stay "tier-push"
    for _ in range(3):
        _tick_now(c3)
        assert store3.snapshot()["queued_id"] == "tier-push"
    # 4: home -> battle: clears queued_id ONLY after successful BATTLE tap
    _tick_now(c3)
    assert sim3["screen"] == "battle"
    assert store3.snapshot()["queued_id"] is None

    # --- Fable #4: _before_battle checks profiles.tier_matches on fresh ADB frame (wrong or unreadable tier -> hold) ---
    store4 = ProfileStore(tmp_path / "p4.json")
    store4.seed_from_config(cfg3)
    farm4 = store4.get("farm-default")
    farm4["tier"] = {"mode": "fixed", "value": 11}
    store4.upsert(farm4)

    for bad_tier in (9, None):
        calls = {"n": 0}

        def id4(_f, bt=bad_tier):
            calls["n"] += 1
            # Preview scan sees T11, fresh ADB verify right before BATTLE sees wrong/unreadable tier!
            return _make_home_screen(tier=11 if calls["n"] == 1 else bt)

        monkeypatch.setattr(screens, "identify", id4)
        tapper4 = SpyTapper()
        c4 = GemCollector(SpyFrames(), cfg3, tapper=tapper4, flow_delay_sec=(0.0, 0.0), profile_store=store4)
        _tick_now(c4)
        assert tapper4.calls == []
        assert c4.flow_hold_reason == "tier_mismatch"
        expected_tok = f"T{bad_tier}" if bad_tier is not None else "T?"
        assert f"{expected_tok} != T11" in c4.flow_status

    # --- Fable #5: reconfigure() toggling unrelated setting MUST NOT clear hard safety aborts ---
    c5 = GemCollector(SpyFrames(), cfg3, tapper=SpyTapper(), flow_delay_sec=(0.0, 0.0), profile_store=store4)
    c5.running = True
    c5.navigator.hold_reason = "nav_verify_failed"
    c5.navigator._last_hold_reason = "nav_verify_failed"
    c5.navigator.nav_state = "holding (nav failed 3x on home)"
    c5.navigator.step_failures = 3

    cfg5_toggle = copy.deepcopy(cfg3)
    cfg5_toggle["floating_gems"]["enabled"] = False
    c5.reconfigure(cfg5_toggle)
    assert c5.flow_hold_reason == "nav_verify_failed"
    assert c5.flow_status == "holding (nav failed 3x on home)"
    assert c5.navigator.step_failures == 3

    # Legacy policy hold (finish_and_stop) DOES still clear when unarmed
    c5.navigator.hold_reason = "finish_and_stop"
    c5.navigator._last_hold_reason = "finish_and_stop"
    c5.navigator.nav_state = "holding (finish & stop)"
    c5.reconfigure(cfg5_toggle)
    assert c5.flow_hold_reason is None
    assert c5.flow_status == "watching"

    # --- Fable #6 + Ceiling reset: nav_tier_ceiling event, exact nav_taps, and ceiling reset on battle live ---
    store6 = ProfileStore(tmp_path / "p6.json")
    store6.seed_from_config(cfg3)
    push6 = store6.get("tier-push")
    push6["enabled"] = True
    push6["max_runs"] = 2
    store6.upsert(push6)
    log6 = tmp_path / "events6.jsonl"
    tel6 = Telemetry(event_log_path=log6)

    sim6 = {"tier": 15, "max_unlocked": 15, "screen": "home"}

    def id6(_f):
        if sim6["screen"] == "home":
            return _make_home_screen(tier=sim6["tier"], highest_wave=100)
        return screens.Screen("battle", {"menu_state": "closed"}, {})

    def tap6(rec):
        if _point_in_rect(rec["x"], rec["y"], screens.REF_HOME_TIER_NEXT):
            sim6["tier"] = min(sim6["max_unlocked"], sim6["tier"] + 1)
        elif _point_in_rect(rec["x"], rec["y"], detectors.REF_HOME_BATTLE_BTN):
            sim6["screen"] = "battle"

    monkeypatch.setattr(screens, "identify", id6)
    tapper6 = SpyTapper(on_tap=tap6)
    c6 = GemCollector(SpyFrames(), cfg3, tapper=tapper6, flow_delay_sec=(0.0, 0.0), profile_store=store6, telemetry=tel6)

    # 3 ticks: 2 stalled tier_next taps + 1 battle tap = 3 physical taps
    for _ in range(3):
        _tick_now(c6)
    assert sim6["screen"] == "battle"
    assert len(tapper6.calls) == 3
    rows6 = [json.loads(line) for line in log6.read_text(encoding="utf-8").splitlines()]
    assert any(r["event"] == "nav_tier_ceiling" for r in rows6)
    assert tel6.snapshot()["all_time"]["nav_taps"] == 3

    # Enter live battle -> resets ceiling_tier_reached & tier_stall_count
    c6.navigator.on_enter_battle(flow_enabled=True)
    assert c6.navigator.ceiling_tier_reached is False
    assert c6.navigator.tier_stall_count == 0

    # After run 1 unlocks T16, returning to Home probes tier_next and advances to T16!
    sim6["screen"] = "home"
    sim6["max_unlocked"] = 16
    _tick_now(c6)
    assert sim6["tier"] == 16
