"""tools/upstream_parity.py: what counts as a lost upstream automation.

The comparison runs on synthetic surfaces; no git objects are read."""
import importlib.util
import json

import paths as test_paths

spec = importlib.util.spec_from_file_location("upstream_parity_tool", test_paths.RELEASE_TOOLS / "upstream_parity.py")
parity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parity)


def _surface(**kinds):
    out = {kind: set() for kind in ("route", "event", "def", "flag", "config", "file")}
    for kind, items in kinds.items():
        out[kind] = set(items)
    return out


def test_a_route_or_event_that_disappeared_is_a_gap():
    theirs = _surface(route={"/api/a", "/api/b"}, event={"x", "y"})
    ours = _surface(route={"/api/a"}, event={"x"})
    found = parity.gaps(theirs, ours)
    assert found["route"] == ["/api/b"] and found["event"] == ["y"]


def test_a_function_that_moved_to_another_module_is_not_a_gap():
    theirs = _surface(**{"def": {"backend/a.py:run"}}, file={"backend/a.py"})
    ours = _surface(**{"def": {"backend/b.py:run"}}, file={"backend/a.py", "backend/b.py"})
    assert parity.gaps(theirs, ours)["def"] == []


def test_a_file_moved_to_another_folder_keeps_its_functions_and_flags():
    theirs = _surface(**{"def": {"frontend/dash.py:start"}}, flag={"frontend/dash.py:--port"},
                      file={"frontend/dash.py"})
    ours = _surface(**{"def": {"backend/dash.py:start"}}, flag={"backend/dash.py:--port"},
                    file={"backend/dash.py"})
    found = parity.gaps(theirs, ours)
    assert found["def"] == [] and found["flag"] == [] and found["file"] == []


def test_a_lost_flag_or_config_key_is_a_gap():
    theirs = _surface(flag={"backend/run.py:--preset"}, config={"backend/config.example.yaml:fleet.by_tier"},
                      file={"backend/run.py"})
    ours = _surface(file={"backend/run.py"})
    found = parity.gaps(theirs, ours)
    assert found["flag"] == ["backend/run.py:--preset"]
    assert found["config"] == ["backend/config.example.yaml:fleet.by_tier"]


def test_config_keys_are_dotted_paths_of_every_mapping_level():
    assert parity.config_keys("fleet:\n  by_tier:\n    '14': {first_wave: 2495}\n") == {
        "fleet", "fleet.by_tier", "fleet.by_tier.14", "fleet.by_tier.14.first_wave"}
    assert parity.config_keys(None) == set()


def test_every_allowlist_entry_carries_a_reason():
    allow = json.loads(parity.ALLOW.read_text(encoding="utf-8"))
    for kind, items in allow.items():
        if kind.startswith("_"):
            continue
        assert kind in ("route", "event", "def", "flag", "config", "file", "branch"), kind
        assert all(isinstance(reason, str) and reason.strip() for reason in items.values()), kind
