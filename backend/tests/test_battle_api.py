"""Saved and live HTTP transactions use temporary profiles and real SQLite."""
import copy
import importlib.util
from pathlib import Path

import pytest
import yaml

from control import battles, operations
from player.run_controls import resolve


@pytest.fixture
def dash(tmp_path, monkeypatch):
    source = Path(__file__).resolve().parents[2] / 'frontend' / 'dashboard.py'
    spec = importlib.util.spec_from_file_location('battle_dashboard_test', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / 'profiles').mkdir()
    cfg = dict(active_instance='main', active_profile='mine', preset='bp_farm',
               instances={'main': {'serial': 'fake:1'}, 'other': {'serial': 'fake:2'}},
               loadouts={}, presets={})
    profile = dict(player={}, blueprints={
        'farm': {'kind': 'coin', 'tier': 1, 'loadout': 'as_is', 'policies': {'gather': 'shared'}},
        'other': {'kind': 'coin', 'tier': 1, 'loadout': 'as_is', 'policies': {'gather': 'shared'}}},
        policies={'gather': {'shared': {'ad_gems': True, 'gem_delay_sec': [3, 10]}}})
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(cfg))
    (tmp_path / 'profiles' / 'mine.yaml').write_text(yaml.safe_dump(profile))
    monkeypatch.setattr(module, 'ROOT', str(tmp_path))
    monkeypatch.setattr(module, 'CONFIG_PATH', str(tmp_path / 'config.yaml'))
    monkeypatch.setattr(operations, 'worker_alive', lambda worker: True)
    return module


def live(dash):
    cfg = dash.load_config()
    context = operations.context(dash.ROOT, cfg, {'preset': 'bp_farm'}, None)
    operation, _ = operations.ledger(dash.ROOT).accept('run', context, {})
    operation = operations.ledger(dash.ROOT).transition(operation['id'], operation['revision'], 'running')
    store = battles.ledger(dash.ROOT)
    preset = {'tier': 1, 'gather': {'ad_gems': True}, 'label': 'Farm'}
    envelope = {'preset': preset, 'controls': resolve(preset, cfg), 'config': cfg, 'profile': {'private': True}}
    battle = store.create(operation['id'], context, envelope, generation='driver')
    battle = store.activate(battle['id'], 'driver', {
        'controls': ['routines.ad_gems.enabled'], 'actions': ['ad_gems']})
    return store, operation, battle


def test_saved_controls_isolated_revisioned_and_return_effective_settings(dash):
    client = dash.app.test_client()
    before = client.get('/api/run-controls?blueprint=farm').get_json()
    response = client.post('/api/run-controls', json={
        'blueprint': 'farm', 'context': before['context'], 'expected_revision': before['profile_revision'],
        'changes': {'routines.ad_gems.enabled': False}})
    assert response.status_code == 200, response.get_json()
    after = response.get_json()
    assert after['settings']['routines']['ad_gems']['enabled'] is False
    assert after['profile_revision'] != before['profile_revision']
    stored = yaml.safe_load(Path(dash.ROOT, 'profiles', 'mine.yaml').read_text())
    assert '_name' not in stored
    assert stored['policies']['gather']['shared']['ad_gems'] is True
    assert client.get('/api/run-controls?blueprint=other').get_json()['settings']['routines']['ad_gems']['enabled'] is True
    assert client.post('/api/run-controls', json={
        'blueprint': 'farm', 'context': before['context'], 'expected_revision': before['profile_revision'],
        'changes': {'routines.ad_gems.enabled': True}}).status_code == 409


def test_live_patch_does_not_edit_profile_or_claim_applied(dash):
    store, operation, battle = live(dash)
    profile_path = Path(dash.ROOT, 'profiles', 'mine.yaml')
    original = profile_path.read_bytes()
    client = dash.app.test_client()
    active = client.get('/api/battles/active').get_json()['battle']
    assert 'config' not in active['envelope'] and 'profile' not in active['envelope']
    body = dict(battle_id=battle['id'], generation='driver', expected_revision=0,
                idempotency_key='control', changes={'routines.ad_gems.enabled': False})
    url = f"/api/operations/{operation['id']}/live-controls"
    response = client.post(url, json=body)
    assert response.status_code == 200, response.get_json()
    result = response.get_json()
    assert result['battle']['control_revision'] == 1
    assert result['battle']['applied_revision'] == 0
    assert result['battle']['effective']['routines']['ad_gems']['enabled'] is True
    assert result['battle']['requested_controls']['routines']['ad_gems']['enabled'] is False
    assert profile_path.read_bytes() == original
    assert client.post(url, json=body).get_json()['command']['id'] == result['command']['id']
    store.acknowledge(battle['id'], 'driver', result['command']['id'])
    active = client.get('/api/battles/active').get_json()['battle']
    assert active['applied_revision'] == 1
    assert active['effective']['routines']['ad_gems']['enabled'] is False
    wrong = copy.deepcopy(body)
    wrong.update(generation='old', idempotency_key='stale', expected_revision=1)
    assert client.post(url, json=wrong).status_code == 409


def test_actions_history_and_interrupted_observation(dash):
    store, operation, battle = live(dash)
    client = dash.app.test_client()
    body = dict(battle_id=battle['id'], generation='driver', expected_revision=0,
                idempotency_key='action', action='ad_gems')
    response = client.post(f"/api/operations/{operation['id']}/actions", json=body)
    assert response.status_code == 200
    command = response.get_json()['command']
    store.acknowledge(battle['id'], 'driver', command['id'], state='started')
    assert client.get('/api/battles/active').get_json()['battle']['commands'][0]['state'] == 'started'
    operations.ledger(dash.ROOT).transition(operation['id'], operation['revision'], 'failed')
    assert client.get('/api/battles/active').get_json()['battle'] is None
    history = client.get('/api/battles').get_json()['battles']
    assert history[0]['status'] == 'interrupted' and history[0]['result'] == 'unknown'
    detail = client.get(f"/api/battles/{battle['id']}").get_json()
    assert detail['events'][-1]['kind'] == 'interrupted'
    assert detail['battle']['commands'][0]['state'] == 'expired'
    assert client.get('/api/battles?limit=0').status_code == 400


def test_launch_freezes_compiled_settings_and_retry_uses_original_envelope(dash, monkeypatch):
    cfg = dash.load_config()
    cfg['presets'] = dash._compiled_runs(cfg)
    calls = []
    def launch(root, config, kind, body, cmd, popen, **kwargs):
        calls.append(copy.deepcopy(body))
        return body
    monkeypatch.setattr(operations, 'launch', launch)
    dash._launch_operation(cfg, 'run', {'preset': 'bp_farm'}, ['python', 'orchestrator.py'])
    envelope = calls[0]['battle_envelope']
    assert envelope['preset']['tier'] == 1
    assert envelope['profile']['blueprints']['farm']['tier'] == 1
    assert envelope['config']['preset'] == 'bp_farm'
    assert envelope['source_revision'] == operations.file_revision(Path(dash.ROOT, 'profiles', 'mine.yaml'))
    cfg['presets']['bp_farm']['tier'] = 2
    assert envelope['preset']['tier'] == 1
