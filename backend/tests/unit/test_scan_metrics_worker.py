"""The calibration worker records its measurements through the real phase loop and the real operation sealing (roadmap item 9, spec 3.1).

Everything the loop touches on a device is faked at the module boundary (display, capture, preflight, the phases themselves); the loop in
player/calibrate.py, the recorder, the ledger and the sealing in runtime/operations.py are the real ones. The root the worker runs from is a temporary
folder (settings.ROOT is <tmp>/backend, so the identity reads <tmp>/backend/logs/scan_sides.json), so no outcome depends on the machine.
"""
import copy
import hashlib
import json
import platform
import sys
from pathlib import Path

import numpy as np
import pytest

import settings
from control import operations as service
from device import capture
from interactions import tourney
from player import bootstrap, calibrate, card_inventory, module_roundtrip, scan_plan
from runtime import device_lease, operations, scan_identity, scan_metrics
from runtime.files import atomic_json
from runtime.operations import Operations, worker_operation
from vision import textocr

RENDERING = {'width': 1080, 'height': 2560, 'dpi': 360}


def config(account=None):
    instance = {'serial': 'fake:1', 'rendering': dict(RENDERING)}
    cfg = dict(active_instance='main', active_profile='mine', instances={'main': instance})
    if account:
        instance['account'] = account
        cfg['accounts'] = {account: {'label': 'Mine', 'active_profile': 'mine', 'loadouts': {}}}
    return cfg


def context(tmp_path, cfg):
    profile = tmp_path / 'profiles' / 'mine.yaml'
    profile.parent.mkdir(exist_ok=True)
    profile.write_text('player: {}\n')
    return service.context(tmp_path / 'backend', cfg, {}, str(profile))


CARDS = {'card_presets': ['a'] * 5, 'names': ['a'] * 5, 'inventory': {'complete': True, 'cards': [{}] * 31, 'pages': 7, 'unreadable_tiles': 0, 'active': 20, 'mastered': 0}}
MODULES = {'modules_equipped': ['a'] * 4, 'modules_in_grid': ['a'] * 26, 'copies': 52, 'preset_tabs': ['a'] * 2}


@pytest.fixture
def worker(tmp_path, monkeypatch, request):
    """A tracked calibration worker whose device is faked: returns (run(argv, phases, ...), calibration folder). Unbound by default; indirect parameter = an account name."""
    cfg = config(getattr(request, 'param', None))
    ctx = context(tmp_path, cfg)
    store = Operations(tmp_path / 'ops.db')
    folder = Path(ctx['artifact_dir'])
    folder.mkdir(parents=True)
    paths = {'state': str(folder / 'calibrate_state.json'), 'stop': str(folder / 'calibrate_stop'), 'report': str(folder / 'calibrate_report.json'),
             'metrics': str(folder / 'calibrate_metrics.json'), 'evidence': str(folder / 'calibrate_evidence')}
    monkeypatch.setattr(settings, 'ROOT', tmp_path / 'backend')
    monkeypatch.setattr(settings, 'CONFIG', copy.deepcopy(cfg))
    monkeypatch.setattr(calibrate, '_paths', lambda: paths)
    monkeypatch.setattr(calibrate, '_prepare_display', lambda: None)
    monkeypatch.setattr(calibrate, '_merge_draft', lambda player: 'draft')
    monkeypatch.setattr(operations, 'restore_worker_context', lambda *args, **kwargs: None)
    monkeypatch.setattr(settings, 'bind_device', lambda name: None)
    monkeypatch.setattr(settings, 'instance', lambda: {})
    monkeypatch.setitem(settings.CONFIG, 'preset', 'normal_run')
    monkeypatch.setattr(device_lease, 'ensure_current', lambda: None)
    monkeypatch.setattr(bootstrap, 'preflight', lambda: None)
    monkeypatch.setattr(bootstrap, 'screen_matches', lambda frame, lines, name: True)
    monkeypatch.setattr(capture, '_grab', lambda *args, **kwargs: np.zeros((4, 4, 3), np.uint8))      # the real grab() counts; only the adb read is faked
    monkeypatch.setattr(textocr, 'read_lines', lambda *args, **kwargs: [])
    monkeypatch.setattr(module_roundtrip, 'pending', lambda p: False)
    monkeypatch.setattr(scan_plan, 'missing_navigation', lambda *args, **kwargs: [])

    def run(argv, phases, *, operation_request=None):
        op, _ = store.accept('calibrate', ctx, operation_request or {'phases': argv[argv.index('--phases') + 1]})
        monkeypatch.setenv('TOWER_OPERATION_ID', op['id'])
        monkeypatch.setenv('TOWER_OPERATION_DB', store.path)
        monkeypatch.setattr(calibrate, 'PHASES', phases)
        monkeypatch.setattr(sys, 'argv', ['calibrate.py', '--instance', 'main', *argv])
        outcome = None
        with worker_operation():
            try:
                calibrate.main()
            except BaseException as exc:    # noqa: BLE001 - the worker wrapper re-raises into the process; the test reads the operation
                outcome = exc
        if outcome is not None and not isinstance(outcome, SystemExit):
            import traceback
            traceback.print_exception(outcome)
        return store.get(op['id']), outcome

    return run, folder


