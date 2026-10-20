"""Setup evidence belongs to one battle's durable history, never its source."""
import copy
from types import SimpleNamespace

import pytest

import orchestrator
import settings
from control.battles import public
from device import adbclient
from flows import shard
from interactions import loadout, tourney
from player import readiness
from player.run_controls import effective_preset
from runtime import battle_source, device_lease, logger
from runtime.battle_session import BattleSession
from scheduling import combo
from towerpilot_workflows.battles import Battles
from towerpilot_workflows.operations import Operations


@pytest.fixture
def setup_driver(tmp_path, monkeypatch):
    cfg = dict(active_instance='main', active_profile=None, preset='farm',
               instances={'main': {'serial': 'synthetic-setup'}},
               loadouts={'manual': {'tier': 1}},
               presets={'base': dict(kind='coin', tier=1, loadout='manual', shopping=[]),
                        'farm': dict(base='base', label='Farm')})
    context = dict(device_key='synthetic-setup-device', instance='main', account=None,
                   serial='synthetic-setup', config=copy.deepcopy(cfg))
    operations = Operations(tmp_path / 'operations.db')
    op, _ = operations.accept('run', context, {})
    op = operations.transition(op['id'], op['revision'], 'running')
    monkeypatch.setenv('TOWER_OPERATION_ID', op['id'])
    monkeypatch.setenv('TOWER_OPERATION_DB', operations.path)
    for key in ('TOWER_BATTLE_ID', 'TOWER_BATTLE_GENERATION', 'TOWER_DEVICE_DELEGATION'):
        monkeypatch.delenv(key, raising=False)
    for module in (settings, combo, orchestrator):
        monkeypatch.setattr(module, 'CONFIG', cfg)
    monkeypatch.setattr(orchestrator, '_battle_session', None)
    monkeypatch.setattr(adbclient, '_HOST', ('127.0.0.1', 5037))
    monkeypatch.setattr(readiness, 'require', lambda *args: None)
    monkeypatch.setattr(tourney, 'ensure_home', lambda: None)
    monkeypatch.setattr(logger, 'shot', lambda *args: None)
    checked, inputs = [], []
    monkeypatch.setattr(shard, 'set_tier', lambda tier: inputs.append(('tier', tier)))
    monkeypatch.setattr(shard, 'start_battle', lambda: inputs.append(('start',)))
    monkeypatch.setattr(shard, 'enter_run', lambda body: inputs.append(('enter', copy.deepcopy(body))))
    monkeypatch.setattr(readiness, 'require', lambda root, cfg, body: checked.append(copy.deepcopy(body)))
    store = Battles(operations.path)
    block = dict(id='today:farm', block='farm', blueprint='farm', preset='farm', kind='coin', count=None)
    report = dict(state='verified', loadout='manual', detail='manual_equipment', reason=None,
                  continued_with_partial=False, modules=[dict(module='synthetic', role='category',
                      state='verified', detail='equipped_slot', reason=None)])
    return SimpleNamespace(cfg=cfg, op=op, operations=operations, store=store, block=block,
                           report=report, monkeypatch=monkeypatch, inputs=inputs, checked=checked)


def delegated_session(d, setup):
    """Use actual spawn preparation; intercept only process creation."""
    captured = {}
    def spawn(args, **kwargs):
        captured.update(kwargs['env'])
        battle = d.store.get(captured['TOWER_BATTLE_ID'])
        assert battle['runtime']['setup'] == setup
        return SimpleNamespace(pid=1, poll=lambda: None)
    d.monkeypatch.setattr(combo.subprocess, 'Popen', spawn)
    combo._block_runner(d.block, 'main', setup=setup)
    for key in ('TOWER_OPERATION_ID', 'TOWER_OPERATION_DB', 'TOWER_BATTLE_ID', 'TOWER_BATTLE_GENERATION'):
        d.monkeypatch.setenv(key, captured[key])
    pinned, _ = battle_source.accepted_source('main')
    session = BattleSession.from_environment(effective_preset(pinned), pinned)
    return session


@pytest.mark.parametrize('partial', [False, True])
def test_combo_handoff_setup_persists_before_launch_and_in_public_history(setup_driver, partial):
    d = setup_driver
    if partial:
        failed = copy.deepcopy(d.report)
        failed.update(state='degraded', reason='Equipped module could not be verified')
        failed['modules'][0].update(state='degraded', reason='Slot not verified')
        exc = tourney.Abort('Synthetic declared-module failure')
        exc.setup = failed
        def apply(name):
            raise exc
    else:
        def apply(name):
            return {'setup': copy.deepcopy(d.report)}
    d.monkeypatch.setattr(loadout, 'apply', apply)
    setup = combo._block_handoff(d.block, 'main')
    assert setup['state'] == ('degraded' if partial else 'verified')
    assert setup['continued_with_partial'] is partial
    assert d.inputs[0] == ('tier', 1)
    assert d.inputs[1][0] == 'enter'
    # Inherited loadout/tier must be shared by readiness, actual entry and
    # freezing; a raw child body contains neither required field.
    assert d.checked == [effective_preset(d.cfg)]
    assert d.inputs[1][1] == d.checked[0]
    session = delegated_session(d, setup)
    frozen = copy.deepcopy(session.battle['envelope'])
    assert 'setup' not in frozen
    assert session.battle['runtime']['setup'] == setup
    setup['state'] = 'changed-after-launch'
    stored = d.store.get(session.battle['id'])
    expected = copy.deepcopy(stored['runtime']['setup'])
    assert public(d.store, stored)['runtime']['setup'] == expected
    session.observe(SimpleNamespace(shop=None), 1)
    session.finish('observed_results', evidence={'last_observed_wave': 100})
    assert public(d.store, d.store.get(stored['id']))['runtime']['setup'] == expected
    status_events = [event for event in d.store.history(stored['id'])
                     if event['kind'] == 'status' and 'setup' in event['status']]
    assert status_events[0]['status']['setup'] == expected
    session.prepare_next()
    assert session.battle['runtime']['setup']['state'] == 'unknown'
    assert session.battle['runtime']['setup']['continued_with_partial'] is False
    assert session.battle['envelope']['preset'] == frozen['preset']
    assert session.battle['envelope']['config'] == frozen['config']
    assert d.store.get(stored['id'])['envelope'] == frozen
    assert d.store.get(stored['id'])['runtime']['setup'] == expected


