"""Offline unit tests for modular profiles, ProfileStore, and pure boundary scheduler."""
from __future__ import annotations

import copy
from datetime import datetime
from pathlib import Path

import pytest

from towerpilot import profiles
from towerpilot.config import DEFAULT_CONFIG
from towerpilot.profiles import (
    ProfileStore,
    next_goal,
    pick_active,
    presets_match,
    should_direct_retry,
    tier_matches,
    validate_profile,
)


def _make_profile(pid: str, **overrides) -> dict:
    base = {
        "id": pid,
        "name": pid.replace("-", " ").title(),
        "kind": "farm",
        "enabled": True,
    }
    base.update(overrides)
    return validate_profile(base)


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def test_validate_profile_defaults_and_normalization():
    farm = validate_profile({"id": "farm-t10", "name": "  T10 Farm  ", "kind": "farm"})
    assert farm["id"] == "farm-t10"
    assert farm["name"] == "T10 Farm"
    assert farm["kind"] == "farm"
    assert farm["enabled"] is True
    assert farm["priority"] == 10
    assert farm["tier"] == {"mode": "current", "value": 0}
    assert farm["presets"] == {"cards": None, "modules": None}
    assert farm["max_runs"] == 0
    assert farm["window"] is None
    assert farm["quiet_window"] == {"enabled": False, "from": "23:00", "until": "07:00"}
    assert farm["then"] is None
    assert farm["runtime"] == {
        "runs_completed": 0,
        "last_completed_at": None,
        "baseline_highest_wave": None,
        "last_tourney_cycle": None,
    }

    push = validate_profile(
        {
            "id": "push_t14",
            "name": "Push T14",
            "kind": "push",
            "tier": {"mode": "fixed", "value": 14},
            "presets": {"cards": "Preset 4", "modules": "Preset 2"},
            "max_runs": 2,
            "window": {"enabled": True, "from": "09:00", "until": "17:00"},
            "then": "farm-t10",
        }
    )
    assert push["priority"] == 20
    assert push["tier"] == {"mode": "fixed", "value": 14}
    assert push["presets"] == {"cards": "Preset 4", "modules": "Preset 2"}
    assert push["window"] == {"enabled": True, "from": "09:00", "until": "17:00"}
    assert push["then"] == "farm-t10"

    tourney = validate_profile({"id": "tourney", "name": "Champ", "kind": "tournament"})
    assert tourney["priority"] == 30
    assert tourney["tier"] == {"mode": "ignore", "value": 0}

    # Non-fixed tier mode normalizes value to 0
    cur = validate_profile({"id": "cur", "name": "Cur", "tier": {"mode": "current", "value": 9}})
    assert cur["tier"] == {"mode": "current", "value": 0}


@pytest.mark.parametrize(
    "bad",
    [
        "not-a-dict",
        {"id": "UpperCase", "name": "Bad"},
        {"id": "has space", "name": "Bad"},
        {"id": "x" * 33, "name": "Bad"},
        {"id": "", "name": "Bad"},
        {"id": "ok", "name": "   "},
        {"id": "ok", "name": "a" * 41},
        {"id": "ok", "name": "Ok", "kind": "unknown"},
        {"id": "ok", "name": "Ok", "enabled": "yes"},
        {"id": "ok", "name": "Ok", "priority": 0},
        {"id": "ok", "name": "Ok", "priority": 101},
        {"id": "ok", "name": "Ok", "priority": True},
        {"id": "ok", "name": "Ok", "tier": {"mode": "bogus", "value": 0}},
        {"id": "ok", "name": "Ok", "tier": {"mode": "fixed", "value": 0}},
        {"id": "ok", "name": "Ok", "tier": {"mode": "fixed", "value": 25}},
        {"id": "ok", "name": "Ok", "tier": {"mode": "fixed", "value": True}},
        {"id": "ok", "name": "Ok", "presets": {"cards": "Preset 6"}},
        {"id": "ok", "name": "Ok", "presets": {"cards": "Preset 0"}},
        {"id": "ok", "name": "Ok", "presets": {"modules": "Preset 3"}},
        {"id": "ok", "name": "Ok", "presets": {"modules": 1}},
        {"id": "ok", "name": "Ok", "max_runs": -1},
        {"id": "ok", "name": "Ok", "max_runs": 10000},
        {"id": "ok", "name": "Ok", "window": {"enabled": True, "from": "25:00", "until": "07:00"}},
        {"id": "ok", "name": "Ok", "quiet_window": {"enabled": True, "from": "23:00", "until": "99:99"}},
        {"id": "self-ref", "name": "Loop", "then": "self-ref"},
        {"id": "ok", "name": "Ok", "then": "INVALID SLUG"},
    ],
)
def test_validate_profile_rejects_invalid_inputs(bad):
    with pytest.raises(ValueError):
        validate_profile(bad)


