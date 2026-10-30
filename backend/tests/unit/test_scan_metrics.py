"""Scan metrics (roadmap item 9, spec 3.1): what a calibration scan counts, where it counts it, and that it is sealed with its operation."""
import base64
import json
import re
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from runtime import diagnostics, operations, scan_identity, scan_metrics
from runtime.operations import Operations, worker_operation
from control import operations as service


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture(autouse=True)
def no_recorder():
    scan_metrics.end()
    yield
    scan_metrics.end()


def recorder(identity=None, run=None):
    clock = Clock()
    return scan_metrics.begin('op-1', identity or {}, run, mono=clock, wall=clock), clock


def held_by_this_thread():
    """True while the calling thread holds the module lock: another thread cannot take it."""
    got = []

    def probe():
        got.append(scan_metrics._lock.acquire(blocking=False))
        if got[0]:
            scan_metrics._lock.release()

    thread = threading.Thread(target=probe)
    thread.start()
    thread.join()
    return not got[0]


# ----------------------------------------------------------------------------------------------------------------- OCR
def boundary(monkeypatch, tmp_path, stdout=b'', returncode=0, raises=None):
    """Windows OCR as the code sees it: the hidden PowerShell process. Returns the list of launches."""
    from vision import textocr
    temporary = textocr.tempfile.TemporaryDirectory
    monkeypatch.setattr(textocr.tempfile, 'TemporaryDirectory', lambda **kw: temporary(dir=tmp_path, **kw))
    launches = []

    def run(args, **kwargs):
        launches.append(args)
        if raises:
            raise raises
        if callable(stdout):
            return SimpleNamespace(args=args, returncode=returncode, stderr=b'', stdout=stdout(args))
        return SimpleNamespace(args=args, returncode=returncode, stderr=b'', stdout=stdout)

    monkeypatch.setattr(textocr.settings, 'run_hidden', run)
    return launches


def test_read_lines_counts_one_launch_per_call(monkeypatch, tmp_path):
    from vision import textocr
    launches = boundary(monkeypatch, tmp_path)
    rec, _ = recorder()
    crop = np.full((10, 20, 3), 40, np.uint8)
    textocr.read_lines(crop, 2)
    textocr.read_lines(crop, 3)
    assert len(launches) == 2
    assert rec.counters['ocr'] == dict(calls=2, crops=2, process_launches=2, timeouts=0, errors=0)


def test_starting_the_warm_reader_counts_one_launch_and_a_read_through_it_adds_no_other(monkeypatch):
    """r15d: an urgent read goes to a warm PowerShell reader instead of a cold batch. Its process start is a launch like the cold batch's; the reads served by the
    same reader afterwards start nothing, so they are calls and crops only."""
    import io
    from vision import textocr
    spawned = []

    def spawn(args, **kwargs):
        spawned.append(args)
        return SimpleNamespace(stdout=io.BytesIO(b''), stdin=None, poll=lambda: None)

    monkeypatch.setattr(textocr.settings, 'spawn_hidden', spawn)
    rec, _ = recorder()
    reader = textocr._WarmReader()
    reader._start()
    scan_metrics.ocr_call(2)                                  # a later read the running reader serves: no start
    assert len(spawned) == 1
    assert rec.counters['ocr'] == dict(calls=1, crops=2, process_launches=1, timeouts=0, errors=0)


def test_read_texts_counts_one_launch_for_n_crops(monkeypatch, tmp_path):
    from vision import textocr

    def stdout(args):
        script = base64.b64decode(args[-1]).decode('utf-16le')
        manifest = re.search(r"-LiteralPath '([^']+)'", script)[1]
        entries = json.loads(open(manifest, encoding='utf-8').read())
        return '\n'.join(f'TP_OCR_IMAGE\t{entry["index"]}\n4\t6\tAlpha' for entry in entries).encode()

    launches = boundary(monkeypatch, tmp_path, stdout=stdout)
    rec, _ = recorder()
    crops = [np.full((10, 20, 3), 30, np.uint8) for _ in range(4)]
    assert textocr.read_texts(crops, scales=(2.0, 3.0), raise_on_error=True) == ['Alpha'] * 4
    assert len(launches) == 1
    assert rec.counters['ocr'] == dict(calls=1, crops=4, process_launches=1, timeouts=0, errors=0)


