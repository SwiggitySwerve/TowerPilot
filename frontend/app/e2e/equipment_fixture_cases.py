"""Generate supplemental Equipment reads by calling real routes in the existing isolated world.

The published page family has no GET of a manual/global loadout or of the discovered
inventory used by its saves. These samples add those browser states without inventing
backend answers. Run from the repository root:
python -m pytest frontend/app/e2e/equipment_fixture_cases.py
"""
import copy
import json
from pathlib import Path

from conftest import dash  # noqa: F401 - pytest fixture, temporary backend root
from dashboard_contract_cases_editors import equipped
from dashboard_contract_pages_world import PagesGenerator
from test_dashboard_contract import scrub


def test_generate_equipment_samples(tmp_path, monkeypatch, dash):
    gen = PagesGenerator(dash, tmp_path / 'equipment', monkeypatch)
    family = 'equipment_samples'
    for scenario in ('mixed', 'manual', 'missing', 'empty', 'long'):
        with gen.world(scenario) as w:
            loadouts = {
                'plain': {}, 'spare': {'cards': 'no_card'}, 'later': {'defined': False},
            }
            if scenario in ('mixed', 'manual', 'long'):
                loadouts['plain'] = {'cards': 'main_farm', 'modules': [['amplifying_strike', 'attack']],
                                     'guardians': ['bounty', 'fetch']}
            if scenario in ('mixed', 'long'):
                loadouts.update(global_choice={'global_preset': 'Farm Run'},
                                categories={'module_preset': 'Farm', 'guardian_preset': 'Farm'},
                                untouched={})
            if scenario == 'missing':
                loadouts['plain'] = {'cards': 'undiscovered_saved_choice'}
            equipped(w, loadouts=loadouts)
            if scenario == 'empty':
                w.edit_config(lambda cfg: cfg.update(loadouts={}))
            if scenario == 'long':
                def long_consumers(profile):
                    run = copy.deepcopy(profile['blueprints']['farm_deep'])
                    for label in ('x', 'A long saved run label ' * 5, 'unbreakable' * 40, 'RTL-\u0645\u062b\u0627\u0644-' * 12):
                        profile['blueprints'][label] = copy.deepcopy(run)
                w.edit_profile(long_consumers)
            first = w.get(family, f'{scenario}_config', '/api/config').get_json()
            w.get(family, f'{scenario}_profile', '/api/profile-src/mine')
            if scenario not in ('manual', 'mixed'):
                continue
            revision = first['config_revision']
            steps = (
                ('global', {'global_preset': 'Farm Run'}),
                ('categories', {'module_preset': 'Farm', 'guardian_preset': 'Farm'}),
                ('cards', {'cards': 'main_farm'}),
                ('workshop_bots', {'workshop_preset': 'Full Upgraded', 'bot_preset': 'Farm'}),
            )
            for name, body in steps:
                reply = w.post(family, f'{scenario}_{name}_saved', '/api/loadout-patch',
                               dict(name='plain', body=body, expected_revision=revision))
                assert reply.status_code == 200, reply.get_json()
                revision = reply.get_json()['config_revision']
                w.get(family, f'{scenario}_{name}_readback', '/api/config')
                w.get(family, f'{scenario}_{name}_profile', '/api/profile-src/mine')
    # Arbitrary user-owned names must work even when strict fixture schemas have never seen them.
    # Keep this family out of the sample descriptor to exercise the tolerant runtime boundary.
    with gen.world('edge') as w:
        equipped(w, loadouts={'plain': {}, 'constructor': {}, 'toString': {}, '__proto__': {}})
        first = w.get('equipment_edge', 'config', '/api/config').get_json()
        w.get('equipment_edge', 'profile', '/api/profile-src/mine')
        reply = w.post('equipment_edge', 'saved', '/api/loadout-patch', dict(
            name='constructor', body={'global_preset': 'Farm Run'}, expected_revision=first['config_revision']))
        assert reply.status_code == 200, reply.get_json()
        saved = w.get('equipment_edge', 'readback', '/api/config').get_json()
        same = w.post('equipment_edge', 'noop_saved', '/api/loadout-patch', dict(
            name='constructor', body={'global_preset': 'Farm Run'}, expected_revision=saved['config_revision']))
        assert same.status_code == 200, same.get_json()
        assert same.get_json()['config_revision'] == saved['config_revision']
        w.get('equipment_edge', 'noop_readback', '/api/config')
        current = same.get_json()['config_revision']
        proto = w.post('equipment_edge', 'proto_saved', '/api/loadout-patch', dict(
            name='__proto__', body={'global_preset': 'Farm Run'}, expected_revision=current))
        assert proto.status_code == 200, proto.get_json()
        w.get('equipment_edge', 'proto_readback', '/api/config')
    assert len(gen.cases[family]) == 34
    # These are unmodified recorded answers from the backend author's r10 candidate.
    # The snapshot records the original fixture hash and case aliases; no new answer is invented.
    context_fixture = Path(__file__).with_name('equipment-context-r10.json')
    context_samples = json.loads(context_fixture.read_text(encoding='utf-8'))
    for name, case in context_samples['cases']['equipment_context'].items():
        gen.cases[family][name] = copy.deepcopy(case)
    document = scrub(dict(version=1, generated_by='frontend/app/e2e/equipment_fixture_cases.py', cases=gen.cases), gen.base)
    destination = Path(__file__).with_name('equipment-samples.json')
    destination.write_text(json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + '\n', encoding='utf-8')
