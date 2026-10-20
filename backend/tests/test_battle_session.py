"""Driver checkpoints and collector timer edits, without device input."""
import copy
from types import SimpleNamespace

import pytest

from flows.shard import GemWatch, GemOrbitTapper
from interactions.ad_gems import AdGemCollector
from interactions.shopper import Shopper
from runtime.battle_session import BattleSession
from towerpilot_workflows.operations import Operations
from towerpilot_workflows.battles import Battles


@pytest.fixture
def driver(tmp_path, monkeypatch):
    from runtime import logger
    monkeypatch.setattr(logger, 'event', lambda *args, **kwargs: None)
    path = tmp_path/'operations.db'
    context = dict(device_key='device', account='account', instance='main', serial='fake')
    operation, _ = Operations(path).accept('farm', context, {})
    body = dict(gather={'ad_gems': True, 'quests_8h': True, 'gem_orbit': {'enabled': False}}, shopping=[], shop_interval_sec=90)
    session = BattleSession(Battles(path), operation['id'], body, {})
    rs = SimpleNamespace(gems=GemWatch(body['gather']), shop=Shopper(body), mission=SimpleNamespace(active=False),
        shopping_enabled=False, rewards_enabled=True, repeat_enabled=True,
        tracker=SimpleNamespace(last=123), last_shop=0)
    session.observe(rs, 123)
    return session, rs, operation


def test_control_applies_at_checkpoint_and_owned_reward_flow_drains(driver):
    session, rs, operation = driver
    rs.mission.active = True
    command = session.store.request_controls(session.battle['id'], operation['id'], session.generation, 0,
        {'routines': {'ad_gems': {'enabled': False}, 'rewards': {'enabled': False}}}, 'pause')
    assert rs.gems.ad_gems.enabled is True
    session.checkpoint(rs, battle_visible=False)
    assert rs.gems.ad_gems.enabled is False
    assert rs.rewards_enabled is True
    persisted = session.store.get(session.battle['id'])
    assert persisted['applied_revision'] == 0
    pending = session.store.pending_commands(session.battle['id'], session.generation)
    assert pending[0]['reason'] == 'finishing_owned_flow'
    assert pending[0]['applied_paths'] == ['routines.ad_gems.enabled']
    rs.mission.active = False
    session.checkpoint(rs, battle_visible=True)
    assert rs.rewards_enabled is False
    assert session.store.get(session.battle['id'])['applied_revision'] == command['revision']
    assert session.effective_preset()['gather']['ad_gems'] is True


def test_manual_disabled_collector_waits_for_safe_screen_then_records_real_window(driver, monkeypatch):
    from interactions import ad_gems
    session, rs, operation = driver
    rs.gems.ad_gems.enabled = False
    command = session.store.request_action(session.battle['id'], operation['id'], session.generation, 'ad_gems', 'once')
    session.checkpoint(rs, battle_visible=False)
    assert not rs.gems.ad_gems.manual_requested
    session.checkpoint(rs, battle_visible=True)
    assert rs.gems.ad_gems.manual_requested
    assert session.store.pending_commands(session.battle['id'], session.generation)[0]['state'] == 'requested'
    monkeypatch.setattr(ad_gems.wave_reader, 'read_wave', lambda frame: None)
    rs.gems.ad_gems.poll(None)  # no input: unreadable frame still starts bounded window
    session.checkpoint(rs, battle_visible=True)
    assert session.store.pending_commands(session.battle['id'], session.generation)[0]['state'] == 'started'
    rs.gems.ad_gems._close_window('timeout')
    session.checkpoint(rs, battle_visible=True)
    assert not session.store.pending_commands(session.battle['id'], session.generation)
    events = session.store.events(session.battle['id'])
    completed = [e['command'] for e in events if e['kind'] == 'command_acknowledged' and e['command']['state'] == 'completed']
    assert completed[-1]['id'] == command['id']
    assert completed[-1]['evidence']['confirmed'] is False
    assert rs.gems.ad_gems.enabled is False


def test_new_battle_discards_overrides_and_old_commands(driver):
    session, rs, operation = driver
    frozen = copy.deepcopy(session.battle['envelope'])
    old_id = session.battle['id']
    session.store.request_controls(old_id, operation['id'], session.generation, 0,
        {'routines': {'ad_gems': {'enabled': False}}}, 'pause')
    session.checkpoint(rs, battle_visible=True)
    session.finish('observed_results')
    session.prepare_next()
    assert session.battle['id'] != old_id
    assert session.battle['overrides'] == {}
    assert session.battle['applied_controls']['routines']['ad_gems']['enabled'] is True
    assert session.store.get(old_id)['envelope'] == frozen


