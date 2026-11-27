"""Offline unit tests for run rules, GAME STATS ledger scraping, freeze watch, and hold-aware tray."""
from __future__ import annotations

import copy
import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import yaml

from app import create_app
from towerpilot import adb, detectors, run_rules, tray
from towerpilot.collector import GemCollector
from towerpilot.config import DEFAULT_CONFIG


def _battle_frame() -> np.ndarray:
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    cv2.rectangle(frame, (x + 2, y + 2), (x + w - 3, y + h - 3), (250, 250, 250), 2)
    for by in (22, 43, 64):
        cv2.rectangle(frame, (x + 20, y + by), (x + w - 20, y + by + 7), (250, 250, 250), -1)
    # Bright pixels in wave ROI so read_wave_ocr does not short-circuit
    wx, wy, ww, wh = detectors.REF_WAVE_BOX
    cv2.rectangle(frame, (wx + 5, wy + 5), (wx + ww - 5, wy + wh - 5), (255, 255, 255), -1)
    return frame


def _stats_frame() -> np.ndarray:
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    # Bright regions inside upper & coins ROIs so read_end_stats invokes ocr_fn
    ux, uy, uw, uh = detectors.REF_STATS_UPPER
    cx, cy, cw, ch = detectors.REF_STATS_COINS
    cv2.rectangle(frame, (ux + 20, uy + 20), (ux + 200, uy + 80), (240, 240, 240), -1)
    cv2.rectangle(frame, (cx + 20, cy + 20), (cx + 200, cy + 80), (240, 240, 240), -1)
    return frame


class FakeFrames:
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

    def close(self) -> None:
        pass


def test_parse_and_format_coins_case_sensitive_suffixes():
    assert run_rules.parse_coins("17.75T") == 17.75e12
    assert run_rules.parse_coins("4.20q") == 4.20e15
    assert run_rules.parse_coins("4.20Q") == 4.20e18
    assert run_rules.parse_coins("1.5s") == 1.5e21
    assert run_rules.parse_coins("1.5S") == 1.5e24
    assert run_rules.parse_coins("950") == 950.0
    assert run_rules.parse_coins("bad") is None

    assert run_rules.format_coins(17.75e12) == "17.75T"
    assert run_rules.format_coins(4.2e15) == "4.20q"
    assert run_rules.format_coins(4.2e18) == "4.20Q"
    assert run_rules.format_coins(1.5e21) == "1.50s"
    assert run_rules.format_coins(1.5e24) == "1.50S"


def test_parse_end_stats_real_ocr_fixture_and_sum_check():
    upper = "GAME STATS Wave 8996 Tier 9 Highest Wave: 9020 Killed By Scatter Death defied O times"
    coins = "coins earned ad coins earned total coins 11.84T @ + 5.90T @ = 17.75T @"

    parsed = run_rules.parse_end_stats(upper, coins)
    assert parsed["wave"] == 8996
    assert parsed["tier"] == 9
    assert parsed["highest_wave"] == 9020
    assert parsed["killed_by"] == "Scatter"
    assert parsed["coins_raw"] == "11.84T"
    assert parsed["ad_coins_raw"] == "5.90T"
    assert parsed["total_coins_raw"] == "17.75T"
    assert parsed["coins_verified"] is True

    # Recovers OCR split decimal like "5.9 OT"
    split_coins = "coins earned ad coins earned total coins 11.84T @ + 5.9 OT @ = 17.75T@"
    parsed_split = run_rules.parse_end_stats(upper, split_coins)
    assert parsed_split["ad_coins_raw"] == "5.90T"
    assert parsed_split["coins_verified"] is True

    # Mismatched OCR sum flags coins_verified=False while preserving raw total
    bad_coins = "11.84T + 5.90T = 99.00T"
    parsed_bad = run_rules.parse_end_stats(upper, bad_coins)
    assert parsed_bad["total_coins_raw"] == "99.00T"
    assert parsed_bad["coins_verified"] is False


