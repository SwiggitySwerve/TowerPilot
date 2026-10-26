"""A ledger lock in the middle of a two-write session call is retried safely (FOCUS #11 follow-ups).

prepare_next creates the record, then writes its setup report; a retry after a lock at the second write must continue it.
(finish has one write that can raise: ActionSession.settle is contained and never raises.) A prepare locked out after a
wave went backwards must keep its link to the record it continues, until that record is closed.
The collector skips a locked call and retries it."""
import sqlite3
import types

import pytest

from gem_collector_run import run as run_world
from test_battle_session import driver      # noqa: F401  (a real session over a temporary ledger)


def locked():
    return sqlite3.OperationalError('database is locked')


def test_prepare_locked_at_its_setup_write_is_continued_not_duplicated(driver, monkeypatch):
    session, rs, operation = driver
    session.finish('observed_results')
    real, calls = session.store.update_status, []

    def update_status(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise locked()
        return real(*args, **kwargs)
    monkeypatch.setattr(session.store, 'update_status', update_status)
    with pytest.raises(sqlite3.OperationalError):
        session.prepare_next(origin='partial_adoption', previous_battle_id=session.battle['id'])
    created = session.battle['id']
    session.prepare_next(origin='adopted')                  # the retry: the same record gets its setup report
    assert session.battle['id'] == created
    assert session.store.get(created)['runtime']['setup']['detail'] == 'adopted'
    assert len(session.store.list(device='device')) == 2    # the first record and this one


class Session:
    """A fake session whose prepare_next meets a lock after creating its record (the setup write is the locked one)."""

    def __init__(self, *, prepare_locks=0):
        self.state, self.prepare_locks = 'active', prepare_locks
        self.finishes, self.prepares = [], []
        self.effective_preset = lambda: {}
        self.observe = lambda s, raw: True
        self.checkpoint = lambda s, **kw: None

    battle = property(lambda self: dict(status=self.state, id='old' if not self.prepares else 'new'))

    def finish(self, reason, **kw):
        self.finishes.append(reason)
        self.state = 'ended'

    def prepare_next(self, **kw):
        self.prepares.append(kw)
        self.state = 'active'
        if len(self.prepares) <= self.prepare_locks:
            raise locked()


BACKWARDS = ['up', 'down', 'down', 'down', 'down', 'down']
WAVES = {'up': 500, 'down': 100, 'home': None}


def backwards(monkeypatch, session, frames=BACKWARDS):
    return run_world(monkeypatch, frames, session=session, read_wave=lambda f: WAVES[f],
                     screen=lambda f: types.SimpleNamespace(name='home' if f == 'home' else 'battle'))


def test_a_prepare_locked_after_a_backwards_wave_keeps_the_link_to_the_previous_record(monkeypatch):
    session = Session(prepare_locks=1)
    backwards(monkeypatch, session)
    assert session.prepares == [dict(origin='partial_adoption', previous_battle_id='old')] * 2


def test_a_link_waiting_for_its_record_is_dropped_when_that_record_closes(monkeypatch):
    """The prepare after a backwards wave created its record but could not write its setup; the person then left to Home."""
    session = Session(prepare_locks=99)
    backwards(monkeypatch, session, ['up', 'down', 'down', 'down', 'home', 'down', 'down'])
    assert session.prepares[0] == dict(origin='partial_adoption', previous_battle_id='old')
    assert session.finishes[-1] == 'battle_no_longer_observed'
    assert session.prepares[-1] == dict(origin='adopted')       # an unrelated battle is not linked to the old record