def sealed(op):
    return json.loads(Path(op['result_refs']['calibrate_metrics.json']['path']).read_text(encoding='utf-8'))


def digest_of(files):
    """The template inventory digest, transcribed: sha256 over `<relative path>\\0<sha256 of the file>\\0` of every file in path order."""
    digest = hashlib.sha256()
    for rel in sorted(files):
        digest.update(rel.encode() + b'\0' + hashlib.sha256(files[rel]).hexdigest().encode() + b'\0')
    return digest.hexdigest()


def declare_side(tmp_path, fingerprint='f1'):
    path = tmp_path.joinpath(*scan_identity.SIDES_RELATIVE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'schema_version': 1, 'sides': {'after': dict(source_revision='a' * 40, source_fingerprint=fingerprint, overlay_hash=None)}}), encoding='utf-8')


def test_a_two_phase_scan_is_measured_per_phase_and_sealed(worker, monkeypatch, tmp_path):
    run, folder = worker
    monkeypatch.setattr(scan_identity, 'host', lambda: dict(python='3.12.10', windows='10.0.26100'))

    def cards(cal):
        capture.grab(); textocr.read_lines(np.zeros((4, 4, 3), np.uint8), 2)
        from device import act
        monkeypatch.setattr(act, '_tap', lambda *a, **k: dict(type='tap', dry_run=True))
        act.tap(1, 2, 'open cards')
        cal.entries.append({'phase': 'cards', 'rel': 'cards/a.png', 'verified': True, 'status': 'exists', 't': 1e12})
        cal.entries.append({'phase': 'cards', 'rel': 'cards/b.png', 'verified': False, 'status': 'stale', 't': 1e12})
        return CARDS

    def modules(cal):
        cal.player['module_inventory_complete'] = True
        capture.grab(); capture.grab()
        return MODULES

    op, outcome = run(['--phases', 'c,m', '--allow-navigation'], {'c': ('cards', cards), 'm': ('modules', modules)})
    assert outcome is None and op['status'] == 'awaiting_apply'
    doc = sealed(op)
    assert doc['operation_id'] == op['id'] and doc['closed'] is True and doc['exit'] == dict(outcome='completed', error=None)
    c, m = doc['phases']
    assert (c['name'], c['status'], c['ran_in_this_operation']) == ('cards', 'done', True) and (m['name'], m['status']) == ('modules', 'done')
    assert c['coverage']['inventory'] == {'active': 20, 'cards': 31, 'complete': True, 'mastered': 0, 'pages': 7, 'unreadable_tiles': 0}
    assert m['coverage']['modules_in_grid'] == 26 and m['coverage']['module_inventory_complete'] is True
    assert c['inputs']['taps'] == 1 and c['inputs']['by_reason'] == {'open cards': 1} and m['inputs']['taps'] == 0
    assert c['captures']['ok'] == 1 and m['captures']['ok'] == 2
    assert [e['kind'] for e in doc['errors']] == ['entries_not_verified'] and doc['errors'][0]['rels'] == ['cards/b.png']
    assert doc['start_state'] == dict(phases_done=[], templates=dict(count=0, digest=digest_of({})))
    assert doc['captures']['ok'] == 1 + 2 + 2          # the two phases, the Home check before them and the final Home check after them
    assert doc['run'] == dict(kind='calibrate', request={'phases': 'c,m'}, account=None, device_key=op['context']['device_key'], rendering=RENDERING, instance='main')
    identity = doc['identity']
    assert set(identity['measured_files']) == set(scan_identity.MEASURED_FILES) and (identity['python'], identity['windows']) == ('3.12.10', '10.0.26100')
    assert (identity['tree_state'], identity['side'], identity['overlay_hash']) == ('undeclared', None, None)      # no scan_sides.json under the temporary root
    assert (folder / 'calibrate_metrics.json').read_bytes() == Path(op['result_refs']['calibrate_metrics.json']['path']).read_bytes()