# ---------------------------------------------------------------------------
# ProfileStore: seed, CRUD, atomic persistence, safe delete
# ---------------------------------------------------------------------------


def test_store_seed_from_legacy_config_and_idempotency(tmp_path: Path):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_rules"]["profile_name"] = "T10 eHP"
    cfg["run_rules"]["expected_tier"] = 10
    cfg["run_rules"]["max_runs"] = 5
    cfg["run_rules"]["no_start_enabled"] = True
    cfg["run_rules"]["no_start_from"] = "22:30"
    cfg["run_rules"]["no_start_until"] = "06:30"

    store_path = tmp_path / "data" / "profiles.json"
    store = ProfileStore(store_path)
    seeded = store.seed_from_config(cfg)

    assert store_path.is_file()
    assert seeded["schema_version"] == 1
    assert seeded["active_id"] == "farm-default"
    assert seeded["queued_id"] is None
    assert [p["id"] for p in seeded["profiles"]] == ["farm-default", "tier-push", "tournament"]

    farm = store.get("farm-default")
    assert farm is not None
    assert farm["name"] == "T10 eHP"
    assert farm["tier"] == {"mode": "fixed", "value": 10}
    assert farm["max_runs"] == 5
    assert farm["quiet_window"] == {"enabled": True, "from": "22:30", "until": "06:30"}

    push = store.get("tier-push")
    assert push is not None
    assert push["enabled"] is False
    assert push["priority"] == 20
    assert push["tier"] == {"mode": "highest_unlocked", "value": 0}
    assert push["max_runs"] == 1
    assert push["then"] == "farm-default"

    tourney = store.get("tournament")
    assert tourney is not None
    assert tourney["enabled"] is False
    assert tourney["priority"] == 30
    assert tourney["tier"] == {"mode": "ignore", "value": 0}
    assert tourney["then"] == "farm-default"

    # Calling seed_from_config again does not overwrite existing edits
    store.upsert({**farm, "name": "Edited Farm"})
    again = store.seed_from_config(cfg)
    assert next(p for p in again["profiles"] if p["id"] == "farm-default")["name"] == "Edited Farm"


def test_store_crud_persistence_queue_and_safe_delete(tmp_path: Path):
    path = tmp_path / "profiles.json"
    store = ProfileStore(path)
    store.seed_from_config(DEFAULT_CONFIG)

    # Record a run on farm-default then edit its name without runtime -> runtime preserved
    store.record_run_ended("farm-default", {"wave": 5000})
    farm = store.get("farm-default")
    assert farm["runtime"]["runs_completed"] == 1
    edit_payload = {k: v for k, v in farm.items() if k != "runtime"}
    edit_payload["name"] = "Renamed Farm"
    updated = store.upsert(edit_payload)
    assert updated["name"] == "Renamed Farm"
    assert updated["runtime"]["runs_completed"] == 1

    # Queue next (deferred) vs immediate (keeps queued_id sticky until clear_queued)
    snap = store.queue_next("tier-push")
    assert snap["active_id"] == "farm-default"
    assert snap["queued_id"] == "tier-push"

    snap = store.queue_next("tier-push", immediate=True)
    assert snap["active_id"] == "tier-push"
    assert snap["queued_id"] == "tier-push"

    # Activate does NOT auto-clear queued_id; clear_queued clears only when matching or None
    store.queue_next("tournament")
    snap = store.activate("tournament")
    assert snap["active_id"] == "tournament"
    assert snap["queued_id"] == "tournament"
    snap = store.clear_queued("tier-push")
    assert snap["queued_id"] == "tournament"
    snap = store.clear_queued("tournament")
    assert snap["queued_id"] is None

    # Deleting farm-default clears stale `then` refs on tier-push & tournament
    store.queue_next("farm-default")
    snap = store.delete("farm-default")
    assert snap["queued_id"] is None
    assert all(p["then"] is None for p in snap["profiles"])

    # Deleting active_id moves active_id to a surviving profile
    snap = store.delete("tournament")
    assert snap["active_id"] == "tier-push"
    assert len(snap["profiles"]) == 1

    # Refuses deleting the last remaining profile
    with pytest.raises(ValueError):
        store.delete("tier-push")

    # Reload from disk on a fresh store instance
    reloaded = ProfileStore(path)
    assert reloaded.snapshot()["active_id"] == "tier-push"
    assert len(reloaded.snapshot()["profiles"]) == 1

    # Unknown ids raise KeyError
    with pytest.raises(KeyError):
        reloaded.delete("missing")
    with pytest.raises(KeyError):
        reloaded.activate("missing")
    with pytest.raises(KeyError):
        reloaded.queue_next("missing")
    with pytest.raises(KeyError):
        reloaded.reset_runtime("missing")


