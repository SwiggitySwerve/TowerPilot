"""Offline tests for wave OCR underscore fix, restart-safe exact Coins/hr, live HUD Coins/hr, and gated Setup Test."""
from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest

from app import create_app
from towerpilot import adb, detectors, screens, telemetry
from towerpilot.collector import GemCollector
from towerpilot.config import DEFAULT_CONFIG
from towerpilot.setup_test import MAX_ALLOWED_WAVE_CAP, SetupTester


def _battle_frame(*, menu_open: bool = False, bright_wave: bool = True, bright_hud: bool = True) -> np.ndarray:
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    cv2.rectangle(frame, (x + 2, y + 2), (x + w - 3, y + h - 3), (250, 250, 250), 2)
    for by in (22, 43, 64):
        cv2.rectangle(frame, (x + 20, y + by), (x + w - 20, y + by + 7), (250, 250, 250), -1)
    if menu_open:
        # Open side menu panel sits to the right (x=820..1070) with bright borders/text
        cv2.rectangle(frame, (830, 120), (1070, 860), (220, 220, 220), 2)
        cv2.rectangle(frame, (850, 560), (1050, 740), (240, 240, 240), -1)
    if bright_wave:
        wx, wy, ww, wh = detectors.REF_WAVE_PANEL
        cv2.rectangle(frame, (wx + 10, wy + 10), (wx + ww - 10, wy + wh - 10), (240, 240, 240), -1)
    if bright_hud:
        hx, hy, hw, hh = detectors.REF_HUD_COINS
        cv2.rectangle(frame, (hx + 10, hy + 10), (hx + hw - 10, hy + hh - 10), (240, 240, 240), -1)
    return frame


def _confirm_dialog_frame() -> np.ndarray:
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    dx, dy, dw, dh = detectors.REF_CONFIRM_DIALOG
    cv2.rectangle(frame, (dx + 20, dy + 20), (dx + dw - 20, dy + dh - 20), (200, 200, 200), -1)
    return frame


class DummyFrames:
    def __init__(self, frame: np.ndarray) -> None:
        self.frame = frame
        self.last_frame = frame
        self.active_backend = "mumu"
        self.last_error = None
        self.last_frame_size = (frame.shape[1], frame.shape[0])
        self.input_display = None

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self.frame.copy(), "mumu"

    def grab_adb(self):
        return self.frame.copy()

    def read_frame(self, *, prefer_preview: bool = True):
        return self.frame.copy(), "mumu"

    def close(self) -> None:
        pass


# --- 1. Wave OCR & HUD Meta ----------------------------------------------


def test_read_wave_ocr_handles_underscores_and_ignores_tier_only():
    frame = _battle_frame()
    # Progress bar underscores broke \b(\d+)\b previously
    assert detectors.read_wave_ocr(frame, ocr_fn=lambda crops: ["5750___", ""]) == 5750
    assert detectors.read_wave_ocr(frame, ocr_fn=lambda crops: ["Tier 10 Wave 5,758", ""]) == 5758
    assert detectors.read_wave_ocr(frame, ocr_fn=lambda crops: ["", "Tier 10 Wave 6120___"]) == 6120
    # Partial read showing only 'Tier 10' must NEVER return Wave 10
    assert detectors.read_wave_ocr(frame, ocr_fn=lambda crops: ["Tier 10", ""]) is None


def test_read_battle_hud_meta_parses_tier_coins_and_tournament():
    frame = _battle_frame()
    meta = detectors.read_battle_hud_meta(
        frame,
        ocr_fn=lambda crops: ["Tier 10 Wave 5758", "", "@ 57.66T"],
    )
    assert meta["tier"] == 10
    assert meta["coins_raw"] == "57.66T"
    assert meta["coins"] == pytest.approx(57.66e12)
    assert meta["tournament"] is False

    tourney = detectors.read_battle_hud_meta(
        frame,
        ocr_fn=lambda crops: ["TOURNAMENT Legends Wave 420", "", "12.50B"],
    )
    assert tourney["tournament"] is True
    assert tourney["coins_raw"] == "12.50B"


# --- 2. Exit Battle & Surrender Confirm OCR detectors --------------------


