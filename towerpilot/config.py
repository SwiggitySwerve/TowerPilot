"""Minimal YAML configuration loader/saver with safe defaults and validation."""
from __future__ import annotations

import copy
import math
import os
import tempfile
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.yaml"
LEGACY_CONFIG_PATH = ROOT / "backend" / "config.yaml"

VALID_MODES = ("ocr", "timer")
VALID_BACKENDS = ("auto", "mumu", "adb")

DEFAULT_CONFIG: dict[str, Any] = {
    "mode": "ocr",
    "ad_gems": {
        "enabled": True,
        "timer_interval_sec": 900.0,
    },
    "floating_gems": {
        "enabled": True,
        "timer_interval_sec": 300.0,
    },
    "safety": {
        "battle_only": True,
    },
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


def _require_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean")
    return value


def _require_number(value: Any, name: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    num = float(value)
    if not math.isfinite(num) or not (lo <= num <= hi):
        raise ValueError(f"{name} must be between {lo:g} and {hi:g}")
    return num


def _require_int(value: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if not (lo <= value <= hi):
        raise ValueError(f"{name} must be between {lo} and {hi}")
    return value


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
    adb_raw = raw.get("adb")
    adb_exe = adb_raw.get("exe") if isinstance(adb_raw, dict) else ""

    active = raw.get("active_instance")
    instances = raw.get("instances") if isinstance(raw.get("instances"), dict) else {}
    inst = instances.get(active) if active in instances else next(iter(instances.values()), None)
    if isinstance(inst, dict):
        if inst.get("serial"):
            seeded.setdefault("adb", {})["serial"] = str(inst["serial"])
        preview = inst.get("preview") if isinstance(inst.get("preview"), dict) else {}
        mumu = preview.get("mumu") if isinstance(preview.get("mumu"), dict) else {}
        if mumu.get("install_dir"):
            seeded.setdefault("stream", {})["mumu_install_dir"] = str(mumu["install_dir"])
        if isinstance(mumu.get("index"), int) and not isinstance(mumu.get("index"), bool):
            seeded.setdefault("stream", {})["mumu_index"] = mumu["index"]
    if adb_exe:
        seeded.setdefault("adb", {})["exe"] = str(adb_exe)

    screen = raw.get("screen") if isinstance(raw.get("screen"), dict) else {}
    if (
        isinstance(screen.get("width"), int)
        and not isinstance(screen.get("width"), bool)
        and isinstance(screen.get("height"), int)
        and not isinstance(screen.get("height"), bool)
    ):
        seeded["screen"] = {"width": screen["width"], "height": screen["height"]}
    return seeded


def _section(raw: dict[str, Any], key: str) -> dict[str, Any]:
    val = raw.get(key)
    if val is None:
        return {}
    if not isinstance(val, dict):
        raise ValueError(f"{key} must be a mapping")
    return val


def validate_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize into the minimal schema; raise ValueError on invalid fields."""
    if not isinstance(cfg, dict):
        raise ValueError("config must be a mapping")

    mode = cfg.get("mode", DEFAULT_CONFIG["mode"])
    if not isinstance(mode, str) or mode not in VALID_MODES:
        raise ValueError(f"mode must be one of {VALID_MODES}")

    ad_raw = _section(cfg, "ad_gems")
    fg_raw = _section(cfg, "floating_gems")
    safety_raw = _section(cfg, "safety")
    adb_raw = _section(cfg, "adb")
    stream_raw = _section(cfg, "stream")
    screen_raw = _section(cfg, "screen")

    backend = stream_raw.get("backend", DEFAULT_CONFIG["stream"]["backend"])
    if not isinstance(backend, str) or backend.lower() not in VALID_BACKENDS:
        raise ValueError(f"stream.backend must be one of {VALID_BACKENDS}")

    return {
        "mode": mode,
        "ad_gems": {
            "enabled": _require_bool(ad_raw.get("enabled", DEFAULT_CONFIG["ad_gems"]["enabled"]), "ad_gems.enabled"),
            "timer_interval_sec": _require_number(
                ad_raw.get("timer_interval_sec", DEFAULT_CONFIG["ad_gems"]["timer_interval_sec"]),
                "ad_gems.timer_interval_sec",
                5.0,
                86400.0,
            ),
        },
        "floating_gems": {
            "enabled": _require_bool(
                fg_raw.get("enabled", DEFAULT_CONFIG["floating_gems"]["enabled"]),
                "floating_gems.enabled",
            ),
            "timer_interval_sec": _require_number(
                fg_raw.get("timer_interval_sec", DEFAULT_CONFIG["floating_gems"]["timer_interval_sec"]),
                "floating_gems.timer_interval_sec",
                5.0,
                86400.0,
            ),
        },
        "safety": {
            "battle_only": _require_bool(
                safety_raw.get("battle_only", DEFAULT_CONFIG["safety"]["battle_only"]),
                "safety.battle_only",
            ),
        },
        "adb": {
            "serial": str(adb_raw.get("serial", DEFAULT_CONFIG["adb"]["serial"])).strip(),
            "exe": str(adb_raw.get("exe", DEFAULT_CONFIG["adb"]["exe"])).strip(),
        },
        "stream": {
            "backend": backend.lower(),
            "fps": _require_number(
                stream_raw.get("fps", DEFAULT_CONFIG["stream"]["fps"]),
                "stream.fps",
                0.5,
                30.0,
            ),
            "quality": _require_int(
                stream_raw.get("quality", DEFAULT_CONFIG["stream"]["quality"]),
                "stream.quality",
                30,
                95,
            ),
            "mumu_install_dir": str(
                stream_raw.get("mumu_install_dir", DEFAULT_CONFIG["stream"]["mumu_install_dir"])
            ).strip(),
            "mumu_index": _require_int(
                stream_raw.get("mumu_index", DEFAULT_CONFIG["stream"]["mumu_index"]),
                "stream.mumu_index",
                -1,
                1024,
            ),
        },
        "screen": {
            "width": _require_int(
                screen_raw.get("width", DEFAULT_CONFIG["screen"]["width"]),
                "screen.width",
                200,
                8192,
            ),
            "height": _require_int(
                screen_raw.get("height", DEFAULT_CONFIG["screen"]["height"]),
                "screen.height",
                200,
                8192,
            ),
        },
    }


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