def test_a_non_zero_powershell_exit_without_raise_on_error_is_not_counted_as_an_ocr_error(monkeypatch, tmp_path):
    """The recorder mirrors the silent path of vision/textocr.py (rules, item 12): a non-zero return code is not raised, so it is not counted."""
    from vision import textocr
    boundary(monkeypatch, tmp_path, returncode=1)
    rec, _ = recorder()
    assert textocr.read_lines(np.full((10, 20, 3), 40, np.uint8), 2) == []
    assert rec.counters['ocr'] == dict(calls=1, crops=1, process_launches=1, timeouts=0, errors=0)


@pytest.mark.parametrize('raises,field', [(subprocess.TimeoutExpired('powershell', 1), 'timeouts'), (OSError('no powershell'), 'errors'),
                                          (subprocess.CalledProcessError(1, 'powershell'), 'errors')])
def test_ocr_timeouts_and_errors_are_counted_and_the_caller_still_gets_its_empty_reading(monkeypatch, tmp_path, raises, field):
    from vision import textocr
    boundary(monkeypatch, tmp_path, raises=raises)
    rec, _ = recorder()
    crop = np.full((10, 20, 3), 40, np.uint8)
    assert textocr.read_lines(crop, 2) == []
    assert textocr.read_texts([crop]) == ['']
    assert rec.counters['ocr'][field] == 2 and rec.counters['ocr']['calls'] == 2 and rec.counters['ocr']['process_launches'] == 2


def test_ocr_with_raise_on_error_still_raises_and_still_counts(monkeypatch, tmp_path):
    from vision import textocr
    boundary(monkeypatch, tmp_path, raises=subprocess.TimeoutExpired('powershell', 1))
    rec, _ = recorder()
    with pytest.raises(subprocess.TimeoutExpired):
        textocr.read_lines(np.full((10, 20, 3), 40, np.uint8), 2, raise_on_error=True)
    assert rec.counters['ocr']['timeouts'] == 1


# ------------------------------------------------------------------------------------------------------------- captures
def test_capture_counts_ok_retry_and_failure(monkeypatch):
    from device import capture
    frame = np.zeros((4, 4, 3), np.uint8)
    rec, _ = recorder()

    def retried(*args, diagnostic, **kwargs):
        capture._capture_retry(diagnostic, reason='test')
        return frame

    monkeypatch.setattr(capture, '_grab', retried)
    assert capture.grab() is frame
    monkeypatch.setattr(capture, '_grab', lambda *args, **kwargs: frame)
    capture.grab()

    def broken(*args, **kwargs):
        raise capture.CaptureError('no screen')

    monkeypatch.setattr(capture, '_grab', broken)
    with pytest.raises(capture.CaptureError):
        capture.grab()
    assert rec.counters['captures'] == dict(ok=2, retries=1, failed=1)


def test_a_capture_that_arrives_after_its_deadline_is_a_failure_not_a_frame(monkeypatch):
    from device import capture
    monkeypatch.setattr(capture, '_grab', lambda *args, **kwargs: np.zeros((4, 4, 3), np.uint8))
    rec, _ = recorder()
    ticks = iter([0.0, 0.0, 10.0, 10.0, 10.0])
    monkeypatch.setattr(capture.adbclient.time, 'monotonic', lambda: next(ticks, 10.0))
    with pytest.raises(TimeoutError):
        capture.grab(deadline=5.0)
    assert rec.counters['captures']['ok'] == 0 and rec.counters['captures']['failed'] == 1