def test_detect_exit_battle_and_surrender_confirm(monkeypatch):
    closed_frame = _battle_frame(menu_open=False)
    open_frame = _battle_frame(menu_open=True)
    monkeypatch.setattr(detectors, "side_menu_state", lambda f: "open" if f is open_frame else "closed")

    # Refuses when side menu is closed
    assert detectors.detect_exit_battle_button(closed_frame, lines_fn=lambda c: [[(100, 20, "EXIT BATTLE")]]) is None

    # Detects EXIT BATTLE and END ROUND when open
    hit = detectors.detect_exit_battle_button(open_frame, lines_fn=lambda c: [[(110, 24, "EXIT BATTLE")]])
    assert hit is not None
    assert hit.label == "EXIT BATTLE"

    hit2 = detectors.detect_exit_battle_button(open_frame, lines_fn=lambda c: [[(120, 24, "END ROUND")]])
    assert hit2 is not None
    assert hit2.label == "END ROUND"

    # Confirm dialog: prefers SURRENDER over title and rejects GO HOME / spend dialogs
    dlg = _confirm_dialog_frame()
    conf = detectors.detect_surrender_confirm(
        dlg,
        lines_fn=lambda c: [[
            (80, 180, "EXIT BATTLE?"),
            (520, 120, "GO HOME"),
            (520, 500, "SURRENDER"),
        ]],
    )
    assert conf is not None
    assert conf.label == "SURRENDER"

    conf_yes = detectors.detect_surrender_confirm(
        dlg,
        lines_fn=lambda c: [[
            (90, 180, "END ROUND?"),
            (520, 150, "NO"),
            (520, 500, "YES"),
        ]],
    )
    assert conf_yes is not None
    assert conf_yes.label == "YES"

    # Spend/purchase dialog must always be rejected
    assert (
        detectors.detect_surrender_confirm(
            dlg,
            lines_fn=lambda c: [[(80, 100, "SURRENDER"), (300, 100, "BUY $9.99"), (520, 500, "YES")]],
        )
        is None
    )
    assert (
        detectors.detect_surrender_confirm(
            dlg,
            lines_fn=lambda c: [[(80, 100, "SHATTER MODULE?"), (520, 500, "YES")]],
        )
        is None
    )


# --- 3. Restart-safe exact run recovery & Live Coins/hr ------------------


def test_recover_open_run_preserves_exact_start_across_restarts(tmp_path: Path):
    log_path = tmp_path / "events.jsonl"
    now = time.time()
    started_ts = now - 7200.0
    entries = [
        {"ts": started_ts - 60.0, "event": "run_ended", "tier": 10, "wave": 8186},
        {"ts": started_ts, "event": "home_battle_tapped", "tier": 10, "iteration_id": "iter-0003"},
    ]
    log_path.write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")

    rec = telemetry.recover_open_run(log_path, now=now)
    assert rec is not None
    assert rec["started_at"] == pytest.approx(started_ts)
    assert rec["exact"] is True
    assert rec["tier"] == 10
    assert rec["iteration_id"] == "iter-0003"

    # Once run_ended or setup_test_surrendered is logged afterwards, returns None
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": now - 10.0, "event": "run_ended", "tier": 10}) + "\n")
    assert telemetry.recover_open_run(log_path, now=now) is None

    # Resuming after a crash marks exact=False
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": now - 5.0, "event": "home_resume_tapped", "tier": 11}) + "\n")
    rec_resume = telemetry.recover_open_run(log_path, now=now)
    assert rec_resume is not None
    assert rec_resume["exact"] is False
    assert rec_resume["tier"] == 11


