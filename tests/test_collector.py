"""Unit tests for minimal GemCollector (OCR/vision vs timer, toggles, and battle safety guard)."""
from __future__ import annotations

import copy
import time

import cv2
import numpy as np

from towerpilot import adb, detectors
from towerpilot.collector import GemCollector
from towerpilot.config import DEFAULT_CONFIG
from towerpilot.input import Tapper


def _battle_frame() -> np.ndarray:
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    cv2.rectangle(frame, (x + 2, y + 2), (x + w - 3, y + h - 3), (250, 250, 250), 2)
    for by in (22, 43, 64):
        cv2.rectangle(frame, (x + 20, y + by), (x + w - 20, y + by + 7), (250, 250, 250), -1)
    return frame


class FakeFrames:
    def __init__(self, frame: np.ndarray) -> None:
        self.frame = frame
        self.last_frame = frame
        self.active_backend = "adb"
        self.last_error = None
        self.last_frame_size = (frame.shape[1], frame.shape[0])
        self.input_display = None

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self.frame.copy(), "adb"

    def grab_adb(self):
        return self.frame.copy()

    def close(self) -> None:
        pass


def test_collector_skips_when_hud_obscured(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "timer"

    blank = np.zeros((2560, 1080, 3), dtype=np.uint8)
    frames = FakeFrames(blank)
    taps = []
    monkeypatch.setattr(adb, "shell", lambda *a, **kw: taps.append(a) or b"")

    collector = GemCollector(frames, cfg, max_taps_per_sec=100.0)
    collector.ad_next_timer_at = 0.0
    collector.fg_next_timer_at = 0.0
    collector.step_once()

    assert collector.battle_live is False
    assert taps == []
    assert collector.ad_count == 0
    assert collector.fg_count == 0


def test_collector_timer_attempts_both_without_inflating_confirmed_counts(tmp_path, monkeypatch):
    import json

    log_file = tmp_path / "events.jsonl"
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "timer"
    assert "allow_taps" not in cfg["safety"]

    frames = FakeFrames(_battle_frame())
    shell_calls: list[str] = []
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: shell_calls.append(cmd) or b"")

    collector = GemCollector(
        frames,
        cfg,
        tapper=Tapper(),
        fg_taps_per_burst=2,
        max_taps_per_sec=100.0,
        event_log_path=log_file,
    )
    collector.ad_next_timer_at = time.monotonic() - 1.0
    collector.fg_next_timer_at = time.monotonic() - 1.0
    collector.step_once()

    assert collector.battle_live is True
    assert collector.ad_count == 0
    assert collector.fg_count == 0
    assert collector.ad_status == "timer tapped"
    assert collector.fg_status == "timer tapped"
    assert len(shell_calls) == 3  # 1 ad gem + 2 orbit burst taps
    assert all(cmd.startswith("input swipe ") for cmd in shell_calls)
    events = [json.loads(line)["event"] for line in log_file.read_text(encoding="utf-8").splitlines()]
    assert "ad_gem_attempted" in events
    assert "floating_gem_attempted" in events
    assert "ad_gem_collected" not in events
    assert "floating_gem_collected" not in events


def test_collector_ocr_triggers_ad_gem_and_does_not_fire_timer(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "ocr"
    cfg["floating_gems"]["enabled"] = False

    frames = FakeFrames(_battle_frame())
    hit = detectors.AdGemHit(rect=(40, 620, 180, 100), center=(130, 670), text="CLAIM 6")
    monkeypatch.setattr(detectors, "detect_ad_gem", lambda *a, **kw: hit)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    tapped: list[str] = []
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg, ad_delay_sec=(0.0, 0.0), max_taps_per_sec=100.0)
    collector.ad_next_timer_at = 0.0
    collector.step_once()

    assert collector.ad_count == 1
    assert collector.fg_count == 0
    assert len(tapped) == 1


def test_collector_ocr_triggers_floating_gem_vision(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "ocr"
    cfg["ad_gems"]["enabled"] = False

    frames = FakeFrames(_battle_frame())
    fg_hit = detectors.FloatingGemHit(rect=(350, 650, 60, 60), center=(380, 680), score=0.92)
    monkeypatch.setattr(detectors, "detect_floating_gem", lambda frame: fg_hit)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    tapped: list[str] = []
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg, max_taps_per_sec=100.0)
    collector.step_once()

    assert collector.ad_count == 0
    assert collector.fg_count == 1
    assert len(tapped) == 1


