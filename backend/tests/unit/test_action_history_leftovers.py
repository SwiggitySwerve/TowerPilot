"""Offline regressions for the four r18h leftovers."""
from types import SimpleNamespace

from control import actions as api
from runtime.action_session import ActionSession
import action_history_cases as cases
from towerpilot_workflows.action_history import validate_history
from towerpilot_workflows.actions import Actions


def test_toggle_is_durable_before_end_of_pass(tmp_path, monkeypatch):
    import orchestrator
    host = cases.RealHost(tmp_path)
    rs = SimpleNamespace(action_session=host.session)
    monkeypatch.setattr(orchestrator.shopper, 'uw_toggle', lambda *args: True)
    assert orchestrator.uw_toggle(rs, 'death_wave', True, 'uw_wanted') is True
    # A separate connection sees the commit without a flush or finalizer.
    rows = Actions.read(str(host.path))[0]
    assert len(rows) == 1
    assert rows[0]['refs']['weapon'] == 'death_wave'


def test_record_carries_execution_start_instead_of_write_time(tmp_path):
    clock = cases.SteppedClock(mono=10, wall=1000)
    session = ActionSession(tmp_path / 'ledger.db', context=cases.CONTEXT,
                            driver='orchestrator', clock=clock)
    clock.advance(20)
    row = session.record('uw_toggle', result='succeeded', started_at=1000, finished_at=1015)
    assert row is not None
    assert (row['started_at'], row['finished_at'], row['duration_ms']) == (1000, 1015, None)
    assert Actions.read(session.path)[0][0] == row


def test_refused_count_in_validator_and_served_battle(tmp_path):
    host = cases.RealHost(tmp_path)
    foreign = cases.execution(battle_id=host.battle_id, generation='foreign')
    assert validate_history(host.battle_record(), [foreign, None])['refused_count'] == 2
    for i in range(3):
        body = cases.execution(battle_id=host.battle_id, generation=f'foreign-{i}', started_at=9e9 + i)
        Actions(str(host.path)).record_terminal(body, result='no_op')
    host.session.record('ad_gems', result='no_op')
    page = api.for_battle(tmp_path, host.battle_record(), limit=2)
    assert len(page['items']) == 1
    assert page['refused_count'] == 3


def test_prune_bounds_bodies_examined_even_when_all_candidates_still_count(tmp_path, monkeypatch):
    host = cases.RealHost(tmp_path)
    for _ in range(8):
        host.session.record('ad_gems', result='no_op')
    examined = []
    monkeypatch.setattr(Actions, '_still_counting', staticmethod(lambda raw, cutoff: examined.append(raw) or True))
    assert Actions(str(host.path)).prune(now=9e12, batch=2) == 0
    assert len(examined) <= 2


def test_failed_commit_is_visible_and_never_acknowledged(tmp_path, monkeypatch):
    from runtime import action_session
    host = cases.RealHost(tmp_path)
    events = []
    monkeypatch.setattr(action_session.logger, 'event', lambda kind, **fields: events.append((kind, fields)))
    # Lock at the transaction boundary, rather than replacing the public record method.
    import contextlib
    @contextlib.contextmanager
    def failed_transaction():
        raise OSError('disk full')
        yield
    monkeypatch.setattr(host.session._actions(), '_db', failed_transaction)
    assert host.session.record('uw_toggle', result='succeeded') is None
    assert host.session.unrecorded == {'record': 1}
    assert events[0][0] == 'action_record_failed'
    assert host.rows() == []


def test_prune_negative_and_oversized_batches_still_have_a_hard_bound(tmp_path, monkeypatch):
    from towerpilot_workflows import actions
    host = cases.RealHost(tmp_path)
    for _ in range(8):
        host.session.record('ad_gems', result='no_op')
    monkeypatch.setattr(actions, 'PRUNE_BATCH', 2)
    store = Actions(str(host.path))
    assert store.prune(now=9e12, batch=-1) == 2
    assert store.prune(now=9e12, batch=9999) == 2


def test_record_survives_process_exit_without_finalizers(tmp_path):
    import subprocess
    import sys
    path = tmp_path / 'crash.db'
    script = """
import os, sys
from runtime.action_session import ActionSession
session = ActionSession(sys.argv[1], context={'device_key': 'device'}, driver='orchestrator')
assert session.record('uw_toggle', result='succeeded', started_at=1000, finished_at=1001) is not None
os._exit(29)
"""
    import os
    import paths as test_paths
    env = dict(os.environ, PYTHONPATH=str(test_paths.BACKEND))
    child = subprocess.run([sys.executable, '-c', script, str(path)], env=env, capture_output=True, timeout=20)
    assert child.returncode == 29, child.stderr
    assert len(Actions.read(path)[0]) == 1


def test_retry_deadline_excludes_durable_write_latency(monkeypatch):
    import orchestrator
    now = [100.0]
    class Session:
        def record(self, *args, **kwargs):
            now[0] += 15
    rs = SimpleNamespace(action_session=Session(), uw_fails=0, uw_next_try=0)
    monkeypatch.setattr(orchestrator.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(orchestrator.shopper, 'uw_toggle', lambda *args: False)
    ok = orchestrator.uw_toggle(rs, 'death_wave', True, 'uw_wanted')
    orchestrator.uw_backoff(rs, ok)
    assert now[0] == 115 and rs.uw_next_try == 110
