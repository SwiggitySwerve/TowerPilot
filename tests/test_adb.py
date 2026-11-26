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