# ----------------------------------------------------------------------------------------------------------------- input
def test_inputs_match_the_event_log(monkeypatch):
    """The recorder's taps and swipes equal the device.tap and device.swipe attempts the event log records for the same calls (spec 3.1 cross-check)."""
    from device import act
    events = []
    monkeypatch.setattr(act.logger, 'attempt', lambda name, **fields: diagnostics.attempt(name, emit=lambda kind, **x: events.append((kind, x)), **fields))
    monkeypatch.setattr(act, '_tap', lambda x, y, reason='', instant=False, deadline=None: dict(type='tap', dry_run=True))
    refused = iter([False, False, True])

    def swipe(*args):
        if next(refused):
            raise act.TapRefused('taps not allowed')
        return dict(type='swipe', dry_run=True)

    monkeypatch.setattr(act, '_swipe', swipe)
    rec, _ = recorder()
    act.tap(1, 2, 'open cards')
    act.tap(3, 4, 'open cards')
    act.tap(5, 6, 'open modules')
    act.swipe(1, 2, 3, 4, 100, 'card scroll')
    act.swipe(1, 2, 3, 4, 100, 'card scroll')
    with pytest.raises(act.TapRefused):
        act.swipe(1, 2, 3, 4, 100, 'card scroll')
    ends = [fields['action'] for kind, fields in events if kind == 'attempt_end']
    assert ends.count('device.tap') == rec.counters['inputs']['taps'] == 3
    assert ends.count('device.swipe') == rec.counters['inputs']['swipes'] == 3
    assert rec.counters['inputs']['refused'] == 1
    assert rec.counters['inputs']['by_reason'] == {'open cards': 2, 'open modules': 1, 'card scroll': 3}


def test_an_input_without_a_reason_is_counted_under_none(monkeypatch):
    from device import act
    monkeypatch.setattr(act, '_tap', lambda *args, **kwargs: dict(type='tap', dry_run=True))
    rec, _ = recorder()
    act.tap(1, 2)
    assert rec.counters['inputs']['by_reason'] == {'(none)': 1}


# ----------------------------------------------------------------------------------------------------- the recorder itself
def test_nothing_counts_outside_an_operation(monkeypatch, tmp_path):
    from vision import textocr
    boundary(monkeypatch, tmp_path)
    assert not scan_metrics.active()
    textocr.read_lines(np.full((10, 20, 3), 40, np.uint8), 2)
    scan_metrics.tap('x')
    scan_metrics.capture_ok()
    scan_metrics.phase_begin('cards')
    scan_metrics.phase_end('cards', 'done')
    assert scan_metrics.current() is None and scan_metrics.end_and_write(lambda: tmp_path / 'never.json') is None
    assert not (tmp_path / 'never.json').exists()


def test_counters_reset_per_operation():
    first = scan_metrics.begin('op-a')
    scan_metrics.tap('x')
    assert first.counters['inputs']['taps'] == 1
    second = scan_metrics.begin('op-b')
    assert second.counters['inputs']['taps'] == 0 and scan_metrics.current() is second


def test_a_hook_that_raises_never_reaches_the_scan(monkeypatch):
    rec, _ = recorder()
    class Broken(dict):
        def __getitem__(self, key):
            raise RuntimeError('boom')
    rec.counters = Broken()
    scan_metrics.capture_ok()
    scan_metrics.tap('open cards')
    assert rec.hook_errors == 2


def test_hot_hooks_do_not_acquire_any_added_lock(monkeypatch):
    rec, _ = recorder()
    class ForbiddenLock:
        def __enter__(self):
            raise AssertionError('hot-path lock')
    monkeypatch.setattr(scan_metrics, '_lock', ForbiddenLock())
    scan_metrics.capture_ok()
    scan_metrics.capture_retry()
    scan_metrics.tap('cards')
    scan_metrics.swipe('scroll')
    scan_metrics.input_refused()
    assert rec.counters['captures'] == dict(ok=1, retries=1, failed=0)
    assert rec.counters['inputs'] == dict(taps=1, swipes=1, refused=1, by_reason={'cards': 1, 'scroll': 1})
    monkeypatch.undo()


def test_the_document_is_built_under_the_lock(tmp_path, monkeypatch):
    rec, _ = recorder()
    held = []
    real = rec.document
    monkeypatch.setattr(rec, 'document', lambda *args: held.append(held_by_this_thread()) or real(*args))
    document = scan_metrics.end_and_write(lambda: tmp_path / 'calibrate_metrics.json')
    assert held == [True] and json.loads((tmp_path / 'calibrate_metrics.json').read_text(encoding='utf-8')) == document


