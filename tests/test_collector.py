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


def test_collector_timer_collects_both_in_live_battle_without_allow_taps_flag(monkeypatch):
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
    )
    collector.ad_next_timer_at = time.monotonic() - 1.0
    collector.fg_next_timer_at = time.monotonic() - 1.0
    collector.step_once()

    assert collector.battle_live is True
    assert collector.ad_count == 1
    assert collector.fg_count == 1
    assert len(shell_calls) == 3  # 1 ad gem + 2 orbit burst taps
    assert all(cmd.startswith("input swipe ") for cmd in shell_calls)


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

