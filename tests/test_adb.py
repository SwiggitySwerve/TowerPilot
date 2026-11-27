"""Unit tests for socket ADB helpers, raw screencap decoding, and minimal config loading."""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import pytest

from towerpilot import adb, capture, config


def test_parse_screens_and_logical_display():
    sf = (
        'Display 1001 (HWC display 0): port=0 pnpId=NTE displayName="mumuscreen0"\n'
        'Display 4630946492069725441 (HWC display 1): port=1 pnpId=NTE displayName="mumuscreen1"\n'
    )
    screens = adb.parse_screens(sf)
    assert screens == [
        ("1001", 0, "mumuscreen0"),
        ("4630946492069725441", 1, "mumuscreen1"),
    ]
    assert adb.secondary_display(screens) == "4630946492069725441"

    dd = (
        "  mDisplayId=2\n"
        "  mPrimaryDisplayDevice=DisplayDevice(local:4630946492069725441)\n"
    )
    assert adb.logical_display(dd, "4630946492069725441") == 2


def test_foreground_blocker_rules():
    assert adb.foreground_blocker([]) == "no_windows"
    assert adb.foreground_blocker(["com.android.launcher/Home"]) == "game_not_on_screen"
    assert adb.foreground_blocker([
        "StatusBar",
        "ScreenDecorOverlay",
        f"{adb.GAME_PKG}/com.unity3d.player.UnityPlayerActivity",
        "com.mumu.store/Ad",
    ]) is None
    assert adb.foreground_blocker([
        "com.mumu.store/PromoActivity",
        f"{adb.GAME_PKG}/com.unity3d.player.UnityPlayerActivity",
    ]) == "covered_by:com.mumu.store"


def test_decode_raw_screencap_with_warning_prefix():
    w, h = 4, 3
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, 0] = 10   # R
    rgba[:, :, 1] = 20   # G
    rgba[:, :, 2] = 30   # B
    rgba[:, :, 3] = 255  # A
    payload = b"[Warning] Multiple displays were found\n" + struct.pack("<IIII", w, h, 1, 0) + rgba.tobytes()
    bgr = capture.decode_raw_screencap(payload)
    assert bgr.shape == (h, w, 3)
    assert tuple(int(v) for v in bgr[0, 0]) == (30, 20, 10)


def test_config_roundtrip_legacy_seeding_and_validation(tmp_path: Path):
    legacy = tmp_path / "legacy.yaml"
    legacy.write_text(
        "adb:\n  exe: 'C:\\MuMu\\nx_main\\adb.exe'\n"
        "screen:\n  width: 720\n  height: 1600\n"
        "active_instance: main\n"
        "instances:\n"
        "  main:\n"
        "    serial: '127.0.0.1:16416'\n"
        "    allow_taps: true\n"
        "    preview:\n"
        "      mumu:\n"
        "        install_dir: 'C:\\MuMu'\n"
        "        index: 1\n",
        encoding="utf-8",
    )
    cfg_path = tmp_path / "config.yaml"
    loaded = config.load_config(cfg_path, legacy_path=legacy)
    assert loaded["mode"] == "ocr"
    assert loaded["ad_gems"] == {"enabled": True, "timer_interval_sec": 900.0}
    assert loaded["floating_gems"] == {"enabled": True, "timer_interval_sec": 300.0}
    assert loaded["safety"] == {"battle_only": True}
    assert loaded["adb"] == {"serial": "127.0.0.1:16416", "exe": "C:\\MuMu\\nx_main\\adb.exe"}
    assert loaded["stream"]["mumu_install_dir"] == "C:\\MuMu"
    assert loaded["stream"]["mumu_index"] == 1
    assert loaded["screen"] == {"width": 720, "height": 1600}
    assert "allow_taps" not in loaded["safety"]
    assert cfg_path.is_file()

    # Stale/bloated keys from older config.yaml are stripped cleanly on load
    cfg_path.write_text(
        "mode: timer\n"
        "safety:\n  allow_taps: false\n  dry_run: true\n  battle_only: true\n"
        "ad_gems:\n  mode: both\n  enabled: false\n  timer_interval_sec: 120\n",
        encoding="utf-8",
    )
    cleaned = config.load_config(cfg_path)
    assert cleaned["mode"] == "timer"
    assert cleaned["ad_gems"] == {"enabled": False, "timer_interval_sec": 120.0}
    assert cleaned["safety"] == {"battle_only": True}

    with pytest.raises(ValueError):
        config.validate_config({"mode": "both"})
    with pytest.raises(ValueError):
        config.validate_config({"ad_gems": {"enabled": "yes"}})
    with pytest.raises(ValueError):
        config.validate_config({"ad_gems": {"timer_interval_sec": 2}})
    with pytest.raises(ValueError):
        config.validate_config({"floating_gems": {"timer_interval_sec": True}})


def test_visible_windows_filters_by_display_id(monkeypatch):
    dump = (
        "  Window #0 Window{111 u0 com.other/Overlay}:\n"
        "    mDisplayId=0\n"
        "    isOnScreen=true\n"
        "  Window #1 Window{222 u0 com.TechTreeGames.TheTower/Activity}:\n"
        "    mDisplayId=2\n"
        "    isOnScreen=true\n"
    ).encode("utf-8")
    monkeypatch.setattr(adb, "shell", lambda *a, **kw: dump)
    assert adb.visible_windows("127.0.0.1:16384", display_id=2) == [
        "com.TechTreeGames.TheTower/Activity"
    ]
    assert adb.visible_windows("127.0.0.1:16384", display_id=0) == ["com.other/Overlay"]