# ---------------------------------------------------------------------------
# pick_active() precedence, quiet windows, max_runs -> then fallback
# ---------------------------------------------------------------------------


def test_pick_active_precedence_and_tournament_gate():
    noon = datetime(2026, 11, 27, 12, 0)
    farm = _make_profile("farm", kind="farm", enabled=True, priority=10)
    push = _make_profile("push", kind="push", enabled=True, priority=20, max_runs=1, then="farm")
    tourney = _make_profile("tourney", kind="tournament", enabled=True, priority=30, max_runs=1, then="farm")

    state = {"active_id": "farm", "queued_id": None, "profiles": [farm, push, tourney]}

    # 1) global_finish_and_stop beats everything
    chosen, reason = pick_active(noon, state, tournament_open=True, global_finish_and_stop=True)
    assert chosen["id"] == "farm"
    assert reason == "finish_and_stop"

    # 2) Explicit queued_id beats tournament/push priority
    state_q = {**state, "queued_id": "farm"}
    chosen, reason = pick_active(noon, state_q, tournament_open=True)
    assert chosen["id"] == "farm"
    assert reason is None

    # 3) Tournament wins ONLY when tournament_open=True and not completed this cycle
    chosen, reason = pick_active(noon, state, tournament_open=True)
    assert chosen["id"] == "tourney"
    assert reason is None

    # Already completed this cycle -> falls through to push
    tourney_done = copy.deepcopy(tourney)
    tourney_done["runtime"]["last_tourney_cycle"] = "2026-11-27"
    state_td = {**state, "profiles": [farm, push, tourney_done]}
    chosen, reason = pick_active(noon, state_td, tournament_open=True)
    assert chosen["id"] == "push"
    assert reason is None

    # 4) tournament_open=False -> push beats farm
    chosen, reason = pick_active(noon, state, tournament_open=False)
    assert chosen["id"] == "push"
    assert reason is None

    # 5) push outside active window -> farm wins
    push_win = _make_profile(
        "push",
        kind="push",
        enabled=True,
        priority=20,
        window={"enabled": True, "from": "18:00", "until": "21:00"},
    )
    state_win = {**state, "profiles": [farm, push_win, tourney]}
    chosen, reason = pick_active(noon, state_win, tournament_open=False)
    assert chosen["id"] == "farm"
    assert reason is None

    chosen, reason = pick_active(datetime(2026, 11, 27, 19, 30), state_win, tournament_open=False)
    assert chosen["id"] == "push"
    assert reason is None