def test_collector_recovers_open_run_and_computes_live_coins_per_hour(tmp_path: Path, monkeypatch):
    log_path = tmp_path / "events.jsonl"
    now_wall = time.time()
    started_ts = now_wall - 3600.0
    log_path.write_text(
        json.dumps({"ts": started_ts, "event": "home_battle_tapped", "tier": 10}) + "\n",
        encoding="utf-8",
    )

    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["ad_gems"]["enabled"] = False
    cfg["floating_gems"]["enabled"] = False
    frames = DummyFrames(_battle_frame())
    collector = GemCollector(frames, cfg, event_log_path=log_path)

    # Start timestamp & exactness recovered immediately on init
    assert collector._run_start_exact is True
    assert collector.current_tier == 10
    assert collector._run_started_at == pytest.approx(started_ts)

    # Simulate two HUD coin samples 120s apart (+1.0T coins -> 30.0T/hr)
    samples = iter([
        {"tier": 10, "coins": 50.0e12, "coins_raw": "50.00T", "tournament": False},
        {"tier": 10, "coins": 51.0e12, "coins_raw": "51.00T", "tournament": False},
    ])
    monkeypatch.setattr(detectors, "read_battle_hud_meta", lambda frame: next(samples))
    monkeypatch.setattr(detectors, "read_wave_ocr", lambda frame: 5760)

    t0 = 1000.0
    collector._hud_meta_last_scan = 0.0
    monkeypatch.setattr(time, "time", lambda: now_wall)
    collector._step_hud_meta(frames.frame, t0)
    assert collector.current_coins_raw == "50.00T"
    assert collector.live_coins_per_hour is None  # baseline sample

    monkeypatch.setattr(time, "time", lambda: now_wall + 120.0)
    collector._step_hud_meta(frames.frame, t0 + 20.0)
    assert collector.current_coins_raw == "51.00T"
    assert collector.live_coins_per_hour == pytest.approx(30.0e12, rel=1e-3)
    assert collector.live_coins_per_hour_fmt == "30.00T"


# --- 4. SetupTester safety gates & full offline state machine ------------


def test_setup_tester_hard_safety_gates():
    tester = SetupTester(
        grab_verified_frame=lambda: (_battle_frame(), None),
        check_foreground=lambda d: (True, "ok"),
        tap=lambda *a, **kw: {"x": 10, "y": 10},
        log=lambda *a, **kw: None,
    )

    # Hard cap > 100 rejected
    with pytest.raises(ValueError):
        tester.start_surrender(battle_live=True, current_wave=5, max_wave=MAX_ALLOWED_WAVE_CAP + 1)
    with pytest.raises(ValueError):
        tester.start_iteration(battle_live=False, current_wave=None, max_wave=0)

    # Tournament rejected
    with pytest.raises(RuntimeError, match="tournament"):
        tester.start_surrender(battle_live=True, current_wave=5, is_tournament=True, max_wave=50)

    # Unreadable wave rejected
    with pytest.raises(RuntimeError, match="unreadable"):
        tester.start_surrender(battle_live=True, current_wave=None, max_wave=50)

    # High wave (e.g. live farm at Wave 5758) strictly refused
    with pytest.raises(RuntimeError, match="Wave 5758"):
        tester.start_surrender(battle_live=True, current_wave=5758, max_wave=50)
    with pytest.raises(RuntimeError, match="Live battle in progress"):
        tester.start_iteration(battle_live=True, current_wave=5758, max_wave=50)