def test_the_identity_names_this_machines_python_and_windows_build(worker):
    run, _ = worker
    op, _ = run(['--phases', 'c', '--allow-navigation'], {'c': ('cards', lambda cal: CARDS)})
    assert (sealed(op)['identity']['python'], sealed(op)['identity']['windows']) == (platform.python_version(), '{}.{}.{}'.format(*sys.getwindowsversion()[:3]))


@pytest.mark.parametrize('fingerprint,state,side', [('f1', 'clean', 'after'), ('f9', 'dirty', None)])
def test_the_identity_is_judged_against_the_sides_declared_under_the_root_the_worker_ran_from(worker, monkeypatch, tmp_path, fingerprint, state, side):
    run, _ = worker
    declare_side(tmp_path)
    monkeypatch.setattr(operations, '_BUILD', dict(source_revision='a' * 40, source_fingerprint=fingerprint, error=None))
    op, _ = run(['--phases', 'c', '--allow-navigation'], {'c': ('cards', lambda cal: CARDS)})
    identity = sealed(op)['identity']
    assert (identity['tree_state'], identity['side']) == (state, side) and identity['source_revision'] == 'a' * 40 and identity['source_fingerprint'] == fingerprint


@pytest.mark.parametrize('content', [b'one', b'two'])
def test_the_start_state_inventories_the_templates_folder_the_account_resolver_names(worker, tmp_path, content):
    """Unbound account: the templates folder is <root>/templates, not a folder beside calibrate_state.json (which is under logs/<instance>)."""
    run, folder = worker
    owner = tmp_path / 'backend' / 'templates'
    (owner / 'cards').mkdir(parents=True)
    (owner / 'cards' / 'a.png').write_bytes(content)
    (folder / 'templates').mkdir()
    (folder / 'templates' / 'decoy.png').write_bytes(b'a folder beside the state file that nothing owns')
    op, _ = run(['--phases', 'c', '--allow-navigation'], {'c': ('cards', lambda cal: CARDS)})
    assert sealed(op)['start_state']['templates'] == dict(count=1, digest=digest_of({'cards/a.png': content}))
    assert digest_of({'cards/a.png': b'one'}) != digest_of({'cards/a.png': b'two'})


@pytest.mark.parametrize('worker', ['mine'], indirect=True)
def test_a_bound_accounts_start_state_reads_its_own_calibration_templates(worker, tmp_path):
    run, folder = worker
    (tmp_path / 'backend' / 'templates').mkdir(parents=True)
    (tmp_path / 'backend' / 'templates' / 'unbound.png').write_bytes(b'the shared folder of an unbound account')
    (folder / 'templates').mkdir()
    (folder / 'templates' / 'home.png').write_bytes(b'home')
    (folder / 'templates' / 'perks.png').write_bytes(b'perks')
    op, _ = run(['--phases', 'c', '--allow-navigation'], {'c': ('cards', lambda cal: CARDS)})
    doc = sealed(op)
    assert doc['start_state']['templates'] == dict(count=2, digest=digest_of({'home.png': b'home', 'perks.png': b'perks'}))
    assert doc['run']['account'] == 'mine' and doc['run']['device_key'] == op['context']['device_key']


def real_cards_phase(monkeypatch, result, after_scan=None):
    """The real calibrate.phase_cards over a faked device: the card inventory reader writes card_manifest.json as the real one does and returns the same result."""
    def scan(cal, **kwargs):
        atomic_json(Path(cal.p['report']).parent / 'card_manifest.json', result)
        return result

    monkeypatch.setattr(card_inventory, 'scan', scan)
    monkeypatch.setattr(tourney, 'open_nav', lambda *args, **kwargs: None)
    monkeypatch.setattr(tourney, 'return_to_game', lambda *args, **kwargs: after_scan() if after_scan else None)
    monkeypatch.setattr(calibrate, 'harvest_row', lambda cal, frame, band, prefix, phase: [('Alpha', 'alpha', 'green'), ('Beta', 'beta', 'grey')])
    monkeypatch.setattr(calibrate, '_evidence', lambda *args, **kwargs: None)


def manifest_counts(manifest):
    return dict(cards=len(manifest['cards']), **{key: manifest[key] for key in ('complete', 'pages', 'unreadable_tiles', 'active', 'mastered')})