def test_phase_records_hold_this_runs_deltas_status_and_errors():
    rec, clock = recorder()
    scan_metrics.phase_begin('cards')
    scan_metrics.ocr_call(2)
    scan_metrics.ocr_launch()
    scan_metrics.capture_ok()
    scan_metrics.tap('open cards')
    clock.advance(12.5)
    scan_metrics.phase_end('cards', 'done', coverage={'pages': 7}, unverified=['cards/a.png', 'cards/b.png'])
    scan_metrics.phase_begin('modules')
    scan_metrics.capture_ok()
    scan_metrics.swipe('scroll')
    clock.advance(3)
    scan_metrics.phase_end('modules', 'error', error='The grid did not settle', coverage={})
    doc = rec.document('raised', RuntimeError('The grid did not settle'))
    cards, modules = doc['phases']
    assert (cards['name'], cards['status'], cards['ran_in_this_operation'], cards['duration_s']) == ('cards', 'done', True, 12.5)
    assert cards['ocr'] == dict(calls=1, crops=2, process_launches=1, timeouts=0, errors=0) and cards['captures']['ok'] == 1
    assert cards['inputs']['taps'] == 1 and cards['inputs']['by_reason'] == {'open cards': 1} and cards['coverage'] == {'pages': 7}
    assert modules['captures']['ok'] == 1 and modules['inputs']['swipes'] == 1 and modules['inputs']['taps'] == 0 and modules['ocr']['calls'] == 0
    assert modules['inputs']['by_reason'] == {'scroll': 1}
    assert [(e['phase'], e['kind']) for e in doc['errors']] == [('cards', 'entries_not_verified'), ('modules', 'error')]
    assert doc['errors'][0]['count'] == 2 and doc['errors'][1]['message'] == 'The grid did not settle'
    assert doc['exit'] == dict(outcome='raised', error=dict(type='RuntimeError', message='The grid did not settle'))
    assert doc['ocr']['calls'] == 1 and doc['captures']['ok'] == 2 and doc['inputs']['taps'] == 1 and doc['inputs']['swipes'] == 1
    assert doc['closed'] is True and doc['operation_id'] == 'op-1' and doc['schema_version'] == scan_metrics.SCHEMA_VERSION == 1


RECORD = {'id': 'op-1', 'kind': 'calibrate', 'request': {'phases': 'c,m', 'fresh': True, 'overwrite': False},
          'context': {'account': 'alpha', 'device_key': 'k' * 64, 'rendering': {'width': 1080, 'height': 2560, 'dpi': 360}, 'instance': 'main', 'serial': 'fake:1', 'config': {'secret': 1}}}


def test_the_run_block_is_read_from_the_ledger_record_and_names_only_the_comparable_facts():
    assert scan_metrics.run_of(RECORD) == dict(kind='calibrate', request={'phases': 'c,m', 'fresh': True, 'overwrite': False}, account='alpha', device_key='k' * 64,
                                               rendering={'width': 1080, 'height': 2560, 'dpi': 360}, instance='main')
    empty = dict(kind=None, request=None, account=None, device_key=None, rendering=None, instance=None)
    assert scan_metrics.run_of({}) == empty and scan_metrics.run_of(None) == empty and scan_metrics.run_of({'kind': 'observe', 'context': 'text'}) == dict(empty, kind='observe')
    unbound = scan_metrics.run_of(dict(RECORD, context=dict(RECORD['context'], account=None, rendering=None)))
    assert unbound['account'] is None and unbound['rendering'] is None and unbound['device_key'] == 'k' * 64


def test_the_document_carries_the_run_block_it_was_begun_with():
    run = scan_metrics.run_of(RECORD)
    rec, _ = recorder(run=run)
    assert rec.document()['run'] == run
    assert recorder()[0].document()['run'] == {}


def test_a_phase_skipped_as_done_is_recorded_carried_over_with_no_coverage():
    rec, _ = recorder()
    scan_metrics.phase_carried_over('cards')
    (phase,) = rec.document()['phases']
    assert phase['status'] == 'carried_over' and phase['ran_in_this_operation'] is False and phase['coverage'] == {} and phase['duration_s'] == 0.0
    assert phase['ocr']['calls'] == 0 and phase['captures']['ok'] == 0 and phase['inputs']['taps'] == 0


