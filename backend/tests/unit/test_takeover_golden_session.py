"""Golden answers of BattleSession.from_environment and the operation worker's run flag on the unchanged code (roadmap item 3, T3-0).

A real ledger in a temporary directory. The session links a predecessor only when store.active() returns it (a record still live whose
operation has ended); a record the dashboard's refresher already finished is not found, and a record whose owner still runs is a Conflict.
The worker deletes the instance's stop_after_run flag for every operation of kind `run`, whatever the request carries, and for no other kind."""
import pytest

import takeover_golden as golden
from takeover_golden_misc import SESSION, WORKER

SESSION_DOCUMENT, WORKER_DOCUMENT = 'battle_session', 'operation_worker'


def test_the_recorded_documents_hold_exactly_these_scenarios():
    golden.assert_registry(SESSION_DOCUMENT, SESSION)
    golden.assert_registry(WORKER_DOCUMENT, WORKER)


@pytest.mark.parametrize('scenario', sorted(SESSION))
def test_the_session_answers_what_was_recorded(scenario, tmp_path, monkeypatch):
    golden.assert_recorded(SESSION_DOCUMENT, scenario, SESSION[scenario](tmp_path, monkeypatch))


@pytest.mark.parametrize('scenario', sorted(WORKER))
def test_the_worker_answers_what_was_recorded(scenario, tmp_path, monkeypatch):
    golden.assert_recorded(WORKER_DOCUMENT, scenario, WORKER[scenario](tmp_path, monkeypatch))


def test_the_predecessor_is_linked_only_through_the_active_list():
    recorded = golden.recorded(SESSION_DOCUMENT)
    linked = recorded['predecessor_of_an_ended_driver']['started']['ledger']
    assert (linked[0]['status'], linked[0]['reason']) == ('interrupted', 'driver_operation_ended')
    assert (linked[1]['origin'], linked[1]['previous']) == ('partial_adoption', 'battle-1')
    unlinked = recorded['predecessor_already_reconciled']
    assert unlinked['live_records_the_successor_could_find'] == []
    assert unlinked['ledger'][1]['origin'] == 'started' and unlinked['ledger'][1]['previous'] is None


def test_the_run_flag_is_deleted_for_runs_only():
    cases = golden.recorded(WORKER_DOCUMENT)['worker_run_flag']['cases']
    assert [(case['kind'], case['flag_after']) for case in cases] == [('run', False)] * 3 + [('gems', True)] * 2
    assert all(case['other_instance_flag_after'] for case in cases)