def test_coverage_is_the_phase_result_and_equals_the_manifest_the_phase_wrote(worker, monkeypatch):
    run, folder = worker
    result = {'complete': True, 'cards': [{'name': f'card {n}'} for n in range(7)], 'pages': 3, 'unreadable_tiles': 0, 'active': 4, 'mastered': 1}
    real_cards_phase(monkeypatch, result)
    op, outcome = run(['--phases', 'c', '--allow-navigation'], {'c': ('cards', calibrate.phase_cards)})
    assert outcome is None
    (phase,) = sealed(op)['phases']
    on_disk = json.loads((folder / 'card_manifest.json').read_text(encoding='utf-8'))
    assert phase['name'] == 'cards' and phase['coverage']['inventory'] == manifest_counts(on_disk) == manifest_counts(result)
    assert phase['coverage']['card_presets'] == 2 and phase['coverage']['names'] == 2


def test_coverage_stays_the_result_of_this_phase_when_a_later_scan_overwrote_the_manifest(worker, monkeypatch):
    """The working card_manifest.json is overwritten by every scan; the recorded coverage is what THIS phase returned, not what the file holds when the phase ends."""
    run, folder = worker
    result = {'complete': True, 'cards': [{'name': f'card {n}'} for n in range(7)], 'pages': 3, 'unreadable_tiles': 0, 'active': 4, 'mastered': 1}
    later = {'complete': False, 'cards': [{'name': 'x'}] * 99, 'pages': 12, 'unreadable_tiles': 5, 'active': 50, 'mastered': 9}
    real_cards_phase(monkeypatch, result, after_scan=lambda: atomic_json(folder / 'card_manifest.json', later))
    op, outcome = run(['--phases', 'c', '--allow-navigation'], {'c': ('cards', calibrate.phase_cards)})
    assert outcome is None
    (phase,) = sealed(op)['phases']
    on_disk = json.loads((folder / 'card_manifest.json').read_text(encoding='utf-8'))
    assert manifest_counts(on_disk) == manifest_counts(later) != manifest_counts(result)         # the overwrite happened
    assert phase['coverage']['inventory'] == manifest_counts(result)


def test_a_phase_the_saved_state_already_holds_done_is_carried_over(worker):
    run, folder = worker
    (folder / 'calibrate_state.json').write_text(json.dumps({'phases': {'cards': {'status': 'done', 'started_at': 1, 'finished_at': 164}}}), encoding='utf-8')
    ran = []
    op, _ = run(['--phases', 'c,m', '--allow-navigation'], {'c': ('cards', lambda cal: ran.append('c') or CARDS), 'm': ('modules', lambda cal: ran.append('m') or MODULES)})
    doc = sealed(op)
    assert ran == ['m']
    cards, modules = doc['phases']
    assert cards['status'] == 'carried_over' and cards['ran_in_this_operation'] is False and cards['coverage'] == {} and cards['duration_s'] == 0.0
    assert modules['status'] == 'done' and modules['ran_in_this_operation'] is True
    assert doc['start_state']['phases_done'] == ['cards']


def test_a_failing_phase_is_recorded_with_its_error_and_the_scan_fails_as_before(worker):
    run, _ = worker

    def broken(cal):
        raise RuntimeError('The module grid did not settle')

    op, outcome = run(['--phases', 'c,m', '--allow-navigation'], {'c': ('cards', lambda cal: CARDS), 'm': ('modules', broken)})
    doc = sealed(op)
    assert op['status'] == 'failed' and op['error']['code'] in ('capture_incomplete', 'final_screen_unverified')
    assert [(p['name'], p['status']) for p in doc['phases']] == [('cards', 'done'), ('modules', 'error')]
    assert doc['errors'][-1] == dict(phase='modules', kind='error', type='text', message='The module grid did not settle')


def test_a_raising_worker_still_writes_its_file_with_the_outcome(worker, monkeypatch):
    run, _ = worker
    monkeypatch.setattr(bootstrap, 'preflight', lambda: (_ for _ in ()).throw(RuntimeError('Stop the other runner first')))
    op, outcome = run(['--phases', 'c', '--allow-navigation'], {'c': ('cards', lambda cal: CARDS)})
    assert isinstance(outcome, RuntimeError)
    doc = sealed(op)
    assert doc['exit'] == dict(outcome='raised', error=dict(type='RuntimeError', message='Stop the other runner first')) and doc['phases'] == []


