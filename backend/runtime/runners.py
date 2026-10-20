"""Exclusive-device runner detection shared by the setup preflights."""

from pathlib import Path

# Script basenames that drive the device. A python process whose argv names
# one of them holds the device and excludes every other runner.
RUNNER_SCRIPTS = frozenset({"orchestrator.py", "shard.py", "combo.py", "tourney.py", "quest_sm.py",
                            "quest_ilm.py", "scan.py", "calibrate.py", "clicker.py", "boot.py", "harness.py",
                            "gem_collector.py", "coin.py", "tournament.py", "tier_ladder.py",
                            "operation_worker.py", "hp_probe.py"})


def other_runners(target=None):
    """Yield (pid, script basename, argv) for every python process, other than
    this one and its ancestors, whose argv names a RUNNER_SCRIPTS basename.

    Ancestors are skipped because a venv launcher (uv's Scripts/python.exe on
    Windows) starts the real interpreter as a CHILD with the same script
    arguments, so this process's own launcher would otherwise read as a
    second runner. A runner that is not this process's ancestor is still yielded."""
    import psutil
    me = psutil.Process()
    skip = {me.pid} | {a.pid for a in me.parents()}
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        if p.info["pid"] in skip or "python" not in (p.info["name"] or "").lower():
            continue
        args = p.info["cmdline"] or []
        script = next((Path(a).name for a in args if Path(a).name in RUNNER_SCRIPTS), None)
        if script:
            from runtime.device_lease import owns_different_device
            if owns_different_device(p.info["pid"], target=target):
                continue
            yield p.info["pid"], script, args
