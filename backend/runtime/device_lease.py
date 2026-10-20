"""Process-lifetime OS ownership of an ADB server/serial, across checkouts.

No timestamp or heartbeat permits stealing ownership. Lock files are never
deleted: unlinking a locked inode would create a second independent owner.
"""
import atexit
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time


class DeviceBusy(RuntimeError):
    pass


_ROOT = (Path(os.environ.get("PROGRAMDATA", tempfile.gettempdir())) / "TowerPilot" / "device-leases"
         if os.name == "nt" else Path(tempfile.gettempdir()) / "towerpilot-device-leases")
_ENV = "TOWER_DEVICE_DELEGATION"
_current = None
_guard = threading.RLock()


def _lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b", buffering=0)
    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            # Windows permits locking a byte beyond EOF.
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        handle.close()
        raise DeviceBusy("Another process owns this emulator") from exc
    return handle


def _unlock(handle):
    if os.name == "nt":
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    handle.close()


class Lease:
    def __init__(self, key, path, handle, delegated=False):
        self.key, self.path, self.handle = key, path, handle
        self.delegated = delegated
        self.pid = os.getpid()
        self.token = secrets.token_hex(32)
        import psutil
        process = psutil.Process()
        self.creation_time = process.create_time()
        self.launchers = {}
        for parent in process.parents():
            try:
                if ("python" in parent.name().lower()
                        and parent.cmdline()[1:] == process.cmdline()[1:]):
                    self.launchers[str(parent.pid)] = parent.create_time()
            except psutil.Error:
                continue

    def grant(self):
        return {"key": self.key, "pid": self.pid, "token": self.token,
                "creation_time": self.creation_time, "launchers": self.launchers}

    def check(self):
        if self.handle.closed or self.pid != os.getpid():
            raise DeviceBusy("Device lease is no longer owned by this process")
        if not self.delegated:
            # A delegated scheduler child owns input until it exits.
            probe = _lock(self.path.with_suffix(".activity"))
            _unlock(probe)
        return self

    def release(self):
        global _current
        with _guard:
            if not self.handle.closed:
                _unlock(self.handle)
            if _current is self:
                _current = None

    def __enter__(self):
        return self.check()

    def __exit__(self, *exc):
        self.release()


def _device_key(serial, host="127.0.0.1", port=5037):
    """Use one endpoint identity for acquisition and legacy-owner discovery."""
    if not serial:
        raise ValueError("Cannot own a device without an ADB serial")
    host = str(host).lower()
    if host in {"localhost", "::1"}:
        host = "127.0.0.1"
    return host, int(port), str(serial)


def acquire(serial, host="127.0.0.1", port=5037):
    """Acquire once per process, refusing a second bound device."""
    global _current
    key = _device_key(serial, host, port)
    with _guard:
        if _current is not None:
            if _current.key != key:
                raise DeviceBusy("One device per process: start a separate worker")
            return _current.check()
        digest = hashlib.sha256(json.dumps(key).encode()).hexdigest()
        path = _ROOT / (digest + ".lock")
        delegated = False
        inherited = os.environ.get(_ENV)
        if inherited:
            try:
                grant = json.loads(inherited)
                metadata = json.loads(path.with_suffix(".json").read_text())
                import psutil
                ancestors = {p.pid for p in psutil.Process().parents()}
                delegated = (grant == metadata and grant["key"] == list(key)
                             and grant["pid"] in ancestors)
            except (ValueError, OSError, KeyError, TypeError):
                delegated = False
        if delegated:
            handle = _lock(path.with_suffix(".activity"))
            # Parent must still own primary lock. If it exited before the
            # child starts, normal acquisition is required instead.
            try:
                if json.loads(path.with_suffix(".json").read_text()) != grant:
                    raise DeviceBusy("Device delegation was superseded")
            except BaseException:
                _unlock(handle)
                raise
            try:
                probe = _lock(path)
            except DeviceBusy:
                # The activity lock already excludes every fresh owner even
                # if the supervisor exits immediately after this check.
                pass
            else:
                _unlock(probe)
                _unlock(handle)
                delegated = False
        if not delegated:
            handle = _lock(path)
            try:
                probe = _lock(path.with_suffix(".activity"))
                _unlock(probe)
            except BaseException:
                _unlock(handle)
                raise
        lease = Lease(key, path, handle, delegated)
        try:
            metadata_path = path.with_suffix(".activity.json" if delegated else ".json")
            metadata_path.write_text(json.dumps(lease.grant()))
        except BaseException:
            _unlock(handle)
            raise
        _current = lease
        return lease