@pytest.mark.parametrize('raised,outcome,error', [
    (SystemExit(0), 'exited', None),
    (SystemExit(), 'exited', None),
    (SystemExit(2), 'raised', dict(type='SystemExit', message='2')),
    (SystemExit('No navigation image for the cards screen'), 'raised', dict(type='SystemExit', message='No navigation image for the cards screen')),
    (KeyboardInterrupt(), 'raised', dict(type='KeyboardInterrupt', message='')),
])
def test_how_the_worker_exits_is_recorded_and_the_same_exit_reaches_the_process(worker, monkeypatch, raised, outcome, error):
    run, folder = worker
    monkeypatch.setattr(calibrate, '_main', lambda: (_ for _ in ()).throw(raised))
    _, got = run(['--phases', 'c', '--allow-navigation'], {})
    assert got is raised                                                    # not wrapped, not replaced, not swallowed
    assert json.loads((folder / 'calibrate_metrics.json').read_text(encoding='utf-8'))['exit'] == dict(outcome=outcome, error=error)


def test_a_bootstrap_scan_is_one_phase_with_the_state_coverage(worker, monkeypatch):
    run, _ = worker

    def fake_run(p, overwrite, flows=False, battle_only=False, routes=None):
        state = {'operation_id': 'x', 'phases': {'bootstrap': {'status': 'done', 'kind': 'routes', 'completed': 2, 'total': 2, 'screens': ['home'], 'skipped': []}},
                 'screen_map': {'home': {'status': 'verified', 'verified': 3, 'total': 3}}, 'entries': [{'t': 1e12, 'verified': True}]}
        Path(p['state']).write_text(json.dumps(state), encoding='utf-8')

    monkeypatch.setattr(bootstrap, 'run', fake_run)
    op, outcome = run(['--bootstrap', '--allow-navigation', '--routes', 'route_0,route_1'], {}, operation_request={'bootstrap': True})
    doc = sealed(op)
    (phase,) = doc['phases']
    assert phase['name'] == 'bootstrap' and phase['status'] == 'done'
    assert phase['coverage']['screen_map'] == {'home': {'status': 'verified', 'verified': 3, 'total': 3}} and phase['coverage']['targets'] == {'total': 1, 'verified': 1}
    assert doc['run']['request'] == {'bootstrap': True}


def test_a_scan_with_no_operation_records_nothing(tmp_path, monkeypatch):
    monkeypatch.delenv('TOWER_OPERATION_ID', raising=False)
    monkeypatch.delenv('TOWER_OPERATION_DB', raising=False)
    monkeypatch.setattr(calibrate, '_main', lambda: None)
    calibrate.main()
    assert not scan_metrics.active()


def test_sealed_state_has_no_prior_operation_phase_times(worker):
    run, folder = worker
    (folder / 'calibrate_state.json').write_text(json.dumps({'phases': {
        'cards': {'status': 'done', 'started_at': 1, 'finished_at': 164},
        'global': {'status': 'done', 'started_at': 200, 'finished_at': 300},
        'bootstrap': {'status': 'done', 'steps': [{'started_at': 10, 'finished_at': 20}]}}}))
    op, outcome = run(['--phases', 'c,m', '--allow-navigation'], {
        'c': ('cards', lambda cal: CARDS), 'm': ('modules', lambda cal: MODULES)})
    assert outcome is None
    state = json.loads(Path(op['result_refs']['calibrate_state.json']['path']).read_text())
    for name in ('cards', 'global'):
        assert 'started_at' not in state['phases'][name]
        assert 'finished_at' not in state['phases'][name]
    assert state['phases']['modules']['finished_at'] >= state['phases']['modules']['started_at']
    assert state['phases']['bootstrap']['steps'] == [{}]


@pytest.mark.parametrize('target', ['start_state', 'coverage_of_result'])
def test_metrics_evaluation_failure_does_not_change_worker_outcome(worker, monkeypatch, target):
    run, _ = worker
    owner = scan_identity if target == 'start_state' else scan_metrics
    def broken(*args):
        raise RuntimeError('instrument failed')
    monkeypatch.setattr(owner, target, broken)
    op, outcome = run(['--phases', 'c', '--allow-navigation'], {'c': ('cards', lambda cal: CARDS)})
    assert outcome is None and op['status'] == 'awaiting_apply'
    assert sealed(op)['hook_errors'] == 1


def test_worker_build_import_failure_cannot_change_the_scan(monkeypatch):
    monkeypatch.delattr(operations, 'worker_build')
    called = []
    monkeypatch.setattr(calibrate, '_main', lambda: called.append(True))
    calibrate.main()
    assert called == [True] and not scan_metrics.active()
