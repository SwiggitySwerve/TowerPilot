"""A new action needs a catalog entry and a binding, and nothing else (roadmap item 6, A2-6 - the recording, projection and
read-route half of the synthetic proof; deriving the live-control and Run-now dispatch from the catalog is the part
of A2-6 this batch does not finish).

`synthetic_probe` is registered, twice, only in a COPY of the catalog inside this test. It is named in no other file
of the checkout, and no route, endpoint or dashboard branch changes.
"""
import importlib.util
from pathlib import Path

import pytest
import yaml

from control import operations
from harvest_support import fake_inspect
from runtime.action_session import ActionSession
from towerpilot_workflows.action_contract import CATALOG, ActionDefinition, Capabilities, Field, StartToStart
from towerpilot_workflows.actions import Actions

REPO = Path(__file__).resolve().parents[2]
CONTEXT = dict(device_key='device', account='account', instance='main', serial='fake', profile='mine')


@pytest.fixture
def catalog():
    copy = CATALOG.copy()
    copy.register(ActionDefinition(
        id='synthetic_probe', label='Synthetic probe', family='gems', hosts=frozenset({'test'}), schedule=StartToStart(),
        fields=(Field('enabled', 'bool', label='Enabled'), Field('interval_sec', 'number', 10, 600, 's', 'Interval')),
        capabilities=Capabilities(live_controls=True, pause=True, run_now=True, variants=True)))
    return copy


def test_a_registered_action_is_recorded_projected_and_listed_per_configured_instance_with_no_new_route(tmp_path, catalog):
    session = ActionSession(tmp_path / 'operations.db', context=CONTEXT, driver='test', catalog=catalog)
    for instance in ('probe_a', 'probe_b'):                                  # one definition, two configured instances
        recorder = session.recorder('synthetic_probe', instance)
        recorder.opened(trigger='manual', occurrence_key=f'window:{instance}')
        recorder.closed(result='succeeded', reason='proved', effect='confirmed', attempts=1, confirmed=1, evidence=['proved'])
    stored = Actions.read(session.path, device='device')[0]
    assert sorted((row['action'], row['instance']) for row in stored) == [('synthetic_probe', 'probe_a'), ('synthetic_probe', 'probe_b')]
    projected = session.project({'synthetic_probe@probe_a': dict(enabled=True, state='scheduled', next_due_at=1.0, counters={}),
                                 'synthetic_probe@probe_b': dict(enabled=False, state='off', next_due_at=None)},
                                variants={'probe_a': ['probe:one', 'probe:two']})
    items = {item['instance']: item for item in projected['items']}
    assert set(items) == {'probe_a', 'probe_b'} and items['probe_a']['id'] == 'synthetic_probe'
    assert [field['path'] for field in items['probe_a']['descriptor']['fields']] == ['enabled', 'interval_sec']
    assert items['probe_a']['descriptor']['capabilities']['run_now'] is True
    assert [v['token'] for v in items['probe_a']['descriptor']['variants']] == ['probe:one', 'probe:two']
    assert items['probe_a']['state'] == 'due' and items['probe_b']['state'] == 'disabled'
    assert items['probe_a']['last']['result'] == 'succeeded' and items['probe_a']['next']['basis'] == 'start_to_start'
    assert 'synthetic_probe' not in CATALOG and set(catalog.control_fields()) >= {'synthetic_probe'}


def test_the_generic_read_route_lists_the_new_actions_history_without_a_change_to_the_dashboard(tmp_path, monkeypatch, catalog):
    source = REPO / 'frontend' / 'dashboard.py'
    spec = importlib.util.spec_from_file_location('synthetic_dashboard_test', source)
    dash = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dash)
    cfg = dict(active_instance='main', active_profile='mine', preset='bp_farm',
               instances={'main': {'serial': 'fake:1'}}, loadouts={}, presets={})
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(cfg))
    monkeypatch.setattr(dash, 'ROOT', str(tmp_path))
    monkeypatch.setattr(dash, 'CONFIG_PATH', str(tmp_path / 'config.yaml'))
    monkeypatch.setattr(operations, 'inspect_worker', fake_inspect(lambda worker: True))
    routes = sorted((rule.rule, rule.endpoint) for rule in dash.app.url_map.iter_rules())
    with dash.app.test_request_context('/'):
        selected = dash._battle_history_context()
    session = ActionSession(operations.ledger_path(dash.ROOT), context=dict(CONTEXT, **{k: selected[k] for k in ('device_key', 'account')}),
                            driver='test', catalog=catalog)
    session.recorder('synthetic_probe', 'probe_a').record(result='no_op', reason='nothing_due', trigger='automatic')
    body = dash.app.test_client().get('/api/actions/executions?action=synthetic_probe').get_json()
    assert [(row['action'], row['instance'], row['state']) for row in body['executions']] == [('synthetic_probe', 'probe_a', 'no_op')]
    assert sorted((rule.rule, rule.endpoint) for rule in dash.app.url_map.iter_rules()) == routes


def test_the_synthetic_action_is_named_in_no_production_file():
    for path in list((REPO / 'backend').rglob('*.py')) + [REPO / 'frontend' / 'dashboard.py']:
        if 'tests' in path.parts or '.venv' in path.parts or 'logs' in path.parts:
            continue
        assert 'synthetic_probe' not in path.read_text(encoding='utf-8', errors='ignore'), path