def test_collector_respects_individual_enabled_toggles(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "timer"
    cfg["ad_gems"]["enabled"] = False
    cfg["floating_gems"]["enabled"] = False

    frames = FakeFrames(_battle_frame())
    tapped: list[str] = []
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg, max_taps_per_sec=100.0)
    collector.ad_next_timer_at = 0.0
    collector.fg_next_timer_at = 0.0
    collector.step_once()

    assert tapped == []
    assert collector.ad_status == "off"
    assert collector.fg_status == "off"


def test_collector_refuses_tap_when_foreground_blocked(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "timer"
    cfg["floating_gems"]["enabled"] = False

    frames = FakeFrames(_battle_frame())
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: ["com.mumu.store/Ad", f"{adb.GAME_PKG}/Activity"])
    tapped: list[str] = []
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg, max_taps_per_sec=100.0)
    collector.ad_next_timer_at = 0.0
    collector.step_once()

    assert tapped == []
    assert collector.ad_count == 0
    assert collector.foreground_blocker == "covered_by:com.mumu.store"


def test_collector_refuses_tap_inside_ability_row(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "ocr"
    cfg["floating_gems"]["enabled"] = False

    frames = FakeFrames(_battle_frame())
    # Ability row sits around y=1495..1615 in 1080x2560
    bad_hit = detectors.AdGemHit(rect=(60, 1510, 140, 80), center=(130, 1550), text="CLAIM 5")
    monkeypatch.setattr(detectors, "detect_ad_gem", lambda *a, **kw: bad_hit)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    tapped: list[str] = []
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg, ad_delay_sec=(0.0, 0.0), max_taps_per_sec=100.0)
    collector.step_once()

    assert tapped == []
    assert collector.ad_count == 0


def test_collector_status_matches_minimal_contract():
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    frames = FakeFrames(_battle_frame())
    collector = GemCollector(frames, cfg)

    st = collector.status()
    assert set(st.keys()) == {
        "running",
        "mode",
        "ad_gems",
        "floating_gems",
        "run_flow",
        "stream",
        "battle",
        "recent",
    }
    assert st["running"] is False
    assert st["mode"] == "ocr"
    assert st["ad_gems"] == {
        "enabled": True,
        "timer_interval_sec": 900.0,
        "status": "stopped",
        "next_timer_sec": None,
        "count": 0,
    }
    assert st["floating_gems"] == {
        "enabled": True,
        "timer_interval_sec": 300.0,
        "status": "stopped",
        "next_timer_sec": None,
        "count": 0,
    }
    assert st["stream"] == {"backend": "adb", "frame_size": [1080, 2560], "error": None}
    assert st["battle"] == {"live": True, "menu_state": "closed", "blocker": None}
    assert isinstance(st["recent"], list)

    # Stale foreground_blocker clears once passive idle check sees a healthy battle HUD
    collector.foreground_blocker = "covered_by:com.mumu.store"
    st_after = collector.status()
    assert st_after["battle"] == {"live": True, "menu_state": "closed", "blocker": None}
    assert collector.foreground_blocker is None


def test_collector_persists_structured_trigger_events_to_jsonl(tmp_path, monkeypatch):
    import json

    log_file = tmp_path / "events.jsonl"
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "ocr"

    frames = FakeFrames(_battle_frame())
    ad_hit = detectors.AdGemHit(rect=(40, 620, 180, 100), center=(130, 670), text="CLAIM 6")
    fg_hit = detectors.FloatingGemHit(rect=(350, 650, 60, 60), center=(380, 680), score=0.91)
    monkeypatch.setattr(detectors, "detect_ad_gem", lambda *a, **kw: ad_hit)
    monkeypatch.setattr(detectors, "detect_floating_gem", lambda frame: fg_hit)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: b"")

    collector = GemCollector(
        frames,
        cfg,
        ad_delay_sec=(0.0, 0.0),
        max_taps_per_sec=100.0,
        event_log_path=log_file,
    )
    collector.step_once()

    # Transition to obscured HUD and verify battle_waiting is logged once
    frames.frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    collector.step_once()
    collector.step_once()

    lines = [json.loads(line) for line in log_file.read_text(encoding="utf-8").splitlines()]
    events = [row["event"] for row in lines]
    assert events == [
        "battle_live",
        "ad_gem_spotted",
        "ad_gem_collected",
        "floating_gem_spotted",
        "floating_gem_collected",
        "battle_waiting",
    ]
    ad_collected = next(row for row in lines if row["event"] == "ad_gem_collected")
    assert ad_collected["trigger"] == "ocr"
    assert ad_collected["count"] == 1
    assert "iso" in ad_collected and "ts" in ad_collected