def test_frame_source_refuses_unpaired_secondary_display(monkeypatch):
    cfg = config.validate_config({"adb": {"serial": "127.0.0.1:16384"}})
    monkeypatch.setattr(adb, "resolve_game_display", lambda serial: ("463094649", None))
    fs = capture.FrameSource(cfg)
    with pytest.raises(capture.CaptureError, match="logical input display"):
        _ = fs.input_display


def test_frame_source_publishes_failure_state_after_adb_error(monkeypatch):
    cfg = config.validate_config({"adb": {"serial": "127.0.0.1:16384"}, "stream": {"backend": "adb"}})
    fs = capture.FrameSource(cfg)
    ok_frame = np.zeros((10, 10, 3), dtype=np.uint8)
    monkeypatch.setattr(fs, "grab_adb", lambda: ok_frame)
    _frame, backend = fs.read_frame(prefer_preview=True)
    assert backend == "adb"
    assert fs.active_backend == "adb"
    assert fs.last_error is None

    def fail():
        raise capture.CaptureError("device offline")

    monkeypatch.setattr(fs, "grab_adb", fail)
    with pytest.raises(capture.CaptureError):
        fs.read_frame(prefer_preview=True)
    assert fs.active_backend == "none"
    assert fs.last_error == "device offline"


def test_adb_recover_starts_server_when_refused(monkeypatch):
    states = iter(["no_server", "missing", "device"])
    started = []
    monkeypatch.setattr(adb, "get_state", lambda serial, timeout=2.0: next(states))
    monkeypatch.setattr(adb, "_server_refuses", lambda timeout=3.0: True)
    monkeypatch.setattr(
        adb,
        "start_server",
        lambda adb_exe="", mumu_install_dir="": started.append((adb_exe, mumu_install_dir)) or True,
    )
    monkeypatch.setattr(adb, "reconnect", lambda serial: True)

    assert (
        adb.recover("127.0.0.1:16384", adb_exe="C:/adb.exe", mumu_install_dir="D:/MuMu", attempts=1)
        == "device"
    )
    assert started == [("C:/adb.exe", "D:/MuMu")]


def test_adb_start_server_backs_off_and_uses_custom_mumu_dir(tmp_path: Path, monkeypatch):
    adb_path = tmp_path / "nx_main" / "adb.exe"
    adb_path.parent.mkdir(parents=True)
    adb_path.write_text("", encoding="utf-8")

    monkeypatch.setattr(adb, "_start_failed_until", 0.0)
    monkeypatch.setattr(adb, "_server_refuses", lambda timeout=1.0: True)
    calls = []

    class FakeProc:
        returncode = 1

    monkeypatch.setattr(adb.subprocess, "run", lambda cmd, **kw: calls.append(cmd) or FakeProc())

    # First call attempts custom mumu_install_dir's bundled adb.exe and backs off on failure
    assert adb.start_server("", mumu_install_dir=str(tmp_path)) is False
    assert adb.start_server("", mumu_install_dir=str(tmp_path)) is False
    assert adb.start_server("", mumu_install_dir=str(tmp_path)) is False
    assert calls == [[str(adb_path), "start-server"]]


def test_frame_source_refuses_display_lookup_failure_closed(monkeypatch):
    cfg = config.validate_config({"adb": {"serial": "127.0.0.1:16384"}})
    monkeypatch.setattr(
        adb,
        "resolve_game_display",
        lambda serial: (_ for _ in ()).throw(adb.AdbError("display lookup failed")),
    )
    monkeypatch.setattr(adb, "recover", lambda *a, **kw: "missing")
    fs = capture.FrameSource(cfg)
    with pytest.raises(capture.CaptureError, match="Display lookup failed"):
        fs.grab_adb_with_display()


def test_tapper_cancels_during_rate_limit_wait(monkeypatch):
    import threading
    from towerpilot.input import TapRefused, Tapper

    cfg = {
        "screen": {"width": 1080, "height": 2560},
        "safety": {
            "allow_taps": True,
            "dry_run": False,
            "jitter_px": 0,
            "press_ms": [60, 60],
            "max_taps_per_sec": 0.5,  # 2s wait between taps
        },
    }
    shell_calls = []
    monkeypatch.setattr(adb, "shell", lambda *a, **kw: shell_calls.append(a) or b"")
    tapper = Tapper()
    tapper.tap("127.0.0.1:16384", 100, 200, cfg=cfg)
    assert len(shell_calls) == 1

    stop_ev = threading.Event()
    threading.Timer(0.05, stop_ev.set).start()
    with pytest.raises(TapRefused, match="cancelled"):
        tapper.tap("127.0.0.1:16384", 100, 200, cfg=cfg, stop_event=stop_ev)
    assert len(shell_calls) == 1


def test_tapper_refuses_on_android_input_error_output(monkeypatch):
    from towerpilot.input import TapRefused, Tapper

    cfg = {
        "screen": {"width": 1080, "height": 2560},
        "safety": {
            "allow_taps": True,
            "dry_run": False,
            "jitter_px": 0,
            "press_ms": [60, 60],
            "max_taps_per_sec": 100.0,
        },
    }
    monkeypatch.setattr(adb, "shell", lambda *a, **kw: b"Error: Invalid display id: 99\n")
    with pytest.raises(TapRefused, match="Invalid display id"):
        Tapper().tap("127.0.0.1:16384", 100, 200, cfg=cfg, input_display=99)