def test_a_phase_begun_while_another_is_open_closes_the_first_as_interrupted():
    rec, _ = recorder()
    scan_metrics.phase_begin('cards')
    scan_metrics.phase_begin('modules')
    scan_metrics.phase_end('modules', 'done')
    assert [(p['name'], p['status']) for p in rec.document()['phases']] == [('cards', 'interrupted'), ('modules', 'done')]
    scan_metrics.phase_end('cards', 'done')                   # an end for a phase that is no longer open records nothing
    assert len(rec.phases) == 2


def test_a_phase_still_open_when_the_worker_ends_is_closed_as_interrupted():
    rec, _ = recorder()
    scan_metrics.phase_begin('modules')
    doc = rec.document('raised', RuntimeError('restore required'))
    assert doc['phases'][0]['status'] == 'interrupted' and doc['errors'][0]['kind'] == 'interrupted'


def test_the_phase_callables_run_outside_the_lock_and_one_that_raises_is_counted_not_raised():
    rec, _ = recorder()
    seen = []

    def status():
        seen.append(('status', held_by_this_thread()))
        return 'done'

    def coverage():
        seen.append(('coverage', held_by_this_thread()))
        return {'screens': ['home']}

    with scan_metrics.phase('bootstrap', coverage=coverage, status=status):
        pass
    assert seen == [('status', False), ('coverage', False)] and rec.phases[0]['coverage'] == {'screens': ['home']} and rec.hook_errors == 0

    def broken():
        raise OSError('state file locked')

    with scan_metrics.phase('observe', coverage=broken):
        pass                                        # must not raise into the scan
    assert rec.hook_errors == 1 and len(rec.phases) == 1
    assert [(p['name'], p['status']) for p in rec.document()['phases']] == [('bootstrap', 'done'), ('observe', 'interrupted')]


def test_the_phase_callables_are_not_called_when_nothing_is_recorded():
    called = []
    with scan_metrics.phase('bootstrap', coverage=lambda: called.append('coverage'), status=lambda: called.append('status')):
        pass
    assert called == [] and not scan_metrics.active()


def test_the_phase_context_manager_records_a_normal_end_and_an_exception():
    rec, _ = recorder()
    with scan_metrics.phase('bootstrap', coverage=lambda: {'screens': ['home']}, status=lambda: 'needs_attention'):
        pass
    with pytest.raises(ValueError):
        with scan_metrics.phase('observe'):
            raise ValueError('no screen')
    boot, observe = rec.document()['phases']
    assert (boot['status'], boot['coverage']) == ('needs_attention', {'screens': ['home']})
    assert observe['status'] == 'error' and rec.document()['errors'][0]['message'] == 'no screen'


# -------------------------------------------------------------------------------------------------------------- coverage
CARDS = {'card_presets': ['a'] * 5, 'names': ['a'] * 5,
         'inventory': {'complete': True, 'cards': [{}] * 31, 'pages': 7, 'unreadable_tiles': 0, 'active': 20, 'mastered': 0}}
MODULES = {'modules_equipped': ['a'] * 4, 'modules_in_grid': ['a'] * 26, 'copies': 52, 'preset_tabs': ['a'] * 2}


def test_coverage_is_the_phase_result_flattened_to_counts():
    assert scan_metrics.coverage_of_result(CARDS) == {
        'card_presets': 5, 'names': 5,
        'inventory': {'active': 20, 'cards': 31, 'complete': True, 'mastered': 0, 'pages': 7, 'unreadable_tiles': 0}}
    assert scan_metrics.coverage_of_result(MODULES, {'module_inventory_complete': True}) == {
        'copies': 52, 'modules_equipped': 4, 'modules_in_grid': 26, 'preset_tabs': 2, 'module_inventory_complete': True}
    assert scan_metrics.coverage_of_result(MODULES, {}) == {'copies': 52, 'modules_equipped': 4, 'modules_in_grid': 26, 'preset_tabs': 2}
    assert scan_metrics.coverage_of_result(None) == {} and scan_metrics.coverage_of_result('text') == {}