def test_collector_auto_home_and_auto_battle_flow(tmp_path, monkeypatch):
    import json

    log_file = tmp_path / "events.jsonl"
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"]["auto_home"] = True
    cfg["run_flow"]["auto_battle"] = True

    obscured = np.zeros((2560, 1080, 3), dtype=np.uint8)
    frames = FakeFrames(obscured)
    home_hit = detectors.ButtonHit(rect=(549, 1663, 449, 148), center=(773, 1737), label="HOME", screen="game_stats")
    battle_hit = detectors.ButtonHit(rect=(300, 1970, 510, 160), center=(555, 2050), label="BATTLE", screen="home")

    state = {"screen": "stats"}
    monkeypatch.setattr(
        detectors,
        "detect_end_stats_home",
        lambda frame: home_hit if state["screen"] == "stats" else None,
    )
    monkeypatch.setattr(
        detectors,
        "detect_home_battle",
        lambda frame: battle_hit if state["screen"] == "home" else None,
    )
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
    # 1) On GAME STATS -> taps HOME
    collector.step_once()
    assert len(tapped) == 1
    assert collector.runs_restarted == 0

    # 2) Transitions to Home after cooldown -> taps BATTLE
    state["screen"] = "home"
    collector.flow_cooldown_until = 0.0
    collector.flow_last_scan = 0.0
    collector.step_once()
    assert len(tapped) == 2
    assert collector.runs_restarted == 1

    events = [json.loads(line)["event"] for line in log_file.read_text(encoding="utf-8").splitlines()]
    assert "end_stats_detected" in events
    assert "end_stats_home_tapped" in events
    assert "home_battle_detected" in events
    assert "home_battle_tapped" in events


def test_floating_gem_burst_rechecks_each_tap_and_aborts_when_covered(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "timer"
    cfg["ad_gems"]["enabled"] = False

    frames = FakeFrames(_battle_frame())
    tapped: list[str] = []
    # First tap sees game unobstructed; second tap sees an overlay covering the game
    windows_seq = iter([
        [f"{adb.GAME_PKG}/Activity"],
        ["com.mumu.store/Promo", f"{adb.GAME_PKG}/Activity"],
    ])
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: next(windows_seq))
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg, fg_taps_per_burst=3, max_taps_per_sec=100.0)
    collector.fg_next_timer_at = 0.0
    collector.step_once()

    assert len(tapped) == 1


def test_collector_stop_cancels_in_flight_tap_dispatch(monkeypatch):
    import threading

    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["mode"] = "timer"
    cfg["floating_gems"]["enabled"] = False

    entered_capture = threading.Event()
    release_capture = threading.Event()
    frame = _battle_frame()

    class BlockingFrames(FakeFrames):
        def grab_adb(self):
            entered_capture.set()
            release_capture.wait(timeout=2.0)
            return self.frame.copy()

    frames = BlockingFrames(frame)
    tapped: list[str] = []
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg, max_taps_per_sec=100.0)
    collector.start()
    collector.ad_next_timer_at = 0.0
    assert entered_capture.wait(timeout=2.0)

    stopper = threading.Thread(target=collector.stop)
    stopper.start()
    # Wait briefly for stop() to signal _stop_event before releasing grab_adb()
    deadline = time.monotonic() + 1.0
    while not collector._stop_event.is_set() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert collector._stop_event.is_set()
    release_capture.set()
    stopper.join(timeout=2.0)

    assert tapped == []


def test_run_flow_still_runs_when_battle_only_is_false(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["safety"]["battle_only"] = False
    cfg["ad_gems"]["enabled"] = False
    cfg["floating_gems"]["enabled"] = False
    cfg["run_flow"]["auto_home"] = True

    frames = FakeFrames(np.zeros((2560, 1080, 3), dtype=np.uint8))
    home_hit = detectors.ButtonHit(rect=(549, 1663, 449, 148), center=(773, 1737), label="HOME", screen="game_stats")
    monkeypatch.setattr(detectors, "detect_end_stats_home", lambda frame: home_hit)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    tapped: list[str] = []
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg, flow_delay_sec=(0.0, 0.0), max_taps_per_sec=100.0)
    collector.step_once()
    assert len(tapped) == 1