def test_setup_tester_full_iteration_flow_offline(monkeypatch):
    taps: list[str] = []
    events: list[str] = []
    stage = {"name": "home"}

    home_frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    battle_closed = _battle_frame(menu_open=False)
    battle_open = _battle_frame(menu_open=True)
    confirm_frame = _confirm_dialog_frame()
    stats_frame = np.zeros((2560, 1080, 3), dtype=np.uint8)

    def current_frame() -> np.ndarray:
        return {
            "home": home_frame,
            "battle_closed": battle_closed,
            "battle_open": battle_open,
            "confirm": confirm_frame,
            "stats": stats_frame,
            "home_done": home_frame,
        }[stage["name"]]

    def fake_tap(pt, frame, *, reason="", input_display=None):
        taps.append(reason)
        transitions = {
            "setup_test:enter_battle": "battle_closed",
            "setup_test:open_side_menu": "battle_open",
            "setup_test:exit battle": "confirm",
            "setup_test:confirm_surrender": "stats",
            "setup_test:stats_home": "home_done",
        }
        if reason in transitions:
            stage["name"] = transitions[reason]
        return {"x": pt[0], "y": pt[1]}

    def fake_identify(frame, **_kw):
        if stage["name"] in ("home", "home_done"):
            return screens.Screen(
                name="home",
                targets={
                    "battle": screens.Target(
                        name="battle",
                        rect=(340, 1780, 400, 150),
                        label="BATTLE",
                        expects=("battle",),
                    )
                },
                facts={"tier": 10},
            )
        if stage["name"] == "stats":
            return screens.Screen(
                name="game_stats",
                targets={
                    "home": screens.Target(
                        name="home",
                        rect=(120, 1900, 320, 120),
                        label="HOME",
                        expects=("home",),
                    )
                },
                facts={},
            )
        return screens.Screen(name="unknown", targets={}, facts={})

    monkeypatch.setattr(screens, "identify", fake_identify)
    monkeypatch.setattr(screens, "validate_target", lambda *a, **kw: True)
    monkeypatch.setattr(
        detectors,
        "menu_toggle_visible",
        lambda f: stage["name"] in ("battle_closed", "battle_open"),
    )
    monkeypatch.setattr(
        detectors,
        "side_menu_state",
        lambda f: "open" if stage["name"] == "battle_open" else ("closed" if stage["name"] == "battle_closed" else "obscured"),
    )
    monkeypatch.setattr(
        detectors,
        "read_battle_hud_meta",
        lambda f: {"tier": 10, "coins": 100.0, "coins_raw": "100", "tournament": False, "readable": True},
    )
    monkeypatch.setattr(detectors, "read_wave_strict", lambda f: 3)
    monkeypatch.setattr(
        detectors,
        "detect_exit_battle_button",
        lambda f: detectors.ButtonHit(rect=(860, 600, 190, 68), center=(955, 634), label="EXIT BATTLE", screen="battle_menu")
        if stage["name"] == "battle_open"
        else None,
    )
    monkeypatch.setattr(
        detectors,
        "detect_surrender_confirm",
        lambda f: detectors.ButtonHit(rect=(540, 1240, 260, 90), center=(670, 1285), label="SURRENDER", screen="surrender_confirm")
        if stage["name"] == "confirm"
        else None,
    )
    monkeypatch.setattr(detectors, "detect_end_stats_home", lambda f: None)

    tester = SetupTester(
        grab_verified_frame=lambda: (current_frame(), None),
        check_foreground=lambda d: (True, "ok"),
        tap=fake_tap,
        log=lambda msg, **kw: events.append(str(kw.get("event", "info"))),
        step_cooldown_sec=0.0,
    )

    st = tester.start_iteration(battle_live=False, current_wave=None, max_wave=50)
    assert st["active"] is True
    assert st["phase"] == "enter_battle"

    now = 100.0
    for _ in range(10):
        if not tester.active:
            break
        tester.step(current_frame(), now, known_wave=3)
        now += 5.0

    assert tester.active is False
    assert tester.phase == "done"
    assert tester.iterations_completed == 1
    assert taps == [
        "setup_test:enter_battle",
        "setup_test:open_side_menu",
        "setup_test:exit battle",
        "setup_test:confirm_surrender",
        "setup_test:stats_home",
    ]
    assert "setup_test_surrendered" in events
    assert "setup_test_completed" in events
    assert "run_ended" not in events


