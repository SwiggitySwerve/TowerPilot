"""Unified modular profiles, atomic ProfileStore, and pure boundary scheduler.

Pure Python — zero cv2, ADB, or OCR dependencies.
"""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from towerpilot.run_rules import in_time_window, valid_hhmm

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROFILES_PATH = ROOT / "data" / "profiles.json"

SCHEMA_VERSION = 1
VALID_KINDS: tuple[str, ...] = ("farm", "push", "tournament")
DEFAULT_PRIORITIES: dict[str, int] = {"farm": 10, "push": 20, "tournament": 30}
VALID_TIER_MODES: tuple[str, ...] = ("current", "fixed", "highest_unlocked", "ignore")
VALID_CARD_PRESETS: tuple[str, ...] = tuple(f"Preset {i}" for i in range(1, 6))
VALID_MODULE_PRESETS: tuple[str, ...] = ("Preset 1", "Preset 2")

_ID_RE = re.compile(r"^[a-z0-9_-]{1,32}$")


def _require_bool(val: Any, name: str) -> bool:
    if not isinstance(val, bool):
        raise ValueError(f"{name} must be a boolean")
    return val


def _require_int(val: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(val, bool) or not isinstance(val, int) or not (lo <= val <= hi):
        raise ValueError(f"{name} must be an integer between {lo} and {hi}")
    return val


def _validate_window(raw: Any, name: str, *, allow_none: bool) -> dict[str, Any] | None:
    if raw is None:
        return None if allow_none else {"enabled": False, "from": "23:00", "until": "07:00"}
    if not isinstance(raw, dict):
        raise ValueError(f"{name} must be a mapping")
    enabled = _require_bool(raw.get("enabled", False), f"{name}.enabled")
    start, end = raw.get("from", "23:00"), raw.get("until", "07:00")
    if not isinstance(start, str) or not valid_hhmm(start):
        raise ValueError(f"{name}.from must be HH:MM (00:00-23:59)")
    if not isinstance(end, str) or not valid_hhmm(end):
        raise ValueError(f"{name}.until must be HH:MM (00:00-23:59)")
    return {"enabled": enabled, "from": start.strip(), "until": end.strip()}


def _default_runtime() -> dict[str, Any]:
    return {
        "runs_completed": 0,
        "last_completed_at": None,
        "baseline_highest_wave": None,
        "last_tourney_cycle": None,
    }


def validate_profile(raw: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize a profile dict; raise ValueError on invalid input."""
    if not isinstance(raw, dict):
        raise ValueError("profile must be a mapping")

    pid = raw.get("id")
    if not isinstance(pid, str) or not _ID_RE.match(pid.strip()):
        raise ValueError("id must be a lowercase slug matching [a-z0-9_-]{1,32}")
    pid = pid.strip()

    name_raw = raw.get("name")
    if not isinstance(name_raw, str) or not (1 <= len(name_raw.strip()) <= 40):
        raise ValueError("name must be a 1..40 character string")
    name = name_raw.strip()

    kind = raw.get("kind", "farm")
    if not isinstance(kind, str) or kind not in VALID_KINDS:
        raise ValueError(f"kind must be one of {VALID_KINDS}")

    enabled = _require_bool(raw.get("enabled", True), "enabled")
    priority = _require_int(raw.get("priority", DEFAULT_PRIORITIES[kind]), "priority", 1, 100)

    tier_def = {"mode": "ignore" if kind == "tournament" else "current", "value": 0}
    tier_raw = tier_def if raw.get("tier") is None else raw.get("tier")
    if not isinstance(tier_raw, dict):
        raise ValueError("tier must be a mapping")
    tier_mode = tier_raw.get("mode", tier_def["mode"])
    if not isinstance(tier_mode, str) or tier_mode not in VALID_TIER_MODES:
        raise ValueError(f"tier.mode must be one of {VALID_TIER_MODES}")
    tv = tier_raw.get("value", 0)
    if tier_mode == "fixed":
        tier_value = _require_int(tv, "tier.value", 1, 24)
    else:
        if tv is not None:
            _require_int(tv, "tier.value", 0, 24)
        tier_value = 0

    presets_raw = {} if raw.get("presets") is None else raw.get("presets")
    if not isinstance(presets_raw, dict):
        raise ValueError("presets must be a mapping")
    cards_raw, mods_raw = presets_raw.get("cards"), presets_raw.get("modules")
    if cards_raw in (None, ""):
        cards_preset = None
    elif isinstance(cards_raw, str) and cards_raw in VALID_CARD_PRESETS:
        cards_preset = cards_raw
    else:
        raise ValueError(f"presets.cards must be None or one of {VALID_CARD_PRESETS}")

    if mods_raw in (None, ""):
        modules_preset = None
    elif isinstance(mods_raw, str) and mods_raw in VALID_MODULE_PRESETS:
        modules_preset = mods_raw
    else:
        raise ValueError(f"presets.modules must be None or one of {VALID_MODULE_PRESETS}")

    max_runs = _require_int(raw.get("max_runs", 0), "max_runs", 0, 9999)
    window = _validate_window(raw.get("window"), "window", allow_none=True)
    quiet_window = _validate_window(raw.get("quiet_window"), "quiet_window", allow_none=False)

    then_raw = raw.get("then")
    if then_raw in (None, ""):
        then_id = None
    elif isinstance(then_raw, str) and _ID_RE.match(then_raw.strip()):
        then_id = then_raw.strip()
        if then_id == pid:
            raise ValueError("then cannot reference the profile itself")
    else:
        raise ValueError("then must be None or a valid profile id slug")

    rt_raw = {} if raw.get("runtime") is None else raw.get("runtime")
    if not isinstance(rt_raw, dict):
        raise ValueError("runtime must be a mapping")
    runs_completed = _require_int(rt_raw.get("runs_completed", 0), "runtime.runs_completed", 0, 10_000_000)
    last_completed = rt_raw.get("last_completed_at")
    if last_completed is not None and (isinstance(last_completed, bool) or not isinstance(last_completed, (str, int, float))):
        raise ValueError("runtime.last_completed_at must be None, str, or timestamp")
    base_raw = rt_raw.get("baseline_highest_wave")
    baseline = None if base_raw is None else _require_int(base_raw, "runtime.baseline_highest_wave", 0, 10_000_000)
    cycle_raw = rt_raw.get("last_tourney_cycle")
    if cycle_raw in (None, ""):
        last_cycle = None
    elif isinstance(cycle_raw, str):
        last_cycle = cycle_raw.strip() or None
    else:
        raise ValueError("runtime.last_tourney_cycle must be None or a string")

    return {
        "id": pid,
        "name": name,
        "kind": kind,
        "enabled": enabled,
        "priority": priority,
        "tier": {"mode": tier_mode, "value": tier_value},
        "presets": {"cards": cards_preset, "modules": modules_preset},
        "max_runs": max_runs,
        "window": window,
        "quiet_window": quiet_window,
        "then": then_id,
        "runtime": {
            "runs_completed": runs_completed,
            "last_completed_at": last_completed,
            "baseline_highest_wave": baseline,
            "last_tourney_cycle": last_cycle,
        },
    }


def presets_match(
    profile: dict[str, Any],
    verified_cards_preset: str | None,
    verified_modules_preset: str | None,
) -> bool:
    """True when all preset requirements on `profile` match verified screen state."""
    presets = profile.get("presets") or {}
    c, m = presets.get("cards"), presets.get("modules")
    return (c is None or verified_cards_preset == c) and (m is None or verified_modules_preset == m)


def tier_matches(profile: dict[str, Any], current_tier: int | None, *, ceiling_reached: bool = False) -> bool:
    """True when `current_tier` / `ceiling_reached` satisfies `profile['tier']`."""
    tier_cfg = profile.get("tier") or {}
    mode = tier_cfg.get("mode", "current")
    if mode in ("current", "ignore"):
        return True
    if mode == "fixed":
        return current_tier == tier_cfg.get("value")
    return mode == "highest_unlocked" and bool(ceiling_reached)


def _block_reason(
    profile: dict[str, Any],
    now_local: datetime,
    *,
    tournament_open: bool,
    tourney_cycle: str,
) -> str | None:
    max_runs = int(profile.get("max_runs", 0) or 0)
    if max_runs > 0 and int((profile.get("runtime") or {}).get("runs_completed", 0) or 0) >= max_runs:
        return "max_runs"
    qw = profile.get("quiet_window") or {}
    if qw.get("enabled") and in_time_window(now_local, str(qw.get("from", "")), str(qw.get("until", ""))):
        return "no_start_window"
    win = profile.get("window")
    if isinstance(win, dict) and win.get("enabled"):
        if not in_time_window(now_local, str(win.get("from", "")), str(win.get("until", ""))):
            return "outside_window"
    if profile.get("kind") == "tournament":
        if not tournament_open:
            return "tournament_closed"
        if (profile.get("runtime") or {}).get("last_tourney_cycle") == tourney_cycle:
            return "tournament_completed"
    return None


def pick_active(
    now_local: datetime,
    store_state: dict[str, Any],
    *,
    tournament_open: bool = False,
    global_finish_and_stop: bool = False,
    tourney_cycle: str | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Choose next profile at a run boundary, returning (profile, hold_reason).

    Precedence: finish_and_stop > queued_id > highest-priority eligible enabled
    profile > active profile's `then` fallback (on max_runs) or hold reason.
    """
    profiles = list(store_state.get("profiles") or [])
    by_id = {p["id"]: p for p in profiles if isinstance(p, dict) and "id" in p}
    active = by_id.get(store_state.get("active_id"))
    cycle = tourney_cycle if tourney_cycle is not None else now_local.strftime("%Y-%m-%d")

    if global_finish_and_stop:
        return (copy.deepcopy(active), "finish_and_stop")
    if not by_id:
        return (None, "no_profiles")

    queued = by_id.get(store_state.get("queued_id"))
    if queued is not None:
        q_reason = _block_reason(queued, now_local, tournament_open=tournament_open, tourney_cycle=cycle)
        if q_reason in ("no_start_window", "max_runs", "tournament_closed", "tournament_completed"):
            return (copy.deepcopy(queued), q_reason)
        return (copy.deepcopy(queued), None)

    active_id = active["id"] if active is not None else None
    eligible = [
        (-int(p.get("priority", 10)), 0 if p["id"] == active_id else 1, idx, p)
        for idx, p in enumerate(profiles)
        if p.get("enabled") and _block_reason(p, now_local, tournament_open=tournament_open, tourney_cycle=cycle) is None
    ]
    if eligible:
        eligible.sort(key=lambda item: (item[0], item[1], item[2]))
        return (copy.deepcopy(eligible[0][3]), None)

    if active is not None:
        a_reason = _block_reason(active, now_local, tournament_open=tournament_open, tourney_cycle=cycle)
        if a_reason == "max_runs":
            visited = {active["id"]}
            nxt_id = active.get("then")
            while nxt_id and nxt_id not in visited and nxt_id in by_id:
                visited.add(nxt_id)
                cand = by_id[nxt_id]
                c_reason = _block_reason(cand, now_local, tournament_open=tournament_open, tourney_cycle=cycle)
                if c_reason is None:
                    return (copy.deepcopy(cand), None)
                if c_reason == "max_runs" and cand.get("then"):
                    nxt_id = cand.get("then")
                    continue
                return (copy.deepcopy(cand), c_reason)
        return (copy.deepcopy(active), a_reason or "disabled")

    return (None, "no_eligible_profile")


def should_direct_retry(
    current_profile: dict[str, Any] | None,
    next_profile: dict[str, Any] | None,
    *,
    hold_reason: str | None,
    presets_verified: bool,
    tier_verified: bool,
) -> bool:
    """True ONLY when GAME STATS -> RETRY is safe without visiting HOME first."""
    return (
        hold_reason is None
        and current_profile is not None
        and next_profile is not None
        and next_profile.get("id") == current_profile.get("id")
        and next_profile.get("kind") != "tournament"
        and bool(presets_verified)
        and bool(tier_verified)
    )


def next_goal(
    profile: dict[str, Any] | None,
    *,
    verified_cards_preset: str | None,
    verified_modules_preset: str | None,
    current_tier: int | None,
    ceiling_reached: bool = False,
    hold_reason: str | None = None,
) -> dict[str, Any]:
    """Return the next concrete navigation goal for `profile`."""
    if hold_reason is not None:
        return {"action": "hold", "reason": hold_reason}
    if profile is None:
        return {"action": "hold", "reason": "no_profile"}

    presets = profile.get("presets") or {}
    if presets.get("cards") is not None and verified_cards_preset != presets["cards"]:
        return {"action": "select_card_preset", "target_screen": "cards", "preset": presets["cards"]}
    if presets.get("modules") is not None and verified_modules_preset != presets["modules"]:
        return {"action": "select_module_preset", "target_screen": "modules", "preset": presets["modules"]}
    if profile.get("kind") == "tournament":
        return {"action": "enter_tournament", "target_screen": "home"}

    tier_cfg = profile.get("tier") or {}
    mode, value = tier_cfg.get("mode", "current"), int(tier_cfg.get("value", 0) or 0)
    if mode == "fixed" and value > 0 and current_tier != value:
        return {"action": "set_tier", "target_screen": "home", "mode": "fixed", "value": value}
    if mode == "highest_unlocked" and not ceiling_reached:
        return {"action": "set_tier", "target_screen": "home", "mode": "highest_unlocked", "value": 0}
    return {"action": "start_battle", "target_screen": "home"}


class ProfileStore:
    """Thread-safe atomic JSON store (`data/profiles.json`) for modular profiles."""

    def __init__(self, path: Path = DEFAULT_PROFILES_PATH) -> None:
        self._path = Path(path)
        self._lock = threading.RLock()

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"schema_version": SCHEMA_VERSION, "active_id": None, "queued_id": None, "profiles": []}

    @staticmethod
    def _find(data: dict[str, Any], profile_id: str) -> tuple[int, dict[str, Any]]:
        for idx, prof in enumerate(data["profiles"]):
            if prof["id"] == profile_id:
                return idx, prof
        raise KeyError(f"Profile {profile_id!r} not found")

    def _read_unlocked(self) -> dict[str, Any]:
        if not self._path.is_file():
            return self._empty()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return self._empty()
        if not isinstance(raw, dict) or not isinstance(raw.get("profiles"), list):
            return self._empty()
        profiles, seen = [], set()
        for item in raw["profiles"]:
            try:
                norm = validate_profile(item)
            except ValueError:
                continue
            if norm["id"] not in seen:
                seen.add(norm["id"])
                profiles.append(norm)
        active = raw.get("active_id") if raw.get("active_id") in seen else (profiles[0]["id"] if profiles else None)
        queued = raw.get("queued_id") if raw.get("queued_id") in seen else None
        return {"schema_version": SCHEMA_VERSION, "active_id": active, "queued_id": queued, "profiles": profiles}

    def _write_unlocked(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(data, ensure_ascii=False, indent=2)
        fd, tmp_name = tempfile.mkstemp(prefix=".profiles_", suffix=".tmp", dir=str(self._path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(tmp_name, self._path)
        except BaseException:
            try:
                os.remove(tmp_name)
            except OSError:
                pass
            raise

    def seed_from_config(self, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
        """Populate 3 starter profiles on first load if the store file does not yet exist."""
        with self._lock:
            if self._path.is_file():
                existing = self._read_unlocked()
                if existing["profiles"]:
                    return copy.deepcopy(existing)

            rules = (cfg or {}).get("run_rules") or {}
            farm_name = str(rules.get("profile_name") or "").strip()[:40] or "Farming"
            exp = rules.get("expected_tier", 0)
            farm_tier = (
                {"mode": "fixed", "value": exp}
                if isinstance(exp, int) and not isinstance(exp, bool) and 1 <= exp <= 24
                else {"mode": "current", "value": 0}
            )
            max_runs = rules.get("max_runs", 0)
            if isinstance(max_runs, bool) or not isinstance(max_runs, int) or not (0 <= max_runs <= 9999):
                max_runs = 0
            qw_from = str(rules.get("no_start_from") or "23:00").strip()
            qw_until = str(rules.get("no_start_until") or "07:00").strip()
            starters = [
                validate_profile({
                    "id": "farm-default", "name": farm_name, "kind": "farm", "enabled": True, "priority": 10,
                    "tier": farm_tier, "max_runs": max_runs,
                    "quiet_window": {
                        "enabled": bool(rules.get("no_start_enabled", False)),
                        "from": qw_from if valid_hhmm(qw_from) else "23:00",
                        "until": qw_until if valid_hhmm(qw_until) else "07:00",
                    },
                }),
                validate_profile({
                    "id": "tier-push", "name": "Tier Push", "kind": "push", "enabled": False, "priority": 20,
                    "tier": {"mode": "highest_unlocked", "value": 0}, "max_runs": 1, "then": "farm-default",
                }),
                validate_profile({
                    "id": "tournament", "name": "Tournament", "kind": "tournament", "enabled": False, "priority": 30,
                    "tier": {"mode": "ignore", "value": 0}, "max_runs": 1, "then": "farm-default",
                }),
            ]
            data = {"schema_version": SCHEMA_VERSION, "active_id": "farm-default", "queued_id": None, "profiles": starters}
            self._write_unlocked(data)
            return copy.deepcopy(data)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._read_unlocked())

    def get(self, profile_id: str | None) -> dict[str, Any] | None:
        if not profile_id:
            return None
        with self._lock:
            for prof in self._read_unlocked()["profiles"]:
                if prof["id"] == profile_id:
                    return copy.deepcopy(prof)
        return None

    @staticmethod
    def _generate_id(name: Any, existing_ids: set[str]) -> str:
        raw = name.strip().lower() if isinstance(name, str) else ""
        base = re.sub(r"[^a-z0-9_-]+", "-", raw).strip("-_")[:32] or "profile"
        if base not in existing_ids:
            return base
        n = 2
        while True:
            suffix = f"-{n}"
            cand = f"{base[: 32 - len(suffix)]}{suffix}"
            if cand not in existing_ids:
                return cand
            n += 1

    def upsert(self, raw: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._read_unlocked()
            candidate = dict(raw) if isinstance(raw, dict) else raw
            if isinstance(candidate, dict) and ("id" not in candidate or candidate["id"] is None):
                existing_ids = {p["id"] for p in data["profiles"]}
                candidate["id"] = self._generate_id(candidate.get("name"), existing_ids)
            raw_id = candidate.get("id").strip() if isinstance(candidate, dict) and isinstance(candidate.get("id"), str) else None
            existing_idx = next((i for i, p in enumerate(data["profiles"]) if p["id"] == raw_id), None) if raw_id else None
            if existing_idx is not None and isinstance(candidate, dict) and "runtime" not in candidate:
                candidate["runtime"] = copy.deepcopy(data["profiles"][existing_idx]["runtime"])
            normalized = validate_profile(candidate)
            if existing_idx is not None:
                data["profiles"][existing_idx] = normalized
            else:
                data["profiles"].append(normalized)
            if data["active_id"] is None:
                data["active_id"] = normalized["id"]
            self._write_unlocked(data)
            return copy.deepcopy(normalized)

    def delete(self, profile_id: str) -> dict[str, Any]:
        with self._lock:
            data = self._read_unlocked()
            idx, _ = self._find(data, profile_id)
            if len(data["profiles"]) <= 1:
                raise ValueError("Cannot delete the last remaining profile")
            data["profiles"].pop(idx)
            if data["queued_id"] == profile_id:
                data["queued_id"] = None
            for prof in data["profiles"]:
                if prof.get("then") == profile_id:
                    prof["then"] = None
            if data["active_id"] == profile_id:
                data["active_id"] = next((p["id"] for p in data["profiles"] if p.get("enabled")), data["profiles"][0]["id"])
            self._write_unlocked(data)
            return copy.deepcopy(data)

    def queue_next(self, profile_id: str | None, *, immediate: bool = False) -> dict[str, Any]:
        with self._lock:
            data = self._read_unlocked()
            if profile_id is None:
                data["queued_id"] = None
            else:
                self._find(data, profile_id)
                data["queued_id"] = profile_id
                if immediate:
                    data["active_id"] = profile_id
            self._write_unlocked(data)
            return copy.deepcopy(data)

    def activate(self, profile_id: str) -> dict[str, Any]:
        with self._lock:
            data = self._read_unlocked()
            self._find(data, profile_id)
            data["active_id"] = profile_id
            self._write_unlocked(data)
            return copy.deepcopy(data)

    def clear_queued(self, profile_id: str | None = None) -> dict[str, Any]:
        """Clear `queued_id` (if `profile_id` is None or matches current `queued_id`)."""
        with self._lock:
            data = self._read_unlocked()
            if data["queued_id"] is not None and (profile_id is None or data["queued_id"] == profile_id):
                data["queued_id"] = None
                self._write_unlocked(data)
            return copy.deepcopy(data)

    def set_baseline_wave(self, profile_id: str, highest_wave: int) -> dict[str, Any]:
        wave = _require_int(highest_wave, "highest_wave", 0, 10_000_000)
        with self._lock:
            data = self._read_unlocked()
            _, prof = self._find(data, profile_id)
            prof["runtime"]["baseline_highest_wave"] = wave
            self._write_unlocked(data)
            return copy.deepcopy(prof)

    def record_run_ended(self, profile_id: str, record: dict[str, Any]) -> dict[str, Any]:
        """Update runtime counters, detect push PBs, and queue `then` transition if finished."""
        with self._lock:
            data = self._read_unlocked()
            _, prof = self._find(data, profile_id)
            rt = prof["runtime"]
            rt["runs_completed"] = int(rt.get("runs_completed", 0)) + 1
            rt["last_completed_at"] = record.get("ended_at") or record.get("ts") or datetime.now().isoformat(timespec="seconds")

            def _opt_int(val: Any) -> int | None:
                return val if isinstance(val, int) and not isinstance(val, bool) else None

            wave, highest, rec_base = _opt_int(record.get("wave")), _opt_int(record.get("highest_wave")), _opt_int(record.get("baseline_highest_wave"))
            baseline = rt.get("baseline_highest_wave") if rt.get("baseline_highest_wave") is not None else rec_base
            new_pb = prof["kind"] == "push" and wave is not None and baseline is not None and wave > baseline
            candidates = [v for v in (baseline, wave, highest) if v is not None]
            if candidates:
                rt["baseline_highest_wave"] = max(candidates)
            if prof["kind"] == "tournament" and isinstance(record.get("tourney_cycle"), str) and record["tourney_cycle"].strip():
                rt["last_tourney_cycle"] = record["tourney_cycle"].strip()

            max_runs = int(prof.get("max_runs", 0) or 0)
            max_runs_reached = max_runs > 0 and rt["runs_completed"] >= max_runs
            goal_completed = new_pb
            if goal_completed:
                prof["enabled"] = False

            transition_to = None
            then_id = prof.get("then")
            if (max_runs_reached or goal_completed) and then_id and any(p["id"] == then_id for p in data["profiles"]):
                transition_to = then_id
                if data["queued_id"] is None:
                    data["queued_id"] = then_id

            self._write_unlocked(data)
            return {
                "profile": copy.deepcopy(prof),
                "runs_completed": rt["runs_completed"],
                "new_pb": new_pb,
                "goal_completed": goal_completed,
                "max_runs_reached": max_runs_reached,
                "transition_to": transition_to,
            }

    def reset_runtime(self, profile_id: str) -> dict[str, Any]:
        with self._lock:
            data = self._read_unlocked()
            _, prof = self._find(data, profile_id)
            prof["runtime"] = _default_runtime()
            self._write_unlocked(data)
            return copy.deepcopy(prof)