def test_pick_active_quiet_window_midnight_wrap_and_max_runs_then_fallback():
    farm = _make_profile(
        "farm-default",
        kind="farm",
        enabled=True,
        quiet_window={"enabled": True, "from": "23:00", "until": "07:00"},
    )
    state = {"active_id": "farm-default", "queued_id": None, "profiles": [farm]}

    # Inside midnight-wrapping quiet window -> hold
    chosen, reason = pick_active(datetime(2026, 11, 27, 23, 30), state)
    assert chosen["id"] == "farm-default"
    assert reason == "no_start_window"

    chosen, reason = pick_active(datetime(2026, 11, 28, 6, 59), state)
    assert chosen["id"] == "farm-default"
    assert reason == "no_start_window"

    # At 07:00 boundary -> eligible again
    chosen, reason = pick_active(datetime(2026, 11, 28, 7, 0), state)
    assert chosen["id"] == "farm-default"
    assert reason is None

    # Active profile hits max_runs with no `then` -> holds with max_runs
    capped = _make_profile("capped", kind="farm", enabled=True, max_runs=2, runtime={"runs_completed": 2})
    chosen, reason = pick_active(
        datetime(2026, 11, 27, 12, 0),
        {"active_id": "capped", "queued_id": None, "profiles": [capped]},
    )
    assert chosen["id"] == "capped"
    assert reason == "max_runs"

    # Active profile hits max_runs WITH `then` pointing to fallback (even if fallback is disabled/standby)
    push_done = _make_profile(
        "push-once",
        kind="push",
        enabled=True,
        max_runs=1,
        then="farm-fallback",
        runtime={"runs_completed": 1},
    )
    fallback = _make_profile("farm-fallback", kind="farm", enabled=False)
    chosen, reason = pick_active(
        datetime(2026, 11, 27, 12, 0),
        {"active_id": "push-once", "queued_id": None, "profiles": [push_done, fallback]},
    )
    assert chosen["id"] == "farm-fallback"
    assert reason is None


# ---------------------------------------------------------------------------
# should_direct_retry()
# ---------------------------------------------------------------------------


def test_should_direct_retry_derived_rules():
    farm = _make_profile("farm-a", kind="farm")
    farm_b = _make_profile("farm-b", kind="farm")
    tourney = _make_profile("tourney", kind="tournament")

    assert should_direct_retry(farm, farm, hold_reason=None, presets_verified=True, tier_verified=True) is True

    # Any hold reason -> False
    assert should_direct_retry(farm, farm, hold_reason="finish_and_stop", presets_verified=True, tier_verified=True) is False
    # Profile switch -> False
    assert should_direct_retry(farm, farm_b, hold_reason=None, presets_verified=True, tier_verified=True) is False
    # Unverified presets or tier -> False
    assert should_direct_retry(farm, farm, hold_reason=None, presets_verified=False, tier_verified=True) is False
    assert should_direct_retry(farm, farm, hold_reason=None, presets_verified=True, tier_verified=False) is False
    # Tournament -> never direct retry
    assert should_direct_retry(tourney, tourney, hold_reason=None, presets_verified=True, tier_verified=True) is False
    # Missing profile -> False
    assert should_direct_retry(None, farm, hold_reason=None, presets_verified=True, tier_verified=True) is False
    assert should_direct_retry(farm, None, hold_reason=None, presets_verified=True, tier_verified=True) is False


# ---------------------------------------------------------------------------
# next_goal() ordering + helper matchers
# ---------------------------------------------------------------------------


def test_next_goal_ordering_cards_modules_tier_and_start():
    farm = _make_profile(
        "farm-t10",
        kind="farm",
        presets={"cards": "Preset 3", "modules": "Preset 2"},
        tier={"mode": "fixed", "value": 10},
    )

    # Hold overrides everything
    assert next_goal(
        farm,
        verified_cards_preset=None,
        verified_modules_preset=None,
        current_tier=9,
        hold_reason="no_start_window",
    ) == {"action": "hold", "reason": "no_start_window"}

    # 1. Cards preset first
    assert next_goal(
        farm, verified_cards_preset="Preset 1", verified_modules_preset=None, current_tier=9
    ) == {"action": "select_card_preset", "target_screen": "cards", "preset": "Preset 3"}

    # 2. Modules preset second
    assert next_goal(
        farm, verified_cards_preset="Preset 3", verified_modules_preset="Preset 1", current_tier=9
    ) == {"action": "select_module_preset", "target_screen": "modules", "preset": "Preset 2"}

    # 3. Fixed tier third
    assert next_goal(
        farm, verified_cards_preset="Preset 3", verified_modules_preset="Preset 2", current_tier=9
    ) == {"action": "set_tier", "target_screen": "home", "mode": "fixed", "value": 10}

    # 4. Start battle once all match
    assert presets_match(farm, "Preset 3", "Preset 2") is True
    assert tier_matches(farm, 10) is True
    assert next_goal(
        farm, verified_cards_preset="Preset 3", verified_modules_preset="Preset 2", current_tier=10
    ) == {"action": "start_battle", "target_screen": "home"}


