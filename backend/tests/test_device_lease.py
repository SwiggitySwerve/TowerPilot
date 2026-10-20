"""Real OS locking tests using only synthetic serials and temporary files."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from runtime import device_lease


BACKEND = Path(__file__).resolve().parents[1]
SCRIPT = '''
import json, sys
from pathlib import Path
from runtime import device_lease as lease
lease._ROOT = Path(sys.argv[1])
try:
    held = lease.acquire(sys.argv[2], port=int(sys.argv[3]))
except lease.DeviceBusy:
    print('busy', flush=True)
    raise SystemExit(3)
print('owned', flush=True)
sys.stdin.readline()
'''


def child(tmp_path, serial="synthetic-device", port=5037, env=None, cwd=None, script=SCRIPT):
    environment = dict(os.environ, PYTHONPATH=str(BACKEND))
    if env is not None:
        environment.update(env)
    return subprocess.Popen([sys.executable, "-c", script, str(device_lease._ROOT), serial, str(port)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env=environment, cwd=cwd or tmp_path)


def stop(proc):
    if proc.poll() is None:
        proc.communicate("exit\n", timeout=15)


def test_same_device_is_atomic_across_checkouts_and_released_on_exit(tmp_path):
    first_cwd, second_cwd = tmp_path / "checkout1", tmp_path / "checkout2"
    first_cwd.mkdir()
    second_cwd.mkdir()
    first = child(tmp_path, cwd=first_cwd)
    try:
        assert first.stdout.readline().strip() == "owned"
        second = child(tmp_path, cwd=second_cwd)
        assert second.communicate(timeout=15)[0].strip() == "busy"
        assert second.returncode == 3
        first.kill()
        first.communicate(timeout=15)
        third = child(tmp_path, cwd=second_cwd)
        try:
            assert third.stdout.readline().strip() == "owned"
        finally:
            stop(third)
    finally:
        stop(first)


def test_simultaneous_processes_have_exactly_one_owner(tmp_path):
    gated = SCRIPT.replace("try:\n", "print('ready', flush=True)\nsys.stdin.readline()\ntry:\n", 1)
    contenders = [child(tmp_path, script=gated), child(tmp_path, script=gated)]
    try:
        assert [p.stdout.readline().strip() for p in contenders] == ["ready", "ready"]
        for proc in contenders:
            proc.stdin.write("go\n")
            proc.stdin.flush()
        assert sorted(p.stdout.readline().strip() for p in contenders) == ["busy", "owned"]
    finally:
        for proc in contenders:
            stop(proc)


def test_different_serials_and_servers_are_independent(tmp_path):
    device_lease.acquire("synthetic-device")
    for serial, port in [("different-device", 5037), ("synthetic-device", 15037)]:
        other = child(tmp_path, serial, port)
        try:
            assert other.stdout.readline().strip() == "owned"
        finally:
            stop(other)


def test_process_cannot_rebind_while_owning_device():
    first = device_lease.acquire("synthetic-device")
    assert device_lease.acquire("synthetic-device", host="localhost") is first
    with pytest.raises(device_lease.DeviceBusy, match="One device per process"):
        device_lease.acquire("different-device")


def test_scheduler_delegates_input_without_releasing_reservation(tmp_path):
    held = device_lease.acquire("synthetic-device")
    # child_environment resolves the configured serial; use the exact explicit
    # grant here so this OS-lock test never loads machine configuration.
    grant = held.grant()
    runner = child(tmp_path, env={device_lease._ENV: json.dumps(grant)})
    try:
        assert runner.stdout.readline().strip() == "owned"
        with pytest.raises(device_lease.DeviceBusy):
            held.check()
        intruder = child(tmp_path, env={device_lease._ENV: ""})
        assert intruder.communicate(timeout=15)[0].strip() == "busy"
    finally:
        stop(runner)
    assert held.check() is held


def test_activity_remains_exclusive_after_supervisor_releases(tmp_path):
    held = device_lease.acquire("synthetic-device")
    grant = held.grant()
    runner = child(tmp_path, env={device_lease._ENV: json.dumps(grant)})
    try:
        assert runner.stdout.readline().strip() == "owned"
        held.release()
        intruder = child(tmp_path, env={device_lease._ENV: ""})
        assert intruder.communicate(timeout=15)[0].strip() == "busy"
    finally:
        stop(runner)
    device_lease.acquire("synthetic-device")


def test_act_fence_refuses_parent_input_while_child_drives(tmp_path, monkeypatch):
    import settings
    from device import act, adbclient
    held = device_lease.acquire("synthetic-device")
    monkeypatch.setattr(settings, "instance", lambda: {"serial": "synthetic-device"})
    monkeypatch.setattr(adbclient, "shell", lambda *a, **k: pytest.fail("input escaped ownership fence"))
    grant = held.grant()
    runner = child(tmp_path, env={device_lease._ENV: json.dumps(grant)})
    try:
        assert runner.stdout.readline().strip() == "owned"
        with pytest.raises(device_lease.DeviceBusy):
            act._input("tap", 10, 20)
    finally:
        stop(runner)


def test_discovery_skips_only_proven_different_device_owner(tmp_path, monkeypatch):
    import settings
    monkeypatch.setattr(settings, "instance", lambda: {"serial": "synthetic-device"})
    runner = child(tmp_path, serial="different-device")
    try:
        assert runner.stdout.readline().strip() == "owned"
        assert device_lease.owns_different_device(runner.pid)
        monkeypatch.setattr(settings, "instance", lambda: {"serial": "different-device"})
        assert not device_lease.owns_different_device(runner.pid)
        monkeypatch.setattr(settings, "instance", lambda: {"serial": "synthetic-device"})
        path = next(device_lease._ROOT.glob("*.json"))
        owner = json.loads(path.read_text())
        owner["creation_time"] += 1
        owner["launchers"] = {pid: stamp + 1 for pid, stamp in owner.get("launchers", {}).items()}
        path.write_text(json.dumps(owner))
        assert not device_lease.owns_different_device(runner.pid)
    finally:
        stop(runner)


def test_child_can_promote_after_one_shot_supervisor_exits(tmp_path):
    held = device_lease.acquire("synthetic-device")
    promote = SCRIPT + '''
lease.ensure_current = lambda: held
environment = lease.child_environment()
assert not held.delegated
print('promoted', flush=True)
sys.stdin.readline()
'''
    runner = child(tmp_path, env={device_lease._ENV: json.dumps(held.grant())}, script=promote)
    try:
        assert runner.stdout.readline().strip() == "owned"
        held.release()
        runner.stdin.write("promote\n")
        runner.stdin.flush()
        assert runner.stdout.readline().strip() == "promoted"
        intruder = child(tmp_path, env={device_lease._ENV: ""})
        assert intruder.communicate(timeout=15)[0].strip() == "busy"
    finally:
        stop(runner)


@pytest.mark.parametrize("host", ["localhost", "LOCALHOST", "::1", "127.0.0.1"])
def test_discovery_keeps_same_device_owner_for_loopback_alias(tmp_path, monkeypatch, host):
    import settings
    from device import adbclient
    monkeypatch.setattr(settings, "instance", lambda: {"serial": "synthetic-device"})
    monkeypatch.setattr(adbclient, "_HOST", (host, 5037))
    runner = child(tmp_path)
    try:
        assert runner.stdout.readline().strip() == "owned"
        assert not device_lease.owns_different_device(runner.pid)
    finally:
        stop(runner)