@pytest.mark.parametrize('refused', [False, True])
def test_direct_coin_setup_reports_before_entry_or_required_refusal(setup_driver, refused):
    from vision import screen
    d = setup_driver
    session = BattleSession(d.store, d.op['id'], effective_preset(d.cfg), d.cfg)
    d.monkeypatch.setattr(orchestrator, '_battle_session', session)
    d.monkeypatch.setattr(orchestrator.capture, 'grab', lambda: 'synthetic-home')
    d.monkeypatch.setattr(screen, 'identify', lambda frame: SimpleNamespace(name='home'))
    def apply(name):
        if refused:
            raise tourney.Abort('Required module unverified')
        return {'setup': copy.deepcopy(d.report)}
    def enter(body):
        assert d.store.get(session.battle['id'])['runtime']['setup'] == d.report
        d.inputs.append(('entered',))
    d.monkeypatch.setattr(loadout, 'apply', apply)
    d.monkeypatch.setattr(shard, 'enter_run', enter)
    orchestrator._prepare_coin_start()
    report = public(d.store, d.store.get(session.battle['id']))['runtime']['setup']
    assert report['state'] == ('degraded' if refused else 'verified')
    assert report['continued_with_partial'] is False
    if refused:
        assert d.inputs == []
        assert report['detail'] == 'setup_refused'
        assert 'Required module unverified' in report['reason']
    else:
        assert d.inputs == [('tier', 1), ('entered',)]


def test_adopting_delegated_battle_does_not_replace_exact_setup_evidence(setup_driver):
    from vision import screen
    d = setup_driver
    session = delegated_session(d, d.report)
    d.monkeypatch.setattr(orchestrator, '_battle_session', session)
    d.monkeypatch.setattr(orchestrator.capture, 'grab', lambda: 'live-battle')
    d.monkeypatch.setattr(screen, 'identify', lambda frame: SimpleNamespace(name='battle'))
    d.monkeypatch.setattr(loadout, 'apply', lambda *args: pytest.fail('Adoption changed equipment'))
    orchestrator._prepare_coin_start()
    assert d.store.get(session.battle['id'])['runtime']['setup'] == d.report


def test_as_is_and_unproven_adoption_are_unknown(setup_driver):
    d = setup_driver
    body = effective_preset(d.cfg)
    body['loadout'] = None
    session = BattleSession(d.store, d.op['id'], body, d.cfg, origin='adopted')
    report = session.battle['runtime']['setup']
    assert report['state'] == 'unknown' and report['detail'] == 'adopted'
    assert report['modules'] == [] and report['continued_with_partial'] is False


def test_unsupported_shard_report_does_not_create_battle_history(setup_driver):
    d = setup_driver
    d.cfg['presets']['shards'] = dict(kind='shard', loadout='manual', tier=1)
    block = dict(d.block, preset='shards', kind='shard', count=1)
    d.monkeypatch.setattr(combo.subprocess, 'Popen', lambda *args, **kwargs: SimpleNamespace(pid=1))
    combo._block_runner(block, 'main', setup=d.report)
    assert d.store.list() == []


@pytest.mark.parametrize('refused', [False, True])
def test_direct_tournament_main_passes_durable_setup_callback(setup_driver, refused):
    d = setup_driver
    d.cfg['presets']['farm'] = dict(kind='tournament', tournament_setup=True, tier=1, loadout='manual')
    d.cfg['loop'] = {'fps': 1, 'dry_run': True}
    d.monkeypatch.setattr(orchestrator.capture, 'grab', lambda: 'synthetic-home')
    d.monkeypatch.setattr(orchestrator.wave_reader, 'read_wave', lambda frame: None)
    d.monkeypatch.setattr(orchestrator, 'RunState', lambda: SimpleNamespace())
    d.monkeypatch.setattr(tourney, '_in_battle', lambda frame: False)
    expected = copy.deepcopy(d.report)
    if refused:
        expected = loadout.setup_failure('manual', tourney.Abort('Required tournament module unverified'))
    class SetupFinished(Exception):
        pass
    def setup(*, on_setup):
        on_setup(expected)
        assert d.store.active()[0]['runtime']['setup'] == expected
        if refused:
            raise tourney.Abort('Required tournament module unverified')
        raise SetupFinished('Stop before observe loop')
    d.monkeypatch.setattr(tourney, 'setup', setup)
    if refused:
        orchestrator.main()
    else:
        with pytest.raises(SetupFinished):
            orchestrator.main()
    battle = d.store.active()[0]
    assert public(d.store, battle)['runtime']['setup'] == expected
    assert expected['continued_with_partial'] is False
