"""Unit tests for GemCollector (OCR detection, timers, and battle safety guard)."""
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
        self.active_backend = "adb"
        self.last_error = None
        self.last_frame_size = (frame.shape[1], frame.shape[0])
        self.input_display = None

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self.frame.copy(), "adb"

    def grab_adb(self):
        return self.frame.copy()

    def effective_fps(self) -> float:
        return 4.0


def test_collector_skips_when_hud_obscured(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["safety"]["allow_taps"] = True
    cfg["ad_gems"]["mode"] = "timer"
    cfg["floating_gems"]["mode"] = "timer"

    blank = np.zeros((2560, 1080, 3), dtype=np.uint8)
    frames = FakeFrames(blank)
    taps = []
    monkeypatch.setattr(adb, "shell", lambda *a, **kw: taps.append(a) or b"")

    collector = GemCollector(frames, cfg)
    collector.ad_next_timer_at = 0.0
    collector.fg_next_timer_at = 0.0
    collector.step_once()

    assert collector.battle_live is False
    assert taps == []
    assert collector.stats["ad_gems"] == 0
    assert collector.stats["floating_gems"] == 0


def test_collector_timer_collects_both_in_live_battle(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["safety"]["allow_taps"] = True
    cfg["safety"]["max_taps_per_sec"] = 10.0
    cfg["ad_gems"]["mode"] = "timer"
    cfg["floating_gems"]["mode"] = "timer"
    cfg["floating_gems"]["taps_per_burst"] = 2

    frames = FakeFrames(_battle_frame())
    shell_calls: list[str] = []
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: shell_calls.append(cmd) or b"")
    monkeypatch.setattr(detectors, "read_wave_ocr", lambda frame: 42)

    collector = GemCollector(frames, cfg, tapper=Tapper())
    collector.ad_next_timer_at = time.monotonic() - 1.0
    collector.fg_next_timer_at = time.monotonic() - 1.0
    collector.step_once()

    assert collector.battle_live is True
    assert collector.last_wave == 42
    assert collector.stats["ad_gems"] == 1
    assert collector.stats["floating_gems"] == 1
    assert collector.stats["taps"] == 3  # 1 ad gem + 2 orbit burst taps
    assert len(shell_calls) == 3
    assert all(cmd.startswith("input swipe ") for cmd in shell_calls)


def test_collector_ocr_triggers_ad_gem_after_delay(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["safety"]["allow_taps"] = True
    cfg["ad_gems"]["mode"] = "detect"
    cfg["ad_gems"]["delay_sec"] = [0.0, 0.0]
    cfg["floating_gems"]["mode"] = "off"

    frames = FakeFrames(_battle_frame())
    hit = detectors.AdGemHit(rect=(40, 620, 180, 100), center=(130, 670), text="CLAIM 6")
    monkeypatch.setattr(detectors, "detect_ad_gem", lambda *a, **kw: hit)
    monkeypatch.setattr(detectors, "read_wave_ocr", lambda frame: None)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    tapped: list[str] = []
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg)
    collector.step_once()

    assert collector.stats["ad_gems"] == 1
    assert len(tapped) == 1
    assert cfg["ad_gems"]["tap_point"] == [130, 670]


def test_collector_refuses_tap_when_foreground_blocked(monkeypatch):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["safety"]["allow_taps"] = True
    cfg["ad_gems"]["mode"] = "timer"
    cfg["floating_gems"]["mode"] = "off"

    frames = FakeFrames(_battle_frame())
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: ["com.mumu.store/Ad", f"{adb.GAME_PKG}/Activity"])
    monkeypatch.setattr(detectors, "read_wave_ocr", lambda frame: None)
    tapped: list[str] = []
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, **kw: tapped.append(cmd) or b"")

    collector = GemCollector(frames, cfg)
    collector.ad_next_timer_at = 0.0
    collector.step_once()

    assert tapped == []
    assert collector.stats["ad_gems"] == 0
    assert collector.stats["skips"] == 1
    assert collector.foreground_blocker == "covered_by:com.mumu.store"
