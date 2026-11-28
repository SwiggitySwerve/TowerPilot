"""Context-aware routine requests: one server-side decision of where the game is and which path a goal takes.

Battle side-menu routines run only in a live battle; Cards/Modules also have a Home-screen scan path;
nothing ever leaves a live run to reach another context.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from app import create_app
from towerpilot import battle_menu, detectors, screens
from towerpilot.collector import ROUTINE_PATHS


def _battle_frame() -> np.ndarray:
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    cv2.rectangle(frame, (x + 2, y + 2), (x + w - 3, y + h - 3), (250, 250, 250), 2)
    for by in (22, 43, 64):
        cv2.rectangle(frame, (x + 20, y + by), (x + w - 20, y + by + 7), (250, 250, 250), -1)
    return frame


def _obscured_frame() -> np.ndarray:
    return np.zeros((2560, 1080, 3), dtype=np.uint8)


class Frames:
    def __init__(self, frame: np.ndarray) -> None:
        self.set_frame(frame)
        self.active_backend = "mumu"
        self.last_error = None
        self.input_display = None

    def set_frame(self, frame: np.ndarray) -> None:
        self.frame = frame
        self.last_frame = frame
        self.last_frame_size = (frame.shape[1], frame.shape[0])

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self.frame.copy(), "mumu"

    def grab_adb(self):
        return self.frame.copy()

    def read_frame(self, *, prefer_preview: bool = True):
        return self.frame.copy(), "mumu"

    def close(self) -> None:
        pass


@pytest.fixture
def ctx(tmp_path: Path):
    frames = Frames(_battle_frame())
    app = create_app(config_path=tmp_path / "config.yaml", frame_source=frames)
    collector = app.extensions["towerpilot"]["collector"]
    collector.running = True
    try:
        yield app.test_client(), collector, frames
    finally:
        collector.running = False
        app.extensions["towerpilot"]["shutdown"]()


def test_every_battle_menu_task_has_a_path_and_only_cards_modules_have_a_home_path():
    assert set(ROUTINE_PATHS) == set(battle_menu.VALID_TASKS)
    for task, paths in ROUTINE_PATHS.items():
        assert paths.get("battle") == "battle_menu"
        assert ("home" in paths) == (task in ("cards", "modules"))


@pytest.mark.parametrize("task", battle_menu.VALID_TASKS)
def test_in_battle_every_task_starts_through_the_side_menu(ctx, task):
    client, collector, _frames = ctx
    res = client.post("/api/routines", json={"action": "run", "task": task})
    assert res.status_code == 200
    body = res.get_json()
    assert body["routine"]["outcome"] == "started"
    assert body["routine"]["context"] == "battle"
    assert body["routine"]["via"] == "battle_menu"
    assert body["battle_menu"]["active"] is True and body["battle_menu"]["task"] == task


@pytest.mark.parametrize("task", ["daily_quests", "guild_rewards", "event_missions", "history"])
def test_off_battle_battle_only_tasks_are_refused_with_a_reason(ctx, task):
    client, collector, frames = ctx
    frames.set_frame(_obscured_frame())
    res = client.post("/api/routines", json={"action": "run", "task": task})
    assert res.status_code == 409
    body = res.get_json()
    assert body["routine"]["outcome"] == "refused"
    assert body["routine"]["reason"] == "battle_only"
    assert "battle" in body["error"].lower()
    assert collector.battle_menu.active is False


def test_off_battle_scan_waits_for_a_confirmed_home_screen(ctx, monkeypatch):
    """Not-a-battle is not proof of Home (popups, run-end stats): queue, never start blind."""
    client, collector, frames = ctx
    frames.set_frame(_obscured_frame())
    monkeypatch.setattr(screens, "identify", lambda f: screens.Screen(name="unknown"))
    res = client.post("/api/routines", json={"action": "run", "task": "cards"})
    assert res.status_code == 200
    body = res.get_json()
    assert body["routine"]["outcome"] == "queued"
    assert body["routine"]["via"] == "scan"
    assert body["routine"]["reason"] == "waiting_for_home"
    assert collector.scan_status()["running"] is False
    assert collector.scan_status()["queued"] is True


def test_off_battle_scan_starts_on_a_confirmed_home_screen(ctx, monkeypatch):
    client, collector, frames = ctx
    frames.set_frame(_obscured_frame())
    monkeypatch.setattr(screens, "identify", lambda f: screens.Screen(name="home"))
    res = client.post("/api/routines", json={"action": "run", "task": "modules"})
    assert res.status_code == 200
    body = res.get_json()
    assert body["routine"]["outcome"] == "started"
    assert body["routine"]["via"] == "scan"
    assert collector.scan_status()["running"] is True
    assert collector.scan_status()["scope"] == "modules"


def test_explicit_account_scan_on_an_unconfirmed_screen_queues_instead_of_starting(ctx, monkeypatch):
    """Regression: /api/account scan used to start immediately on any non-battle frame."""
    client, collector, frames = ctx
    frames.set_frame(_obscured_frame())
    monkeypatch.setattr(screens, "identify", lambda f: screens.Screen(name="unknown"))
    res = client.post("/api/account", json={"action": "scan", "scope": "all"})
    assert res.status_code == 200
    scan = res.get_json()["scan"]
    assert scan["running"] is False and scan["queued"] is True


def test_busy_requests_are_refused_with_a_distinct_reason(ctx):
    client, collector, _frames = ctx
    assert client.post("/api/routines", json={"action": "run", "task": "history"}).status_code == 200
    res = client.post("/api/routines", json={"action": "run", "task": "cards"})
    assert res.status_code == 409
    assert res.get_json()["routine"]["reason"] == "routine_active"


def test_harvesting_off_is_refused(ctx):
    client, collector, _frames = ctx
    collector.running = False
    res = client.post("/api/routines", json={"action": "run", "task": "history"})
    assert res.status_code == 409
    assert res.get_json()["routine"]["reason"] == "harvesting_off"


def test_status_availability_matches_the_context(ctx, monkeypatch):
    client, collector, frames = ctx
    avail = client.get("/api/status").get_json()["routines"]["availability"]
    assert avail["event_missions"] == {
        "context": "battle", "via": "battle_menu", "available": True, "reason": None, "message": None,
    }

    frames.set_frame(_obscured_frame())
    avail = client.get("/api/status").get_json()["routines"]["availability"]
    assert avail["event_missions"]["available"] is False
    assert avail["event_missions"]["reason"] == "battle_only"
    assert avail["cards"] == {"context": "off_battle", "via": "scan", "available": True, "reason": None, "message": None}
