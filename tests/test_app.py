"""In-process Flask route tests (offline, no device required)."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from app import create_app


class DummyFrames:
    def __init__(self) -> None:
        self.active_backend = "mumu"
        self.last_error = None
        self.last_frame_size = (1080, 2560)
        self.input_display = None
        self._frame = np.zeros((2560, 1080, 3), dtype=np.uint8)

    def reconfigure(self, cfg) -> None:
        pass

    def close(self) -> None:
        pass

    def read_frame(self, *, prefer_preview: bool = True):
        return self._frame.copy(), "mumu"

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self._frame.copy(), "mumu"

    def grab_adb(self):
        return self._frame.copy()

    def effective_fps(self) -> float:
        return 10.0


def test_dashboard_routes_and_config_update(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    app = create_app(config_path=cfg_path, frame_source=DummyFrames())
    client = app.test_client()

    home = client.get("/")
    assert home.status_code == 200
    assert b"Tower Pilot" in home.data
    assert b"/api/stream.mjpg" in home.data

    status = client.get("/api/status").get_json()
    assert status["collector"]["running"] is False
    assert status["config"]["ad_gems"]["mode"] == "both"

    updated = client.post(
        "/api/config",
        json={"ad_gems": {"mode": "timer", "timer_interval_sec": 600}, "safety": {"dry_run": True}},
    )
    assert updated.status_code == 200
    body = updated.get_json()
    assert body["ad_gems"]["mode"] == "timer"
    assert body["ad_gems"]["timer_interval_sec"] == 600.0
    assert body["safety"]["dry_run"] is True

    bad = client.post("/api/config", json={"ad_gems": {"mode": "bogus"}})
    assert bad.status_code == 400

    snap = client.get("/api/snapshot.jpg")
    assert snap.status_code == 200
    assert snap.mimetype == "image/jpeg"
    assert snap.data[:2] == b"\xff\xd8"