def test_queue_edit_cannot_enable_frozen_disabled_shopping(driver):
    from player.shopping_plan import default_plan
    session, rs, operation = driver
    plan = default_plan()
    session.finish('test_boundary')
    body = session.effective_preset()
    body['shopping_plan'] = plan
    body['automation'] = {'shopping': False}
    session.prepare_next(body)
    rs.shop = Shopper(body)
    rs.shopping_enabled = False
    session.observe(rs, 123)
    edited = copy.deepcopy(plan)
    edited['queue'] = [{'id': 'damage', 'enabled': True, 'tap_limit': 1, 'from_wave': 1, 'until_wave': None}]
    command = session.store.request_controls(session.battle['id'], operation['id'], session.generation, 0,
        {'shopping_plan': edited}, 'queue_edit')
    session.checkpoint(rs, battle_visible=True)
    assert rs.shopping_enabled is False
    assert session.effective_preset()['shopping_plan']['enabled'] is False
    assert rs.shop.plan['enabled'] is False
    battle = session.store.get(session.battle['id'])
    assert battle['applied_controls']['routines']['shopping']['enabled'] is False
    assert battle['applied_revision'] == command['revision']


def test_collector_only_driver_never_advertises_other_gates(driver):
    session, rs, _ = driver
    rs.shop = rs.mission = None
    capabilities = session.capabilities(rs)
    assert capabilities['actions'] == ['ad_gems', 'floating_gems']
    assert all(path.startswith(('routines.ad_gems.', 'routines.floating_gems.')) for path in capabilities['controls'])
    session.publish(rs, battle_visible=False)


def test_ability_rescue_gates_are_independent_and_reenable_reobserves_weapons(driver):
    session, rs, operation = driver
    rs.cl_normalized = rs.uw_normalized = True
    rs.uw_done = {'chain_lightning'}
    rs.dm_fired = True
    command = session.store.request_controls(session.battle['id'], operation['id'], session.generation, 0,
        {'routines': {'abilities': {'enabled': False}, 'rescue': {'enabled': False}}}, 'abilities_off')
    session.checkpoint(rs, battle_visible=True)
    assert session.gates['abilities'] is session.gates['rescue'] is False
    session.store.request_controls(session.battle['id'], operation['id'], session.generation, command['revision'],
        {'routines': {'abilities': {'enabled': True}}}, 'abilities_on')
    session.checkpoint(rs, battle_visible=True)
    assert session.gates['abilities'] is True
    assert session.gates['rescue'] is False
    assert rs.cl_normalized is rs.uw_normalized is False
    assert rs.uw_done == set()
    assert rs.dm_fired is True


def test_disabled_ability_and_rescue_helpers_refuse_before_any_observation_or_input(monkeypatch):
    import orchestrator
    monkeypatch.setattr(orchestrator, '_battle_session', None)
    monkeypatch.setattr(orchestrator, 'preset', lambda: {'automation': {'abilities': False, 'rescue': False}})
    def forbidden(*args, **kwargs):
        raise AssertionError('Disabled gate reached a device/recognition helper')
    monkeypatch.setattr(orchestrator.detect, 'button_state', forbidden)
    monkeypatch.setattr(orchestrator.capture, 'grab', forbidden)
    assert orchestrator.fire_button(None, 'nuke', 'fleet_2495') is False
    assert orchestrator.fire_button(None, 'demon_mode', 'rescue', routine='rescue') is False
    assert orchestrator._fast_wall_watch(None, {}) == 'disabled'
    assert orchestrator._rule_toggle_uw(None, {}) == (False, False)
    assert orchestrator._rule_act(None, None, 0, 'rule', 'burst', {}) == (False, False)