def ensure_current():
    """Fence input with the actual configured socket endpoint and serial."""
    import settings
    from device import adbclient
    return acquire(settings.instance()["serial"], *adbclient._HOST)


def prepare_instance(name=None):
    """Restore accepted context and own the target before binding/config writes."""
    import settings
    from device import adbclient
    from runtime.operations import restore_worker_context
    restore_worker_context(settings, name)
    return acquire(settings.instance(name)["serial"], *adbclient._HOST)


@contextmanager
def input_scope():
    """Fence the complete input call against scheduler-child takeover."""
    with _guard:
        lease = ensure_current()
        if lease.delegated:
            yield lease
        else:
            handle = _lock(lease.path.with_suffix(".activity"))
            try:
                yield lease
            finally:
                _unlock(handle)


def child_environment():
    """Delegate activity to one scheduler child while reserving ownership."""
    lease = ensure_current()
    if lease.delegated:
        # A one-shot supervisor (tier_ladder) may finish by spawning combo.
        # Retain activity ownership until its primary reservation is released,
        # then promote in place; no unowned interval exists between processes.
        deadline = time.monotonic() + 5
        while True:
            try:
                primary = _lock(lease.path)
            except DeviceBusy:
                if time.monotonic() >= deadline:
                    raise DeviceBusy("The supervising owner must exit before this worker can supervise")
                time.sleep(.05)
                continue
            activity = lease.handle
            lease.handle, lease.delegated = primary, False
            try:
                lease.path.with_suffix(".json").write_text(json.dumps(lease.grant()))
            except BaseException:
                lease.handle, lease.delegated = activity, True
                _unlock(primary)
                raise
            _unlock(activity)
            break
    env = dict(os.environ)
    env.pop("TOWER_OPERATION_ID", None)
    env.pop("TOWER_OPERATION_DB", None)
    env.pop("TOWER_BATTLE_ID", None)
    env.pop("TOWER_BATTLE_GENERATION", None)
    env[_ENV] = json.dumps(lease.grant())
    return env


def owns_different_device(pid, target=None):
    """Prove a discovered runner belongs to another leased ADB endpoint.

    Missing, stale or unreadable proof stays conservative. A PID alone cannot
    identify an owner after process exit and PID reuse.
    """
    import settings
    import psutil
    from device import adbclient
    if target is None:
        target = (*adbclient._HOST, settings.instance().get("serial"))
    host, port, serial = target
    if not serial:
        return False
    target = _device_key(serial, host, port)
    try:
        metadata_files = list(_ROOT.glob("*.json"))
        if not metadata_files:
            return False
        started = psutil.Process(pid).create_time()
    except (OSError, psutil.Error):
        return False
    for path in metadata_files:
        try:
            owner = json.loads(path.read_text())
            identified = ((owner.get("pid") == pid and owner.get("creation_time") == started)
                          or owner.get("launchers", {}).get(str(pid)) == started)
            if not identified or tuple(owner.get("key", ())) == target:
                continue
            try:
                lock_path = (path.with_suffix("") if path.name.endswith(".activity.json")
                             else path.with_suffix(".lock"))
                probe = _lock(lock_path)
            except DeviceBusy:
                return True
            else:
                _unlock(probe)
        except (OSError, ValueError, TypeError):
            continue
    return False


def release_current():
    if _current is not None:
        _current.release()


atexit.register(release_current)
