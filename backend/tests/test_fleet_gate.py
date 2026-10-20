"""The fleet Nuke fires on SIGHT of the fleet pentagon, blue or not (user,
2026-10-18: a 10-wave hold lost runs at 3753 and 4498 x2 to the fleet's
Scatter swarm). Fleets are big outlined pentagons, one random type per
spawn: saboteur red, commander orange, overcharge blue. Frames here are
synthetic; no game image is involved."""
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

import orchestrator
from vision import fleet_scan

FIELD = (0, 300, 1080, 1330)
HUE = {"saboteur": 177, "commander": 15, "overcharge": 127}


def _poly(img, centre, radius, hue, sides, thick=14):
    pts = np.array([[centre[0] + radius * np.sin(2 * np.pi * i / sides),
                     centre[1] - radius * np.cos(2 * np.pi * i / sides)]
                    for i in range(sides)], np.int32)
    col = cv2.cvtColor(np.uint8([[[hue, 230, 255]]]), cv2.COLOR_HSV2BGR)[0, 0].tolist()
    cv2.polylines(img, [pts], True, col, thick, cv2.LINE_AA)


def _frame():
    return np.zeros((2560, 1080, 3), np.uint8)


@pytest.mark.parametrize("radius", [30, 45, 70])
@pytest.mark.parametrize("kind", sorted(HUE))
def test_each_fleet_pentagon_is_counted_under_its_own_type_only(kind, radius):
    f = _frame()
    _poly(f, (400, 900), radius, HUE[kind], 5)
    got = fleet_scan.scan(f, FIELD)
    assert got == {k: int(k == kind) for k in HUE}


def test_triangles_and_squares_sharing_a_hue_are_not_fleets():
    f = _frame()
    for hue in HUE.values():
        _poly(f, (300, 700), 45, hue, 3)
        _poly(f, (600, 900), 45, hue, 4)
    assert fleet_scan.scan(f, FIELD) == {k: 0 for k in HUE}


def test_small_ordinary_enemies_are_below_the_fleet_size():
    f = _frame()
    _poly(f, (300, 700), 12, HUE["saboteur"], 5, thick=5)
    assert fleet_scan.scan(f, FIELD)["saboteur"] == 0


def test_side_menu_column_is_excluded():
    f = _frame()
    _poly(f, (950, 600), 45, HUE["commander"], 5)
    assert fleet_scan.scan(f, FIELD)["commander"] == 1
    assert fleet_scan.scan(f, FIELD, exclude=(840, 0, 1080, 1100))["commander"] == 0


@pytest.fixture
def gate(monkeypatch):
    monkeypatch.setattr(orchestrator, "_battle_session", None)
    monkeypatch.setattr(orchestrator.logger, "event", lambda *a, **k: None)
    monkeypatch.setattr(orchestrator.logger, "shot", lambda *a, **k: "")
    monkeypatch.setitem(orchestrator.CONFIG["rois"], "field", list(FIELD))
    monkeypatch.setitem(orchestrator.CONFIG, "fleet", {})
    return orchestrator.RunState()


def test_blue_fleet_fires_at_once(gate):
    f = _frame()
    _poly(f, (400, 900), 45, HUE["overcharge"], 5)
    assert orchestrator.fleet_gate(gate, f, 1495, 1498) == "blue_fleet"


@pytest.mark.parametrize("kind", ["saboteur", "commander"])
def test_other_fleets_fire_on_sight_too(gate, kind):
    f = _frame()
    _poly(f, (400, 900), 45, HUE[kind], 5)
    assert orchestrator.fleet_gate(gate, f, 4495, 4498) == f"fleet_{kind}"


def test_sighting_sticks_after_the_pentagon_leaves_the_frame(gate):
    f = _frame()
    _poly(f, (400, 900), 45, HUE["commander"], 5)
    assert orchestrator.fleet_gate(gate, f, 3745, 3748) == "fleet_commander"
    assert orchestrator.fleet_gate(gate, _frame(), 3745, 3750) == "fleet_commander"


def test_no_sighting_never_fires(gate):
    assert orchestrator.fleet_gate(gate, _frame(), 1495, 1520) is None


def test_gate_can_be_switched_off_for_the_plain_schedule(gate, monkeypatch):
    monkeypatch.setitem(orchestrator.CONFIG, "fleet", {"sighting": {"enabled": False}})
    assert orchestrator.fleet_gate(gate, _frame(), 1495, 1498) == "schedule"


def test_fire_skip_is_logged_once_per_mark_with_the_button_state(gate, monkeypatch):
    events = []
    monkeypatch.setattr(orchestrator.logger, "event",
                        lambda kind, **kw: events.append((kind, kw)))

    class St:
        present, ready, score, center = False, False, 0.0, None
    monkeypatch.setattr(orchestrator.detect, "button_state", lambda *a, **k: St())
    for wave in (1498, 1503):
        orchestrator.fleet_fire_skipped(gate, _frame(), 1495, wave, "blue_fleet")
    assert [e[0] for e in events] == ["fleet_fire_skipped"]
    assert events[0][1]["mark"] == 1495 and events[0][1]["present"] is False