@pytest.mark.parametrize('kind', ['ad', 'orbit'])
def test_timer_numeric_changes_keep_anchor_and_completed_window_closed(kind, monkeypatch):
    from interactions import ad_gems
    from flows import shard
    clock = [100.0]
    monkeypatch.setattr(ad_gems.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(ad_gems.logger, 'event', lambda *args, **kwargs: None)
    monkeypatch.setattr(shard.logger, 'event', lambda *args, **kwargs: None)
    collector = AdGemCollector() if kind == 'ad' else GemOrbitTapper(enabled=True)
    collector.last_window_started_at = 90.0
    collector.next_window_at = 810.0
    collector.configure({'interval_sec': 800, 'enabled': False})
    assert collector.next_window_at == 890
    collector.configure({'enabled': True, 'window_sec': 60})
    assert collector.next_window_at == 890
    assert collector.status()['window_ends_at'] is None
    if kind == 'ad':
        collector.window_started_at = 100
        collector.window_deadline = 160
    else:
        collector.attempt_started = 100
        collector.window_ends_at = 160
    collector.configure({'window_sec': 10})
    end = collector.window_deadline if kind == 'ad' else collector.window_ends_at
    assert end == 110
    collector.configure({'window_sec': 60})
    assert (collector.window_deadline if kind == 'ad' else collector.window_ends_at) == 110
    clock[0] = 111
    collector.configure({'enabled': False})
    assert collector.status()['window_ends_at'] is None
    collector.configure({'window_sec': 60, 'enabled': True})
    assert collector.status()['window_ends_at'] is None
    assert collector.next_window_at == 890


def test_raw_control_acknowledgements_emit_only_actual_progress(driver, monkeypatch):
    from runtime import logger
    session, rs, operation = driver
    emitted = []
    monkeypatch.setattr(logger, 'event', lambda kind, **fields: emitted.append((kind, fields)))
    rs.mission.active = True
    command = session.store.request_controls(session.battle['id'], operation['id'], session.generation, 0,
        {'routines': {'ad_gems': {'enabled': False}, 'rewards': {'enabled': False}}}, 'raw-control')
    session.checkpoint(rs, battle_visible=True)
    session.checkpoint(rs, battle_visible=True)
    rs.mission.active = False
    session.checkpoint(rs, battle_visible=True)
    session.checkpoint(rs, battle_visible=True)
    acks = [fields for kind, fields in emitted if kind == 'battle_command_acknowledged']
    assert [ack['state'] for ack in acks] == ['pending', 'applied']
    assert acks[0]['reason'] == 'finishing_owned_flow'
    assert acks[0]['applied_paths'] == ['routines.ad_gems.enabled']
    assert acks[1]['applied_paths'] == ['routines.ad_gems.enabled', 'routines.rewards.enabled']
    for ack in acks:
        assert ack['command_id'] == command['id']
        assert ack['revision'] == command['revision']
        assert ack['operation_id'] == operation['id']
        assert ack['battle_id'] == session.battle['id']


def test_raw_manual_acknowledgements_join_collector_window_and_terminal_outcome(driver, monkeypatch):
    from runtime import logger
    session, rs, operation = driver
    emitted = []
    monkeypatch.setattr(logger, 'event', lambda kind, **fields: emitted.append((kind, fields)))
    state = dict(enabled=False, manual_pending=True, manual_active=False,
                 last_outcome=None, window_id=None)
    rs.gems.ad_gems = SimpleNamespace(request_now=lambda: True, status=lambda: dict(state))
    command = session.store.request_action(session.battle['id'], operation['id'], session.generation,
                                           'ad_gems', 'raw-action')
    session.checkpoint(rs, battle_visible=True)
    state.update(manual_pending=False, manual_active=True, window_id='window', offer_id='offer', claim_attempt_id='claim')
    session.checkpoint(rs, battle_visible=True)
    session.checkpoint(rs, battle_visible=True)
    state.update(manual_active=False, last_outcome=dict(confirmed=False, reason='timeout', window_id='window',
                                                       offer_id='offer', claim_attempt_id='claim'))
    session.checkpoint(rs, battle_visible=True)
    session.checkpoint(rs, battle_visible=True)
    acks = [fields for kind, fields in emitted if kind == 'battle_command_acknowledged']
    assert [ack['state'] for ack in acks] == ['started', 'completed']
    assert acks[1]['outcome'] == 'unconfirmed'
    assert acks[1]['reason'] == 'timeout'
    for ack in acks:
        assert ack['command_id'] == command['id']
        assert ack['battle_id'] == session.battle['id'] and ack['operation_id'] == operation['id']
        assert ack['window_id'] == 'window' and ack['offer_id'] == 'offer'
        assert ack['claim_attempt_id'] == 'claim'
    persisted = session.store.commands(session.battle['id'])
    assert persisted[-1]['state'] == 'completed'
    assert persisted[-1]['evidence'] == state['last_outcome']


def test_raw_shopping_acknowledgements_join_the_sweep_without_device_input(driver, monkeypatch):
    from player.shopping_plan import normalize_plan
    from runtime import logger
    session, rs, operation = driver
    session.finish('configure_test_shopping')
    body = session.effective_preset()
    body['shopping_plan'] = normalize_plan(dict(version=2, enabled=False, queue=[{'id': 'health'}]))
    session.prepare_next(body)
    rs.shop = Shopper(body)
    session.observe(rs, 123)
    emitted = []
    monkeypatch.setattr(logger, 'event', lambda kind, **fields: emitted.append((kind, fields)))
    command = session.store.request_action(session.battle['id'], operation['id'], session.generation,
                                           'shopping:defense:health', 'raw-shopping')
    session.checkpoint(rs, battle_visible=True)
    sweep_id = rs.shop.status()['sweep_id']
    rs.shop.abort()
    session.checkpoint(rs, battle_visible=True)
    session.checkpoint(rs, battle_visible=True)
    acks = [fields for kind, fields in emitted if kind == 'battle_command_acknowledged']
    assert [ack['state'] for ack in acks] == ['started', 'completed']
    assert acks[1]['outcome'] == 'aborted'
    assert all(ack['sweep_id'] == sweep_id and ack['command_id'] == command['id'] for ack in acks)
    assert session.store.commands(session.battle['id'])[-1]['state'] == 'completed'