def test_next_goal_highest_unlocked_and_tournament():
    push = _make_profile(
        "tier-push",
        kind="push",
        presets={"cards": "Preset 4", "modules": None},
        tier={"mode": "highest_unlocked", "value": 0},
    )
    assert next_goal(
        push, verified_cards_preset="Preset 4", verified_modules_preset=None, current_tier=14, ceiling_reached=False
    ) == {"action": "set_tier", "target_screen": "home", "mode": "highest_unlocked", "value": 0}
    assert tier_matches(push, 14, ceiling_reached=False) is False

    assert next_goal(
        push, verified_cards_preset="Preset 4", verified_modules_preset=None, current_tier=15, ceiling_reached=True
    ) == {"action": "start_battle", "target_screen": "home"}
    assert tier_matches(push, 15, ceiling_reached=True) is True

    tourney = _make_profile(
        "tournament",
        kind="tournament",
        presets={"cards": "Preset 5", "modules": "Preset 2"},
    )
    assert next_goal(
        tourney, verified_cards_preset="Preset 5", verified_modules_preset=None, current_tier=None
    ) == {"action": "select_module_preset", "target_screen": "modules", "preset": "Preset 2"}

    assert next_goal(
        tourney, verified_cards_preset="Preset 5", verified_modules_preset="Preset 2", current_tier=None
    ) == {"action": "enter_tournament", "target_screen": "home"}


# ---------------------------------------------------------------------------
# record_run_ended(): counts, Tier Push PB, `then` fallback, reset_runtime
# ---------------------------------------------------------------------------


def test_record_run_ended_push_pb_and_then_transition(tmp_path: Path):
    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(DEFAULT_CONFIG)
    store.activate("tier-push")

    # Configure push with max_runs=3 so PB itself triggers the `then` transition
    push = store.get("tier-push")
    push["max_runs"] = 3
    push["enabled"] = True
    store.upsert(push)
    store.set_baseline_wave("tier-push", 4000)

    # Run 1: falls short of PB (3800 <= 4000) -> no transition yet
    res1 = store.record_run_ended("tier-push", {"wave": 3800, "highest_wave": 4000, "ended_at": "2026-11-27T10:00:00"})
    assert res1["runs_completed"] == 1
    assert res1["new_pb"] is False
    assert res1["goal_completed"] is False
    assert res1["transition_to"] is None
    assert store.snapshot()["queued_id"] is None

    # Run 2: beats baseline (4510 > 4000) -> new PB detected & queues `then` ("farm-default")!
    res2 = store.record_run_ended("tier-push", {"wave": 4510, "highest_wave": 4510, "ended_at": "2026-11-27T12:00:00"})
    assert res2["runs_completed"] == 2
    assert res2["new_pb"] is True
    assert res2["goal_completed"] is True
    assert res2["transition_to"] == "farm-default"
    assert res2["profile"]["runtime"]["baseline_highest_wave"] == 4510
    assert res2["profile"]["runtime"]["last_completed_at"] == "2026-11-27T12:00:00"
    assert store.snapshot()["queued_id"] == "farm-default"

    # Next boundary pick_active switches cleanly to farm-default
    chosen, reason = pick_active(datetime(2026, 11, 27, 12, 1), store.snapshot())
    assert chosen["id"] == "farm-default"
    assert reason is None

    # After activating farm-default and clearing queued_id on battle start, completed push does not re-preempt
    store.activate("farm-default")
    store.clear_queued("farm-default")
    chosen2, reason2 = pick_active(datetime(2026, 11, 27, 15, 0), store.snapshot())
    assert chosen2["id"] == "farm-default"
    assert reason2 is None

    # Reset runtime clears counters and baseline
    cleared = store.reset_runtime("tier-push")
    assert cleared["runtime"] == {
        "runs_completed": 0,
        "last_completed_at": None,
        "baseline_highest_wave": None,
        "last_tourney_cycle": None,
    }


