"""Minimal YAML configuration loader/saver with safe defaults and validation."""
from __future__ import annotations

import copy
import os
import tempfile
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.yaml"
LEGACY_CONFIG_PATH = ROOT / "backend" / "config.yaml"

VALID_MODES = ("off", "detect", "timer", "both")
VALID_BACKENDS = ("auto", "mumu", "adb")

DEFAULT_CONFIG: dict[str, Any] = {
    "adb": {
        "serial": "127.0.0.1:16384",
        "exe": "",
    },
    "stream": {
        "backend": "auto",
        "fps": 10.0,
        "quality": 80,
        "mumu_install_dir": "",
        "mumu_index": -1,
    },
    "screen": {
        "width": 1080,
        "height": 2560,
    },
    "safety": {
        "allow_taps": False,
        "dry_run": False,
        "battle_only": True,
        "jitter_px": 5,
        "press_ms": [65, 130],
        "max_taps_per_sec": 3.0,
    },
    "ad_gems": {
        "mode": "both",
        "scan_interval_sec": 2.0,
        "timer_interval_sec": 900.0,
        "delay_sec": [2.0, 6.0],
        "cooldown_sec": 60.0,
        "tap_point": [120, 680],
        "search_roi": [0, 200, 320, 2200],
    },
    "floating_gems": {
        "mode": "both",
        "scan_interval_sec": 1.5,
        "timer_interval_sec": 300.0,
        "cooldown_sec": 45.0,
        "taps_per_burst": 3,
        "orbit_center": [510, 805],
        "orbit_radius": 170.0,
        "orbit_angle_deg": 135.0,
        "orbit_spread_deg": 6.0,
        "orbit_jitter": 0.03,
        "tap_detected_directly": True,
    },
}


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Return a new dict merging override recursively onto base."""
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _seed_from_legacy(legacy_path: Path) -> dict[str, Any]:
    """Extract only connection basics if an old backend/config.yaml exists locally."""
    if not legacy_path.is_file():
        return {}
    try:
        raw = yaml.safe_load(legacy_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    seeded: dict[str, Any] = {}
    adb_exe = (raw.get("adb") or {}).get("exe") if isinstance(raw.get("adb"), dict) else ""
    active = raw.get("active_instance")
    instances = raw.get("instances") if isinstance(raw.get("instances"), dict) else {}
    inst = instances.get(active) if active in instances else next(iter(instances.values()), None)
    if isinstance(inst, dict):
        if inst.get("serial"):
            seeded.setdefault("adb", {})["serial"] = str(inst["serial"])
        if isinstance(inst.get("allow_taps"), bool):
            seeded.setdefault("safety", {})["allow_taps"] = inst["allow_taps"]
        preview = inst.get("preview") if isinstance(inst.get("preview"), dict) else {}
        mumu = preview.get("mumu") if isinstance(preview.get("mumu"), dict) else {}
        if mumu.get("install_dir"):
            seeded.setdefault("stream", {})["mumu_install_dir"] = str(mumu["install_dir"])
        if isinstance(mumu.get("index"), int):
            seeded.setdefault("stream", {})["mumu_index"] = mumu["index"]
    if adb_exe:
        seeded.setdefault("adb", {})["exe"] = str(adb_exe)
    screen = raw.get("screen") if isinstance(raw.get("screen"), dict) else {}
    if isinstance(screen.get("width"), int) and isinstance(screen.get("height"), int):
        seeded["screen"] = {"width": screen["width"], "height": screen["height"]}
    return seeded


def validate_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize a merged config dict; raise ValueError on invalid fields."""
    merged = deep_merge(DEFAULT_CONFIG, cfg)

    serial = str(merged["adb"].get("serial", "")).strip()
    merged["adb"]["serial"] = serial
    merged["adb"]["exe"] = str(merged["adb"].get("exe", "")).strip()

    backend = str(merged["stream"].get("backend", "auto")).lower()
    if backend not in VALID_BACKENDS:
        raise ValueError(f"stream.backend must be one of {VALID_BACKENDS}")
    merged["stream"]["backend"] = backend

    fps = float(merged["stream"]["fps"])
    if not 0.5 <= fps <= 30.0:
        raise ValueError("stream.fps must be between 0.5 and 30")
    merged["stream"]["fps"] = fps

    quality = int(merged["stream"]["quality"])
    if not 30 <= quality <= 95:
        raise ValueError("stream.quality must be between 30 and 95")
    merged["stream"]["quality"] = quality

    mumu_idx = int(merged["stream"].get("mumu_index", -1))
    if not -1 <= mumu_idx <= 1024:
        raise ValueError("stream.mumu_index must be -1 or 0..1024")
    merged["stream"]["mumu_index"] = mumu_idx
    merged["stream"]["mumu_install_dir"] = str(merged["stream"].get("mumu_install_dir", "")).strip()

    for dim in ("width", "height"):
        val = int(merged["screen"][dim])
        if not 200 <= val <= 8192:
            raise ValueError(f"screen.{dim} must be between 200 and 8192")
        merged["screen"][dim] = val

    safety = merged["safety"]
    safety["allow_taps"] = bool(safety["allow_taps"])
    safety["dry_run"] = bool(safety["dry_run"])
    safety["battle_only"] = bool(safety["battle_only"])
    safety["jitter_px"] = max(0, min(40, int(safety["jitter_px"])))
    safety["max_taps_per_sec"] = max(0.2, min(10.0, float(safety["max_taps_per_sec"])))
    pmin, pmax = safety["press_ms"]
    pmin, pmax = max(20, int(pmin)), max(20, int(pmax))
    if pmin > pmax:
        pmin, pmax = pmax, pmin
    safety["press_ms"] = [pmin, pmax]

    ad = merged["ad_gems"]
    if ad["mode"] not in VALID_MODES:
        raise ValueError(f"ad_gems.mode must be one of {VALID_MODES}")
    ad["scan_interval_sec"] = max(0.5, min(300.0, float(ad["scan_interval_sec"])))
    ad["timer_interval_sec"] = max(10.0, min(86400.0, float(ad["timer_interval_sec"])))
    ad["cooldown_sec"] = max(1.0, min(3600.0, float(ad["cooldown_sec"])))
    dmin, dmax = float(ad["delay_sec"][0]), float(ad["delay_sec"][1])
    if dmin < 0 or dmax < 0:
        raise ValueError("ad_gems.delay_sec must be nonnegative")
    if dmin > dmax:
        dmin, dmax = dmax, dmin
    ad["delay_sec"] = [round(dmin, 2), round(dmax, 2)]
    ad["tap_point"] = [int(ad["tap_point"][0]), int(ad["tap_point"][1])]
    ad["search_roi"] = [int(v) for v in ad["search_roi"]]
    if len(ad["search_roi"]) != 4:
        raise ValueError("ad_gems.search_roi must be [x, y, w, h]")

    fg = merged["floating_gems"]
    if fg["mode"] not in VALID_MODES:
        raise ValueError(f"floating_gems.mode must be one of {VALID_MODES}")
    fg["scan_interval_sec"] = max(0.5, min(300.0, float(fg["scan_interval_sec"])))
    fg["timer_interval_sec"] = max(10.0, min(86400.0, float(fg["timer_interval_sec"])))
    fg["cooldown_sec"] = max(1.0, min(3600.0, float(fg["cooldown_sec"])))
    fg["taps_per_burst"] = max(1, min(8, int(fg["taps_per_burst"])))
    fg["orbit_center"] = [int(fg["orbit_center"][0]), int(fg["orbit_center"][1])]
    fg["orbit_radius"] = max(20.0, min(1000.0, float(fg["orbit_radius"])))
    fg["orbit_angle_deg"] = float(fg["orbit_angle_deg"]) % 360.0
    fg["orbit_spread_deg"] = max(0.0, min(45.0, float(fg["orbit_spread_deg"])))
    fg["orbit_jitter"] = max(0.0, min(0.2, float(fg["orbit_jitter"])))
    fg["tap_detected_directly"] = bool(fg["tap_detected_directly"])

    return merged


def load_config(path: Path = CONFIG_PATH, *, legacy_path: Path = LEGACY_CONFIG_PATH) -> dict[str, Any]:
    """Load config.yaml (seeding from legacy backend/config.yaml if present)."""
    if path.is_file():
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raise ValueError(f"{path} must contain a YAML mapping")
        return validate_config(raw)
    seeded = _seed_from_legacy(legacy_path)
    cfg = validate_config(seeded)
    try:
        save_config(cfg, path)
    except OSError:
        pass
    return cfg


def save_config(cfg: dict[str, Any], path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Validate and atomically save config.yaml."""
    normalized = validate_config(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(normalized, sort_keys=False, default_flow_style=False)
    fd, tmp_name = tempfile.mkstemp(prefix=".config_", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.remove(tmp_name)
        except OSError:
            pass
        raise
    return normalized