def test_setup_test_flask_api_gates(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    frames = DummyFrames(_battle_frame())
    app = create_app(config_path=cfg_path, frame_source=frames)
    client = app.test_client()
    collector = app.extensions["towerpilot"]["collector"]

    try:
        # GET works when idle
        g = client.get("/api/setup-test")
        assert g.status_code == 200
        assert g.get_json()["active"] is False

        # Refused with 409 when harvesting is OFF
        r_off = client.post("/api/setup-test", json={"action": "start", "max_wave": 50})
        assert r_off.status_code == 409

        # Turn harvesting ON, simulate live high-wave battle (Wave 5758) -> 409 refused!
        collector.running = True
        collector.battle_live = True
        collector.current_wave = 5758
        r_high = client.post("/api/setup-test", json={"action": "surrender", "max_wave": 50})
        assert r_high.status_code == 409
        assert "5758" in r_high.get_json()["error"]

        # max_wave > 100 -> 400
        r_cap = client.post("/api/setup-test", json={"action": "surrender", "max_wave": 500})
        assert r_cap.status_code == 400

        # Low-wave non-tournament battle -> 200 armed, then cancel -> 200 idle
        collector.current_wave = 4
        r_ok = client.post("/api/setup-test", json={"action": "surrender", "max_wave": 50})
        assert r_ok.status_code == 200
        assert r_ok.get_json()["setup_test"]["active"] is True

        r_cancel = client.post("/api/setup-test", json={"action": "cancel"})
        assert r_cancel.status_code == 200
        assert r_cancel.get_json()["setup_test"]["active"] is False

        # P2-3: unknown profile_id returns 404 without mutating state; valid profile_id works when off-battle
        collector.battle_live = False
        frames.frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
        frames.last_frame = frames.frame
        r_missing = client.post("/api/setup-test", json={"action": "start", "max_wave": 50, "profile_id": "nonexistent"})
        assert r_missing.status_code == 404
        r_prof = client.post("/api/setup-test", json={"action": "start", "max_wave": 50, "profile_id": "tier-push"})
        assert r_prof.status_code == 200
        assert r_prof.get_json()["setup_test"]["active"] is True
        client.post("/api/setup-test", json={"action": "cancel"})
    finally:
        collector.running = False
        app.extensions["towerpilot"]["shutdown"]()


def test_p1_2_setup_guard_fails_closed_on_ocr_error_split_wave_and_tier_plus(monkeypatch):
    """P1-2: SetupTester never falls back to cached known_wave, refuses Tier 8+, refuses Wave 0 and split digits."""
    frame = _battle_frame()
    # Strict wave rejects split digits & bare numbers
    assert detectors.read_wave_strict(frame, ocr_fn=lambda c: ["Tier 10 Wave 5 758", ""]) is None
    assert detectors.read_wave_strict(frame, ocr_fn=lambda c: ["37", "Wavc 5758"]) is None
    assert detectors.read_wave_strict(frame, ocr_fn=lambda c: ["Tier 10 Wave 12", ""]) == 12

    # Tier N+ is detected as tournament, and coin parser ignores '$' and '25O.3T'
    meta_t = detectors.read_battle_hud_meta(frame, ocr_fn=lambda c: ["Tier 8+ Wave 12", "", "$1.25M 250.3T"])
    assert meta_t["tournament"] is True
    assert meta_t["coins_raw"] == "250.3T"
    meta_bad = detectors.read_battle_hud_meta(frame, ocr_fn=lambda c: ["Tier 10 Wave 12", "", "25O.3T"])
    assert meta_bad["coins"] is None

    tester = SetupTester(
        grab_verified_frame=lambda: (frame, None),
        check_foreground=lambda d: (True, "ok"),
        tap=lambda *a, **kw: {"x": 10, "y": 10},
        log=lambda *a, **kw: None,
    )
    # Wave 0 refused
    with pytest.raises(RuntimeError):
        tester.start_surrender(battle_live=True, current_wave=0, max_wave=50)

    # OCR failure -> readable=False -> guard refuses EVEN when known_wave=12
    monkeypatch.setattr(detectors, "read_battle_hud_meta", lambda f: {"tier": None, "coins": None, "coins_raw": None, "tournament": False, "readable": False})
    monkeypatch.setattr(detectors, "read_wave_strict", lambda f: None)
    ok, _why = tester._check_wave_and_tourney_guard(frame, known_wave=12)
    assert ok is False


def test_p2_6_live_coins_per_hour_ignores_single_low_ocr_glitch(tmp_path: Path, monkeypatch):
    """P2-6: One low OCR misread does NOT rebase _run_start_coins or poison live Coins/hr."""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["ad_gems"]["enabled"] = False
    cfg["floating_gems"]["enabled"] = False
    frames = DummyFrames(_battle_frame())
    collector = GemCollector(frames, cfg, event_log_path=tmp_path / "events.jsonl")

    samples = iter([
        {"tier": 10, "coins": 250.0e12, "coins_raw": "250.0T", "tournament": False, "readable": True},
        {"tier": 10, "coins": 25.03e12, "coins_raw": "25.03T", "tournament": False, "readable": True},  # 1-frame glitch!
        {"tier": 10, "coins": 250.5e12, "coins_raw": "250.5T", "tournament": False, "readable": True},
    ])
    monkeypatch.setattr(detectors, "read_battle_hud_meta", lambda frame: next(samples))

    t0 = 1000.0
    collector._hud_meta_last_scan = 0.0
    monkeypatch.setattr(time, "time", lambda: 10000.0)
    collector._step_hud_meta(frames.frame, t0)
    monkeypatch.setattr(time, "time", lambda: 10120.0)
    collector._step_hud_meta(frames.frame, t0 + 20.0)
    monkeypatch.setattr(time, "time", lambda: 10360.0)  # +360s = 0.1 hr -> +0.5T = 5.0T/hr
    collector._step_hud_meta(frames.frame, t0 + 40.0)

    assert collector.live_coins_per_hour == pytest.approx(5.0e12, rel=1e-2)
    assert collector.live_coins_per_hour_fmt == "5.00T"


def test_p2_a_live_coins_rejects_impossible_mantissa_and_consecutive_low_dips(tmp_path: Path, monkeypatch):
    """P2-A: Suffixed mantissa >= 1000 ('73096T') and repeated low dips never poison live Coins/hr."""
    frame = _battle_frame()
    frame[10:200, 10:300] = 200
    bad_meta = detectors.read_battle_hud_meta(frame, ocr_fn=lambda crops: ["Tier 10", "", "73096T"])
    assert bad_meta["coins"] is None
    good_meta = detectors.read_battle_hud_meta(frame, ocr_fn=lambda crops: ["Tier 10", "", "73.96T"])
    assert good_meta["coins_raw"] == "73.96T"

    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["ad_gems"]["enabled"] = False
    cfg["floating_gems"]["enabled"] = False
    frames = DummyFrames(frame)
    collector = GemCollector(frames, cfg, event_log_path=tmp_path / "events.jsonl")

    samples = iter([
        {"tier": 10, "coins": 73.0e12, "coins_raw": "73.00T", "tournament": False, "readable": True},
        {"tier": 10, "coins": 0.3e12, "coins_raw": "0.30T", "tournament": False, "readable": True},   # low dip #1
        {"tier": 10, "coins": 0.3e12, "coins_raw": "0.30T", "tournament": False, "readable": True},   # low dip #2
        {"tier": 10, "coins": 73096.0e12, "coins_raw": "73096T", "tournament": False, "readable": True},  # spike
        {"tier": 10, "coins": 73.5e12, "coins_raw": "73.50T", "tournament": False, "readable": True},
    ])
    monkeypatch.setattr(detectors, "read_battle_hud_meta", lambda f: next(samples))

    t0 = 1000.0
    collector._hud_meta_last_scan = 0.0
    for idx, wall in enumerate((10000.0, 10020.0, 10040.0, 10060.0, 10360.0)):
        monkeypatch.setattr(time, "time", lambda w=wall: w)
        collector._step_hud_meta(frames.frame, t0 + idx * 20.0)

    # +0.5T over 360s (0.1h) = 5.00T/hr — never rebased to 0.3T and never spiked to 330q/hr
    assert collector.current_coins_raw == "73.50T"
    assert collector.live_coins_per_hour == pytest.approx(5.0e12, rel=1e-2)
    assert collector.live_coins_per_hour_fmt == "5.00T"


def test_s1_live_coins_self_heals_from_bad_initial_baseline(tmp_path: Path, monkeypatch):
    """S1: A bad initial baseline (too low OR too high) self-heals via consistent repeated readings."""
    frame = _battle_frame()
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["ad_gems"]["enabled"] = False
    cfg["floating_gems"]["enabled"] = False
    frames = DummyFrames(frame)

    # Case 1: Initial baseline read too low (6.25T instead of 66.25T) -> 2 consistent 66.25T readings rebase cleanly
    c1 = GemCollector(frames, cfg, event_log_path=tmp_path / "events1.jsonl")
    s1 = iter([
        {"tier": 10, "coins": 6.25e12, "coins_raw": "6.25T", "tournament": False},
        {"tier": 10, "coins": 66.25e12, "coins_raw": "66.25T", "tournament": False},
        {"tier": 10, "coins": 66.26e12, "coins_raw": "66.26T", "tournament": False},
        {"tier": 10, "coins": 66.76e12, "coins_raw": "66.76T", "tournament": False},
    ])
    monkeypatch.setattr(detectors, "read_battle_hud_meta", lambda f: next(s1))
    c1._hud_meta_last_scan = 0.0
    for idx, wall in enumerate((10000.0, 10020.0, 10040.0, 10400.0)):
        monkeypatch.setattr(time, "time", lambda w=wall: w)
        c1._step_hud_meta(frames.frame, 1000.0 + idx * 20.0)
    assert c1.current_coins_raw == "66.76T"
    # +0.50T over 360s (0.1h) = 5.00T/hr (NOT fake +60T/hr)
    assert c1.live_coins_per_hour == pytest.approx(5.0e12, rel=1e-2)

    # Case 2: Initial baseline read too high (662.5T instead of 66.25T) -> 3 consistent lower readings rebase cleanly
    c2 = GemCollector(frames, cfg, event_log_path=tmp_path / "events2.jsonl")
    s2 = iter([
        {"tier": 10, "coins": 662.5e12, "coins_raw": "662.5T", "tournament": False},
        {"tier": 10, "coins": 66.25e12, "coins_raw": "66.25T", "tournament": False},
        {"tier": 10, "coins": 66.26e12, "coins_raw": "66.26T", "tournament": False},
        {"tier": 10, "coins": 66.27e12, "coins_raw": "66.27T", "tournament": False},
        {"tier": 10, "coins": 66.77e12, "coins_raw": "66.77T", "tournament": False},
    ])
    monkeypatch.setattr(detectors, "read_battle_hud_meta", lambda f: next(s2))
    c2._hud_meta_last_scan = 0.0
    for idx, wall in enumerate((10000.0, 10020.0, 10040.0, 10060.0, 10420.0)):
        monkeypatch.setattr(time, "time", lambda w=wall: w)
        c2._step_hud_meta(frames.frame, 1000.0 + idx * 20.0)
    assert c2.current_coins_raw == "66.77T"
    assert c2.live_coins_per_hour == pytest.approx(5.0e12, rel=1e-2)

    # Case 3 (S10): Established rate + two 100x decimal-drop misreads (6.62T -> 662T) must rebase, never inflate Coins/hr
    c3 = GemCollector(frames, cfg, event_log_path=tmp_path / "events3.jsonl")
    s3 = iter([
        {"tier": 10, "coins": 6.62e12, "coins_raw": "6.62T", "tournament": False},
        {"tier": 10, "coins": 6.80e12, "coins_raw": "6.80T", "tournament": False},
        {"tier": 10, "coins": 662.0e12, "coins_raw": "662T", "tournament": False},
        {"tier": 10, "coins": 662.0e12, "coins_raw": "662T", "tournament": False},
    ])
    monkeypatch.setattr(detectors, "read_battle_hud_meta", lambda f: next(s3))
    c3._hud_meta_last_scan = 0.0
    for idx, wall in enumerate((10000.0, 10360.0, 10380.0, 10400.0)):
        monkeypatch.setattr(time, "time", lambda w=wall: w)
        c3._step_hud_meta(frames.frame, 1000.0 + idx * 20.0)
    assert c3.live_coins_per_hour is None  # Rebased cleanly instead of publishing ~6500T/hr fake earnings


def test_p3_routine_countdown_is_none_off_battle_and_failed_start_backs_off(tmp_path: Path, monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["routines"]["auto_claim_daily"] = True
    cfg["routines"]["daily_interval_min"] = 30
    frames = DummyFrames(_battle_frame())
    collector = GemCollector(frames, cfg, event_log_path=tmp_path / "events.jsonl")
    collector.running = True
    collector.battle_live = False

    st = collector.battle_menu_status()
    assert st["next_auto_sec"]["daily_quests"] is None

    # Failed start during battle backs off 30s instead of consuming full 30m interval
    collector.battle_live = True
    collector._auto_routine_next_at["daily_quests"] = 0.0
    monkeypatch.setattr(collector._battle_menu, "start", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("busy")))
    collector._step_auto_routines(1000.0)
    assert collector._auto_routine_next_at["daily_quests"] == pytest.approx(1030.0)