def test_sighting_stays_latched_after_a_later_scan_error(gate, monkeypatch):
    frame = _frame()
    _poly(frame, (400, 900), 45, HUE["commander"], 5)
    assert orchestrator.fleet_gate(gate, frame, 1495, 1498) == "fleet_commander"

    def failed_scan(*args, **kwargs):
        raise ValueError("unreadable crop")

    monkeypatch.setattr(fleet_scan, "scan", failed_scan)
    assert orchestrator.fleet_gate(gate, frame, 1495, 1500) == "fleet_commander"
    assert orchestrator.fleet_gate(gate, frame, 2495, 2498) is None


def test_fleet_settings_and_field_stay_frozen_for_the_current_battle(gate, monkeypatch):
    config = {"fleet": {"sighting": {"min_area": 900},
                        "by_tier": {"18": {"first_wave": 95, "interval": 100}}},
              "rois": {"field": FIELD}}
    session = SimpleNamespace(config=config, effective_preset=lambda: {"tier": 18})
    monkeypatch.setattr(orchestrator, "_battle_session", session)
    monkeypatch.setitem(orchestrator.CONFIG, "fleet", {"sighting": {"enabled": False},
                        "by_tier": {"18": {"first_wave": 999, "interval": 1000}}})
    monkeypatch.setitem(orchestrator.CONFIG["rois"], "field", (0, 0, 1, 1))
    calls = []
    monkeypatch.setattr(fleet_scan, "scan", lambda frame, **kw: calls.append(kw) or {})
    assert orchestrator.marks()[:2] == [95, 195]
    assert orchestrator.fleet_gate(gate, _frame(), 95, 98) is None
    assert calls[0]["field"] == FIELD
    assert calls[0]["min_area"] == 900

    # Only installing the next battle's snapshot changes sighting policy.
    config["fleet"]["sighting"]["enabled"] = False
    assert orchestrator.fleet_gate(gate, _frame(), 95, 98) == "schedule"


def test_a_new_run_forgets_sightings_and_skip_logging(gate, monkeypatch):
    frame = _frame()
    _poly(frame, (400, 900), 45, HUE["commander"], 5)
    assert orchestrator.fleet_gate(gate, frame, 1495, 1498) == "fleet_commander"
    monkeypatch.setattr(orchestrator.detect, "button_state",
                        lambda *a: SimpleNamespace(present=False, ready=False, score=0.0))
    orchestrator.fleet_fire_skipped(gate, frame, 1495, 1498, "fleet_commander")
    next_run = orchestrator.RunState()
    assert next_run.fleet_seen == {}
    assert next_run.nuked_marks == set()
    assert next_run.fleet_try_at == 0.0
    assert orchestrator.fleet_gate(next_run, _frame(), 1495, 1498) is None


@pytest.mark.parametrize("loop", ["observe", "fast_wall"])
@pytest.mark.parametrize("sighted", [False, True])
def test_both_observation_loops_require_a_sighting_before_firing(
        gate, monkeypatch, loop, sighted):
    frame = _frame()
    if sighted:
        _poly(frame, (400, 900), 45, HUE["commander"], 5)
    abilities = {"rescue_bar": None, "dm_below": 0.2,
                 "nuke_on_fleet": {"after_waves": 1, "window_waves": 60}}
    monkeypatch.setattr(orchestrator, "preset", lambda: {"abilities": abilities})
    monkeypatch.setattr(orchestrator, "marks", lambda: [1495])
    monkeypatch.setattr(orchestrator.detect, "death_screen", lambda f: (False, None))
    monkeypatch.setattr(orchestrator.detect, "second_wind_badge", lambda f: (False, 0.0))
    monkeypatch.setitem(orchestrator.CONFIG["rois"], "wall_bar", None)
    monkeypatch.setattr(orchestrator, "demon_mode_always", lambda *a: False)
    gate.tracker.last = 1498
    gate.tracker.update = lambda wave: None
    gate.gems = SimpleNamespace(poll=lambda f: f)
    fired = []
    monkeypatch.setattr(orchestrator, "fire_button",
                        lambda f, name, reason, **kw: fired.append((name, reason)) or True)
    if loop == "observe":
        orchestrator.watch_frame(gate, frame, observation={"raw_wave": 1498})
    else:
        samples = []
        monkeypatch.setattr(orchestrator.capture, "grab", lambda: samples.append(1) or frame)
        monkeypatch.setattr(orchestrator.wave_reader, "read_wave", lambda f: 1498)
        monkeypatch.setattr(orchestrator.detect, "wall_overheal",
                            lambda f: (1.0, "immune" if len(samples) >= 8 else "normal"))
        monkeypatch.setattr(orchestrator.time, "sleep", lambda *a: None)
        gate.post_sw_until = float("inf")
        assert orchestrator._fast_wall_watch(gate, abilities) == "immune"
    assert fired == ([("nuke", "fleet_1495")] if sighted else [])
    assert gate.nuked_marks == ({1495} if sighted else set())
