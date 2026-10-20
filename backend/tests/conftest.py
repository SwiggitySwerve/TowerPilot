"""Suite-wide fixtures."""

import copy
from pathlib import Path

import pytest
import yaml

import settings

# settings.CONFIG is loaded at import from the machine's own git-ignored
# backend/config.yaml, so results used to depend on each install's config (a
# bound account, a non-native `rendering`, a `fleet.by_tier` override). pytest
# imports this file before any test module, and settings imports nothing that
# reads CONFIG, so it is replaced here with the shipped config.example.yaml
# before any other module sees it: in place, because modules hold
# `from settings import CONFIG`, with bind_device()'s pristine snapshots retaken
# from the same body.
settings.CONFIG.clear()
settings.CONFIG.update(yaml.safe_load(settings.CONFIG_EXAMPLE.read_text(encoding="utf-8")))
settings._DEFAULTS = {k: copy.deepcopy(settings.CONFIG[k]) for k in settings._OVERRIDABLE if k in settings.CONFIG}
settings._ACCOUNT_DEFAULTS = {k: copy.deepcopy(settings.CONFIG.get(k)) for k in settings._ACCOUNT_DEFAULTS}


@pytest.fixture(autouse=True)
def _operation_ledger_in_tmp_path(tmp_path, monkeypatch):
    """Legacy dashboard fixtures must never open the machine's real ledger."""
    from control import operations
    original = operations.ledger
    checkout_backend = Path(__file__).resolve().parents[1]

    def isolated(root):
        if Path(root).resolve() == checkout_backend:
            root = tmp_path / 'operation-root'
        return original(root)

    monkeypatch.setattr(operations, 'ledger', isolated)


@pytest.fixture(autouse=True)
def _device_lease_in_tmp_path(tmp_path, monkeypatch):
    """Offline tests can never reserve the user's actual emulator."""
    from runtime import device_lease
    device_lease.release_current()
    monkeypatch.setattr(device_lease, "_ROOT", tmp_path / "device-leases")
    yield
    device_lease.release_current()


@pytest.fixture(autouse=True)
def _event_log_in_tmp_path(tmp_path, monkeypatch):
    """Point runtime.logger's JSONL events and trigger screenshots at this
    test's tmp_path instead of backend/logs/<instance>/.

    The logger fixes its file on the first event under the real log dir, and
    the dashboard / tray read the newest events_*.jsonl there as live activity,
    so every test whose code path reached an unpatched logger.event() wrote
    fixture records into the user's log. Resetting `_run_file` makes the next
    event name a fresh file under the patched dir; tests that assert on events
    still patch logger.event themselves."""
    from runtime import logger

    monkeypatch.setattr(logger, "_LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(logger, "_run_file", None)