def test_decide_home_action_conditions_and_midnight_wrap():
    rules = copy.deepcopy(DEFAULT_CONFIG["run_rules"])
    noon = datetime(2026, 11, 26, 12, 0)
    assert run_rules.decide_home_action(noon, runs_restarted=0, rules=rules) == ("battle", "ok")

    # Finish & stop
    rules["finish_and_stop"] = True
    assert run_rules.decide_home_action(noon, runs_restarted=0, rules=rules) == ("hold", "finish_and_stop")
    rules["finish_and_stop"] = False

    # Max runs
    rules["max_runs"] = 3
    assert run_rules.decide_home_action(noon, runs_restarted=2, rules=rules) == ("battle", "ok")
    assert run_rules.decide_home_action(noon, runs_restarted=3, rules=rules) == ("hold", "max_runs")
    rules["max_runs"] = 0

    # Quiet window wrapping midnight (23:00 -> 07:00)
    rules["no_start_enabled"] = True
    rules["no_start_from"] = "23:00"
    rules["no_start_until"] = "07:00"
    assert run_rules.decide_home_action(datetime(2026, 11, 26, 23, 30), runs_restarted=0, rules=rules) == (
        "hold",
        "no_start_window",
    )
    assert run_rules.decide_home_action(datetime(2026, 11, 27, 6, 59), runs_restarted=0, rules=rules) == (
        "hold",
        "no_start_window",
    )
    assert run_rules.decide_home_action(datetime(2026, 11, 27, 7, 0), runs_restarted=0, rules=rules) == (
        "battle",
        "ok",
    )


def test_passive_run_ledger_logs_once_computes_cph_and_notifies(tmp_path: Path, monkeypatch):
    log_file = tmp_path / "events.jsonl"
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"]["auto_home"] = False
    cfg["run_flow"]["auto_battle"] = False
    cfg["run_rules"]["profile_name"] = "T9 eHP"
    cfg["run_rules"]["notify_on_death"] = True

    frames = FakeFrames(_battle_frame())
    home_hit = detectors.ButtonHit(rect=(549, 1663, 449, 148), center=(773, 1737), label="HOME", screen="game_stats")
    toasts: list[tuple[str, str]] = []
    taps: list[str] = []

    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: taps.append(cmd) or b"")
    monkeypatch.setattr(detectors, "detect_end_stats_home", lambda frame: home_hit)
    monkeypatch.setattr(
        detectors,
        "read_end_stats",
        lambda frame: run_rules.parse_end_stats(
            "GAME STATS Wave 8996 Tier 9 Highest Wave: 9020 Killed By Scatter",
            "11.84T + 5.90T = 17.75T",
        ),
    )

    collector = GemCollector(frames, cfg, event_log_path=log_file, on_notify=lambda m, t: toasts.append((m, t)))
    # Simulate a full run that started 3h12m ago
    collector._run_started_at = time.time() - (3 * 3600 + 12 * 60)
    collector._run_start_exact = True
    frames.frame = _stats_frame()

    # Pass 1: passively logs run_ended without tapping anything
    collector.step_once()
    # Pass 2: repeated frame does NOT log duplicate run_ended
    collector.flow_last_scan = 0.0
    collector.step_once()

    assert taps == []
    assert collector.runs_logged == 1
    assert len(toasts) == 1
    assert "T9 W8996" in toasts[0][0]
    assert "17.75T" in toasts[0][0]
    assert "killed by Scatter" in toasts[0][0]

    ledger = collector.runs_ledger()
    assert len(ledger["runs"]) == 1
    run = ledger["runs"][0]
    assert run["tier"] == 9
    assert run["wave"] == 8996
    assert run["profile"] == "T9 eHP"
    assert run["coins_per_hour"] is not None and 5.4e12 < run["coins_per_hour"] < 5.7e12
    assert len(ledger["by_tier"]) == 1
    assert ledger["by_tier"][0]["tier"] == 9
    assert ledger["by_tier"][0]["coins_per_hour_fmt"].endswith("T")

    # Reloaded from JSONL on a fresh collector instance
    reloaded = GemCollector(frames, cfg, event_log_path=log_file)
    assert reloaded.runs_logged == 1
    assert reloaded.runs_ledger()["runs"][0]["wave"] == 8996


