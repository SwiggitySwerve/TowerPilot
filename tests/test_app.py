"""In-process Flask route and extension contract tests (offline, no device required)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import yaml

from app import create_app
from towerpilot import __version__, ocr


class DummyFrames:
    def __init__(self) -> None:
        self.active_backend = "mumu"
        self.last_error = None
        self.last_frame_size = (1080, 2560)
        self.input_display = None
        self.closed = False
        self._frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
        self.last_frame = self._frame

    def close(self) -> None:
        self.closed = True

    def read_frame(self, *, prefer_preview: bool = True):
        return self._frame.copy(), "mumu"

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self._frame.copy(), "mumu"

    def grab_adb(self):
        return self._frame.copy()


def test_minimal_api_contract_and_harvest_updates(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    frames = DummyFrames()
    app = create_app(config_path=cfg_path, frame_source=frames)
    client = app.test_client()

    try:
        home = client.get("/")
        assert home.status_code == 200
        assert b"Tower Pilot" in home.data
        assert b"/api/stream.mjpg" in home.data

        res = client.get("/api/status")
        assert res.status_code == 200
        status = res.get_json()
        assert set(status.keys()) == {
            "version",
            "running",
            "mode",
            "ad_gems",
            "floating_gems",
            "run_flow",
            "run_rules",
            "profile",
            "telemetry",
            "stream",
            "battle",
            "recent",
        }
        assert status["profile"]["active_id"] == "farm-default"
        assert status["telemetry"]["all_time_runs"] == 0
        assert status["run_flow"] == {
            "auto_home": False,
            "auto_battle": False,
            "auto_retry": False,
            "auto_resume": False,
            "status": "off",
            "runs_restarted": 0,
            "holding": False,
            "hold_reason": None,
            "runs_logged": 0,
        }
        assert status["version"] == __version__
        assert status["running"] is False
        assert status["mode"] == "ocr"
        assert status["ad_gems"]["enabled"] is True
        assert status["ad_gems"]["timer_interval_sec"] == 900.0
        assert status["ad_gems"]["next_timer_sec"] is None
        assert status["ad_gems"]["count"] == 0
        assert status["floating_gems"]["enabled"] is True
        assert status["floating_gems"]["timer_interval_sec"] == 300.0
        assert status["floating_gems"]["next_timer_sec"] is None
        assert status["floating_gems"]["count"] == 0
        assert status["stream"] == {"backend": "mumu", "frame_size": [1080, 2560], "error": None}
        assert status["battle"] == {
            "live": False,
            "menu_state": "obscured",
            "blocker": None,
            "wave": None,
            "tier": None,
            "elapsed_sec": None,
            "frozen": False,
        }

        # Switch to timer mode, update intervals, disable floating gems, and start harvesting
        upd = client.post(
            "/api/harvest",
            json={
                "running": True,
                "mode": "timer",
                "ad_gems": {"enabled": True, "timer_interval_sec": 600},
                "floating_gems": {"enabled": False, "timer_interval_sec": 180},
                "run_flow": {"auto_home": True, "auto_battle": True},
            },
        )
        assert upd.status_code == 200
        body = upd.get_json()
        assert body["running"] is True
        assert body["mode"] == "timer"
        assert body["ad_gems"]["enabled"] is True
        assert body["ad_gems"]["timer_interval_sec"] == 600.0
        assert isinstance(body["ad_gems"]["next_timer_sec"], (int, float))
        assert body["floating_gems"]["enabled"] is False
        assert body["floating_gems"]["timer_interval_sec"] == 180.0
        assert body["floating_gems"]["next_timer_sec"] is None
        assert body["floating_gems"]["status"] == "off"
        assert body["run_flow"]["auto_home"] is True
        assert body["run_flow"]["auto_battle"] is True

        # Persisted cleanly to config.yaml (including running state for restarts)
        saved = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        assert saved["running"] is True
        assert saved["mode"] == "timer"
        assert saved["ad_gems"] == {"enabled": True, "timer_interval_sec": 600.0}
        assert saved["floating_gems"] == {"enabled": False, "timer_interval_sec": 180.0}
        assert saved["run_flow"] == {
            "auto_home": True,
            "auto_battle": True,
            "auto_retry": False,
            "auto_resume": False,
        }

        # Stop harvesting via partial payload (persists running: false)
        stopped = client.post("/api/harvest", json={"running": False})
        assert stopped.status_code == 200
        assert stopped.get_json()["running"] is False
        assert stopped.get_json()["ad_gems"]["next_timer_sec"] is None
        assert yaml.safe_load(cfg_path.read_text(encoding="utf-8"))["running"] is False

        # Invalid inputs return 400 without mutating state
        for bad_body in (
            {"mode": "bogus"},
            {"running": "yes"},
            {"unknown": 1},
            {"ad_gems": {"enabled": 1}},
            {"ad_gems": {"timer_interval_sec": 2}},
            {"floating_gems": {"extra": True}},
            {"run_flow": {"auto_home": "yes"}},
            {"run_flow": {"bad": True}},
        ):
            bad = client.post("/api/harvest", json=bad_body)
            assert bad.status_code == 400
            assert "error" in bad.get_json()

        bad_json = client.post("/api/harvest", data="not json", content_type="application/json")
        assert bad_json.status_code == 400
    finally:
        app.extensions["towerpilot"]["shutdown"]()


def test_stream_route_and_extensions_shutdown(tmp_path: Path, monkeypatch):
    cfg_path = tmp_path / "config.yaml"
    frames = DummyFrames()
    app = create_app(config_path=cfg_path, frame_source=frames)
    ext = app.extensions["towerpilot"]

    assert set(ext.keys()) >= {"collector", "frames", "config_path", "shutdown", "update_harvest"}
    assert ext["config_path"] == cfg_path
    assert ext["frames"] is frames

    # Stream yields a valid multipart JPEG frame
    client = app.test_client()
    stream_res = client.get("/api/stream.mjpg")
    assert stream_res.status_code == 200
    assert "multipart/x-mixed-replace" in stream_res.mimetype
    first_chunk = next(stream_res.response)
    stream_res.close()
    assert b"--frame\r\n" in first_chunk
    assert b"Content-Type: image/jpeg" in first_chunk
    assert b"\xff\xd8" in first_chunk

    # Programmatic update_harvest + shutdown contract for tray.py
    ocr_closed = []
    monkeypatch.setattr(ocr, "shutdown", lambda: ocr_closed.append(True))

    st = ext["update_harvest"]({"running": True, "mode": "ocr"})
    assert st["running"] is True
    assert ext["collector"].running is True

    ext["shutdown"]()
    assert ext["collector"].running is False
    assert frames.closed is True
    assert ocr_closed == [True]

    # Idempotent second shutdown
    ext["shutdown"]()
    assert ocr_closed == [True]


def test_loopback_host_and_origin_enforcement_and_static_assets(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    app = create_app(config_path=cfg_path, frame_source=DummyFrames())
    client = app.test_client()
    try:
        # Static CSS & JS served cleanly
        home = client.get("/")
        assert home.status_code == 200
        assert b"/static/style.css" in home.data
        assert b"/static/app.js" in home.data
        assert client.get("/static/style.css").status_code == 200
        assert client.get("/static/app.js").status_code == 200

        # DNS rebinding: foreign Host rejected on GET and POST
        assert client.get("/api/status", headers={"Host": "evil.example:8620"}).status_code == 403
        assert client.post(
            "/api/harvest",
            json={"mode": "timer"},
            headers={"Host": "evil.example:8620"},
        ).status_code == 403

        # Cross-origin POST rejected via Origin or Referer
        assert client.post(
            "/api/harvest",
            json={"mode": "timer"},
            headers={"Origin": "http://evil.example"},
        ).status_code == 403
        assert client.post(
            "/api/harvest",
            json={"mode": "timer"},
            headers={"Referer": "https://evil.example/page"},
        ).status_code == 403

        # Malformed Host or Origin returns 403 (never 500)
        assert client.get("/api/status", headers={"Host": "[::1:bad"}).status_code == 403
        assert client.post(
            "/api/harvest",
            json={"mode": "timer"},
            headers={"Host": "127.0.0.1:8620", "Origin": "http://[::1:bad"},
        ).status_code == 403

        # Different loopback port rejected on POST
        assert client.post(
            "/api/harvest",
            json={"mode": "timer"},
            headers={"Host": "127.0.0.1:8620", "Origin": "http://127.0.0.1:9999"},
        ).status_code == 403

        # Exact matching loopback Origin allowed
        ok = client.post(
            "/api/harvest",
            json={"mode": "timer"},
            headers={"Host": "127.0.0.1:8620", "Origin": "http://127.0.0.1:8620"},
        )
        assert ok.status_code == 200
    finally:
        app.extensions["towerpilot"]["shutdown"]()