def test_record_run_ended_tournament_stamps_cycle_and_falls_back(tmp_path: Path):
    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(DEFAULT_CONFIG)
    tourney = store.get("tournament")
    tourney["enabled"] = True
    store.upsert(tourney)
    store.activate("tournament")

    res = store.record_run_ended(
        "tournament",
        {"wave": 650, "tourney_cycle": "2026-11-27", "ended_at": "2026-11-27T14:00:00"},
    )
    assert res["runs_completed"] == 1
    assert res["max_runs_reached"] is True
    assert res["transition_to"] == "farm-default"
    assert res["profile"]["runtime"]["last_tourney_cycle"] == "2026-11-27"
    assert store.snapshot()["queued_id"] == "farm-default"

    # Even after activating farm-default and clearing queued_id on battle start, tournament does not re-trigger in same cycle
    store.activate("farm-default")
    store.clear_queued("farm-default")
    chosen, reason = pick_active(datetime(2026, 11, 27, 14, 5), store.snapshot(), tournament_open=True)
    assert chosen["id"] == "farm-default"
    assert reason is None


def test_immediate_run_sticks_for_disabled_profile_until_clear_queued(tmp_path: Path):
    """Fable #3 regression: Run Now on disabled `tier-push` must stick across multi-step nav until clear_queued."""
    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(DEFAULT_CONFIG)
    noon = datetime(2026, 11, 27, 12, 0)

    # Seeded tier-push is enabled=False while farm-default is enabled=True
    assert store.get("tier-push")["enabled"] is False
    assert store.get("farm-default")["enabled"] is True

    # Clicking "Run" (mode="now") sets both active_id and queued_id
    snap = store.queue_next("tier-push", immediate=True)
    assert snap["active_id"] == "tier-push"
    assert snap["queued_id"] == "tier-push"

    # Multi-step navigation scans (cards -> modules -> home) keep picking tier-push even after activate()
    chosen1, reason1 = pick_active(noon, store.snapshot())
    assert chosen1["id"] == "tier-push" and reason1 is None

    store.activate("tier-push")
    assert store.snapshot()["queued_id"] == "tier-push"
    chosen2, reason2 = pick_active(noon, store.snapshot())
    assert chosen2["id"] == "tier-push" and reason2 is None

    # Non-matching clear_queued preserves a newer queued target
    store.clear_queued("farm-default")
    assert store.snapshot()["queued_id"] == "tier-push"

    # Clearing after BATTLE/RETRY tap releases the sticky override
    store.clear_queued("tier-push")
    assert store.snapshot()["queued_id"] is None
    chosen3, reason3 = pick_active(noon, store.snapshot())
    assert chosen3["id"] == "farm-default" and reason3 is None

    # Unconditional clear_queued() clears any queued_id
    store.queue_next("tier-push")
    assert store.clear_queued()["queued_id"] is None


def test_store_upsert_auto_generates_unique_slug_when_id_omitted_or_none(tmp_path: Path):
    store = ProfileStore(tmp_path / "profiles.json")
    store.seed_from_config(DEFAULT_CONFIG)

    # Omitted `id` derives slug from `name`
    p1 = store.upsert({"name": "T11 Night Farm!", "kind": "farm"})
    assert p1["id"] == "t11-night-farm"

    # Explicit `id=None` with duplicate name gets unique numeric suffix
    p2 = store.upsert({"id": None, "name": "T11 Night Farm!", "kind": "farm"})
    assert p2["id"] == "t11-night-farm-2"

    # Punctuation-only name falls back to "profile" / "profile-2"
    p3 = store.upsert({"name": "***", "kind": "push"})
    assert p3["id"] == "profile"
    p4 = store.upsert({"name": "???", "kind": "push"})
    assert p4["id"] == "profile-2"

    # Long 40-char name stays within 32-char slug limit even when suffixed
    long_name = "a" * 40
    p5 = store.upsert({"name": long_name, "kind": "farm"})
    p6 = store.upsert({"name": long_name, "kind": "farm"})
    assert len(p5["id"]) == 32
    assert len(p6["id"]) == 32 and p6["id"].endswith("-2")

    # Explicitly empty or malformed `id` strings are still rejected
    with pytest.raises(ValueError):
        store.upsert({"id": "", "name": "Explicit Empty"})
    with pytest.raises(ValueError):
        store.upsert({"id": "Bad ID!", "name": "Explicit Bad"})
    with pytest.raises(ValueError):
        validate_profile({"name": "No Id Directly"})