def test_mid_run_attach_does_not_inflate_coins_per_hour(tmp_path: Path, monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    frames = FakeFrames(_battle_frame())
    home_hit = detectors.ButtonHit(rect=(549, 1663, 449, 148), center=(773, 1737), label="HOME", screen="game_stats")
    monkeypatch.setattr(detectors, "detect_end_stats_home", lambda frame: home_hit)
    monkeypatch.setattr(
        detectors,
        "read_end_stats",
        lambda frame: run_rules.parse_end_stats(
            "GAME STATS Wave 5300 Tier 9 Highest Wave: 9020 Killed By Ray",
            "10.00T + 5.00T = 15.00T",
        ),
    )

    collector = GemCollector(frames, cfg, event_log_path=tmp_path / "events.jsonl")
    # First observation is ALREADY in battle (mid-run attach) -> duration_exact is False
    collector.step_once()
    assert collector._run_start_exact is False

    # 10 minutes later the run ends -> logged, but coins_per_hour is NOT inflated
    collector._run_started_at = time.time() - 600.0
    frames.frame = _stats_frame()
    collector.step_once()

    ledger = collector.runs_ledger()
    assert len(ledger["runs"]) == 1
    assert ledger["runs"][0]["duration_exact"] is False
    assert ledger["runs"][0]["coins_per_hour"] is None
    assert ledger["by_tier"][0]["coins_per_hour"] is None


def test_finish_and_stop_still_exits_stats_then_holds_on_home(tmp_path: Path, monkeypatch):
    log_file = tmp_path / "events.jsonl"
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"]["auto_home"] = True
    cfg["run_flow"]["auto_battle"] = True
    cfg["run_rules"]["finish_and_stop"] = True

    frames = FakeFrames(np.zeros((2560, 1080, 3), dtype=np.uint8))
    home_hit = detectors.ButtonHit(rect=(549, 1663, 449, 148), center=(773, 1737), label="HOME", screen="game_stats")
    battle_hit = detectors.ButtonHit(rect=(300, 1970, 510, 160), center=(555, 2050), label="BATTLE", screen="home", tier=9)

    screen = {"cur": "stats"}
    monkeypatch.setattr(detectors, "detect_end_stats_home", lambda f: home_hit if screen["cur"] == "stats" else None)
    monkeypatch.setattr(detectors, "detect_home_battle", lambda f: battle_hit if screen["cur"] == "home" else None)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    tapped: list[str] = []
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(
        frames,
        cfg,
        flow_delay_sec=(0.0, 0.0),
        max_taps_per_sec=100.0,
        event_log_path=log_file,
    )
    # 1) GAME STATS -> HOME still fires even with finish_and_stop armed
    collector.step_once()
    assert len(tapped) == 1
    assert collector.flow_status == "tapped HOME"

    # 2) On Home -> holds instead of tapping BATTLE
    screen["cur"] = "home"
    collector.flow_cooldown_until = 0.0
    collector.flow_last_scan = 0.0
    collector.step_once()
    assert len(tapped) == 1
    assert collector.runs_restarted == 0
    assert collector.flow_hold_reason == "finish_and_stop"
    assert "finish & stop" in collector.flow_status


def test_freeze_detection_alerts_once_and_clears_on_wave_advance(tmp_path: Path, monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["ad_gems"]["enabled"] = False
    cfg["floating_gems"]["enabled"] = False
    cfg["run_rules"]["freeze_timeout_min"] = 5

    frames = FakeFrames(_battle_frame())
    wave_state = {"val": 420}
    monkeypatch.setattr(detectors, "read_wave_ocr", lambda frame: wave_state["val"])
    toasts: list[str] = []

    collector = GemCollector(
        frames,
        cfg,
        wave_scan_interval_sec=0.0,
        event_log_path=tmp_path / "events.jsonl",
        on_notify=lambda m, t: toasts.append(m),
    )
    collector.step_once()
    assert collector.current_wave == 420
    assert collector.frozen is False

    # Simulate wave unchanged for > 5 minutes
    collector._wave_changed_at = time.monotonic() - 310.0
    collector.step_once()
    assert collector.frozen is True
    assert len(toasts) == 1
    assert "420" in toasts[0]

    # Repeated frozen ticks do not spam notifications
    collector.step_once()
    assert len(toasts) == 1

    # Wave advances -> clears frozen flag
    wave_state["val"] = 421
    collector.step_once()
    assert collector.frozen is False
    assert collector.current_wave == 421


def test_tray_suppresses_stall_toast_when_intentionally_holding(monkeypatch):
    import sys
    import types

    class FakeMenuItem:
        def __init__(self, text, action, **kw):
            self.text, self.action = text, action

    class FakeMenu:
        SEPARATOR = object()

        def __init__(self, *items):
            self.items = list(items)

    class FakeIcon:
        def __init__(self, name, icon, title, menu):
            self.stopped = 0

        def stop(self):
            self.stopped += 1

        def run(self):
            pass

    mod = types.ModuleType("pystray")
    mod.MenuItem = FakeMenuItem  # type: ignore[attr-defined]
    mod.Menu = FakeMenu  # type: ignore[attr-defined]
    mod.Icon = FakeIcon  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pystray", mod)

    notified: list[tuple[str, str]] = []

    class HoldCollector:
        running = True
        battle_live = False
        flow_hold_reason = "finish_and_stop"

        def set_notifier(self, fn):
            pass

        def stop(self):
            self.running = False

    class FakeApp:
        extensions = {
            "towerpilot": {
                "collector": HoldCollector(),
                "shutdown": lambda: None,
            }
        }

    monkeypatch.setattr(tray, "STALL_CHECK_SEC", 0.01)
    monkeypatch.setattr(tray, "STALL_NOTIFY_SEC", 0.02)
    orig_build = tray.build_icon

    def fake_build(*args: Any, **kwargs: Any):
        icon = orig_build(*args, **kwargs)
        icon.notify = lambda msg, title="": notified.append((msg, title))
        done = threading.Event()
        icon.run = lambda: done.wait(timeout=0.08)
        icon.stop = lambda: done.set()
        return icon

    monkeypatch.setattr(tray, "build_icon", fake_build)
    assert tray.run_tray(FakeApp(), port=8620, stopped=threading.Event()) == 0
    assert notified == []


def test_api_run_rules_and_runs_endpoints(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    frames = FakeFrames(_battle_frame())
    app = create_app(config_path=cfg_path, frame_source=frames)
    client = app.test_client()
    try:
        # GET /api/runs starts empty
        r0 = client.get("/api/runs")
        assert r0.status_code == 200
        assert r0.get_json() == {"runs": [], "by_tier": []}

        # Update run rules and run_flow via POST /api/run-rules
        upd = client.post(
            "/api/run-rules",
            json={
                "profile_name": "Overnight T9",
                "finish_and_stop": True,
                "max_runs": 4,
                "no_start_enabled": True,
                "no_start_from": "22:30",
                "no_start_until": "06:30",
                "freeze_timeout_min": 15,
                "notify_on_death": False,
                "run_flow": {"auto_home": True, "auto_battle": True},
            },
        )
        assert upd.status_code == 200
        st = upd.get_json()
        assert st["run_rules"] == {
            "profile_name": "Overnight T9",
            "finish_and_stop": True,
            "max_runs": 4,
            "no_start_enabled": True,
            "no_start_from": "22:30",
            "no_start_until": "06:30",
            "freeze_timeout_min": 15,
            "notify_on_death": False,
        }
        assert st["run_flow"]["auto_home"] is True
        assert st["run_flow"]["auto_battle"] is True

        saved = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        assert saved["run_rules"]["profile_name"] == "Overnight T9"
        assert saved["run_rules"]["max_runs"] == 4

        # Reset run counter action
        collector = app.extensions["towerpilot"]["collector"]
        collector.runs_restarted = 3
        rst = client.post("/api/run-rules", json={"action": "reset_run_count"})
        assert rst.status_code == 200
        assert rst.get_json()["run_flow"]["runs_restarted"] == 0

        # Invalid values rejected with 400
        for bad in (
            {"max_runs": -1},
            {"no_start_from": "25:00"},
            {"freeze_timeout_min": 500},
            {"profile_name": "x" * 41},
            {"action": "nope"},
            {"unknown_key": 1},
        ):
            res = client.post("/api/run-rules", json=bad)
            assert res.status_code == 400
    finally:
        app.extensions["towerpilot"]["shutdown"]()


def test_detect_home_battle_extracts_tier_and_end_stats_preserves_retry_rect():
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    hit = detectors.detect_home_battle(
        frame,
        ocr_fn=lambda crops: ["BATTLE", "DIFFICULTY Tier 11", "BATTLE"],
    )
    assert hit is not None
    assert hit.tier == 11

    # Draw two green buttons in STATS button band for RETRY and HOME
    cv2.rectangle(frame, (80, 1660), (500, 1810), (40, 220, 40), -1)
    cv2.rectangle(frame, (560, 1660), (980, 1810), (40, 220, 40), -1)
    stats_hit = detectors.detect_end_stats_home(
        frame,
        ocr_fn=lambda crops: ["GAME STATS", "RETRY", "HOME"],
    )
    assert stats_hit is not None
    assert stats_hit.label == "HOME"
    assert stats_hit.retry_rect is not None