def test_bootstrap_coverage_counts_the_screens_and_the_targets_touched_since_the_start():
    state = {'phases': {'bootstrap': {'kind': 'routes', 'completed': 3, 'total': 4, 'screens': ['home', 'perks_hub'], 'skipped': [{'target': 'x'}], 'needs_attention': 1}},
             'screen_map': {'home': {'status': 'verified', 'verified': 5, 'total': 5, 'blocks': []}, 'other': {'status': 'verified', 'verified': 1, 'total': 1}},
             'entries': [{'t': 50, 'verified': True}, {'t': 150, 'verified': True}, {'t': 160, 'verified': False}]}
    assert scan_metrics.bootstrap_coverage(state, 100) == dict(
        kind='routes', steps_completed=3, steps_total=4, screens=['home', 'perks_hub'], screen_map={'home': dict(status='verified', verified=5, total=5)},
        targets=dict(total=2, verified=1), skipped=1, needs_attention=1)
    assert scan_metrics.bootstrap_coverage({}, 0)['targets'] == dict(total=0, verified=0)


# ----------------------------------------------------------------------------------------------- writing, sealing, identity
def target(tmp_path):
    profile = tmp_path / 'profiles' / 'mine.yaml'
    profile.parent.mkdir(exist_ok=True)
    profile.write_text('player: {}\n')
    cfg = dict(active_instance='main', active_profile='mine', instances={'main': {'serial': 'fake:1', 'rendering': {'width': 1080, 'height': 2560, 'dpi': 360}}})
    return service.context(tmp_path, cfg, {}, str(profile))


@pytest.mark.parametrize('kind,request_body', [('calibrate', {'phases': 'c'}), ('observe', {'watch': 30})])
def test_the_metrics_file_is_sealed_with_the_operation_and_a_stale_working_file_is_not(tmp_path, monkeypatch, kind, request_body):
    ctx = target(tmp_path)
    store = Operations(tmp_path / 'ops.db')
    directory = Path(ctx['artifact_dir'])
    directory.mkdir(parents=True)
    stale = directory / 'calibrate_metrics.json'
    stale.write_text(json.dumps({'operation_id': 'an-earlier-operation', 'closed': True}), encoding='utf-8')
    op, _ = store.accept(kind, ctx, request_body)
    monkeypatch.setenv('TOWER_OPERATION_ID', op['id'])
    monkeypatch.setenv('TOWER_OPERATION_DB', store.path)
    with worker_operation():
        scan_metrics.discard_stale(stale)
        assert not stale.exists()
        scan_metrics.begin(op['id'], run=scan_metrics.run_of(store.get(op['id'])))
        scan_metrics.phase_begin('cards')
        scan_metrics.phase_end('cards', 'done', coverage={'pages': 7})
        scan_metrics.end_and_write(lambda: stale)
        (directory / 'calibrate_state.json').write_text(json.dumps({'operation_id': op['id'], 'phases': {'cards': {'status': 'done'}},
                                                                    'final_screen': {'name': 'home', 'verified': True, 'operation_id': op['id']}}))
    saved = store.get(op['id'])
    sealed = Path(saved['result_refs']['calibrate_metrics.json']['path'])
    assert saved['status'] == 'awaiting_apply' and sealed == directory / 'operations' / op['id'] / 'calibrate_metrics.json'
    document = json.loads(sealed.read_text(encoding='utf-8'))
    assert document['operation_id'] == op['id'] and document['phases'][0]['coverage'] == {'pages': 7}
    assert document['run']['kind'] == kind and document['run']['request'] == request_body and document['run']['device_key'] == ctx['device_key']
    assert saved['result_refs']['calibrate_metrics.json']['revision'] == operations.file_revision(sealed)


def test_an_operation_without_a_metrics_file_still_seals_and_has_no_reference(tmp_path, monkeypatch):
    ctx = target(tmp_path)
    store = Operations(tmp_path / 'ops.db')
    directory = Path(ctx['artifact_dir'])
    directory.mkdir(parents=True)
    op, _ = store.accept('calibrate', ctx, {'phases': 'c'})
    monkeypatch.setenv('TOWER_OPERATION_ID', op['id'])
    monkeypatch.setenv('TOWER_OPERATION_DB', store.path)
    with worker_operation():
        (directory / 'calibrate_state.json').write_text(json.dumps({'operation_id': op['id'], 'phases': {'cards': {'status': 'done'}},
                                                                    'final_screen': {'name': 'home', 'verified': True, 'operation_id': op['id']}}))
    saved = store.get(op['id'])
    assert saved['status'] == 'awaiting_apply' and 'calibrate_metrics.json' not in saved['result_refs']


def test_a_metrics_write_failure_never_changes_the_scan_status(tmp_path, monkeypatch):
    from runtime import logger
    events = []
    monkeypatch.setattr(logger, 'event', lambda kind, **fields: events.append((kind, fields)))
    ctx = target(tmp_path)
    store = Operations(tmp_path / 'ops.db')
    directory = Path(ctx['artifact_dir'])
    directory.mkdir(parents=True)
    op, _ = store.accept('calibrate', ctx, {'phases': 'c'})
    monkeypatch.setenv('TOWER_OPERATION_ID', op['id'])
    monkeypatch.setenv('TOWER_OPERATION_DB', store.path)
    with worker_operation():
        scan_metrics.begin(op['id'])
        blocked = directory / 'calibrate_metrics.json'
        blocked.mkdir()          # a directory where the file belongs: the write must fail
        assert scan_metrics.end_and_write(lambda: blocked) is None
        scan_metrics.begin(op['id'])
        assert scan_metrics.end_and_write(lambda: (_ for _ in ()).throw(RuntimeError('no path'))) is None
        (directory / 'calibrate_state.json').write_text(json.dumps({'operation_id': op['id'], 'phases': {'cards': {'status': 'done'}},
                                                                    'final_screen': {'name': 'home', 'verified': True, 'operation_id': op['id']}}))
    assert store.get(op['id'])['status'] == 'awaiting_apply'
    failed = [fields for kind, fields in events if kind == 'metrics_error']
    assert len(failed) == 3 and 'no path' in failed[1]['error'] and failed[0]['error']


def test_a_worker_reports_its_own_start_snapshot_not_a_recomputed_one():
    build = operations.worker_build()
    assert build['source_fingerprint'] == operations._BUILD['source_fingerprint'] and build is not operations._BUILD
    build['source_fingerprint'] = 'changed'
    assert operations._BUILD['source_fingerprint'] != 'changed'


def test_metrics_hooks_send_no_input_and_spawn_no_adb(monkeypatch):
    import device.adbclient as adbclient
    spawned = []
    monkeypatch.setattr(subprocess, 'Popen', lambda *args, **kwargs: spawned.append(args))
    monkeypatch.setattr(adbclient, 'shell', lambda *args, **kwargs: spawned.append(args))
    rec, _ = recorder()
    for call in (lambda: scan_metrics.ocr_call(3), scan_metrics.ocr_launch, scan_metrics.capture_ok, scan_metrics.capture_retry,
                 lambda: scan_metrics.tap('x'), lambda: scan_metrics.swipe('y'), scan_metrics.input_refused,
                 lambda: scan_metrics.phase_begin('p'), lambda: scan_metrics.phase_end('p', 'done')):
        call()
    rec.document()
    assert spawned == []


@pytest.mark.parametrize('raw', ['not json', '[]', '{"operation_id": "older"}'])
def test_broken_or_foreign_metrics_are_logged_and_never_sealed(tmp_path, monkeypatch, raw):
    from runtime import logger
    events = []
    monkeypatch.setattr(logger, 'event', lambda kind, **fields: events.append((kind, fields)))
    ctx = target(tmp_path)
    store = Operations(tmp_path / 'ops.db')
    op, _ = store.accept('calibrate', ctx, {'phases': 'c'})
    directory = Path(ctx['artifact_dir'])
    directory.mkdir(parents=True)
    monkeypatch.setenv('TOWER_OPERATION_ID', op['id'])
    monkeypatch.setenv('TOWER_OPERATION_DB', store.path)
    with worker_operation():
        (directory / 'calibrate_metrics.json').write_text(raw)
        (directory / 'calibrate_state.json').write_text(json.dumps({
            'operation_id': op['id'], 'phases': {'cards': {'status': 'done'}},
            'final_screen': {'operation_id': op['id'], 'name': 'home', 'verified': True}}))
    saved = store.get(op['id'])
    assert saved['status'] == 'awaiting_apply'
    assert 'calibrate_metrics.json' not in saved['result_refs']
    assert any(kind == 'metrics_error' and fields['operation_id'] == op['id'] for kind, fields in events)
