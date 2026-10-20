"""Runtime adapters for the pure workflow ledger."""
import json
import os
from pathlib import Path
from contextlib import contextmanager

from towerpilot_workflows.operations import (
    Operations, Conflict, digest, file_revision, ACTIVE, STATUSES,
)


def environment_operation():
    operation_id = os.environ.get('TOWER_OPERATION_ID')
    path = os.environ.get('TOWER_OPERATION_DB')
    return (Operations(path), operation_id) if operation_id and path else (None, None)


def restore_worker_context(settings):
    """Pin configuration before device binding, including original profile."""
    ledger, operation_id = environment_operation()
    if ledger:
        op = ledger.get(operation_id)
        settings.CONFIG.clear()
        settings.CONFIG.update(op['context']['config'])
        import copy
        settings._DEFAULTS = {k: copy.deepcopy(settings.CONFIG[k]) for k in settings._OVERRIDABLE if k in settings.CONFIG}
        settings._ACCOUNT_DEFAULTS = {k: copy.deepcopy(settings.CONFIG.get(k)) for k in ('loadouts', 'active_profile', 'tourney_card_tweaks')}


def publish_progress(state):
    ledger, operation_id = environment_operation()
    if not ledger:
        return
    state['operation_id'] = operation_id
    op = ledger.get(operation_id)
    if op['status'] == 'running':
        phases = state.get('phases', {})
        step = next((key for key, value in phases.items() if value.get('status') == 'running'), 'capture')
        try:
            op = ledger.transition(operation_id, op['revision'], 'running', step=step)
        except Conflict:
            op = ledger.get(operation_id)
    state['operation_revision'] = op['revision']


@contextmanager
def worker_operation(kind=None):
    """Entrypoint wrapper. Lease ownership remains the worker's responsibility."""
    ledger, operation_id = environment_operation()
    if ledger is None:
        yield
        return
    import psutil
    op = ledger.get(operation_id)
    worker = {'pid': os.getpid(), 'creation_time': psutil.Process().create_time()}
    if op['status'] == 'cancelling':
        ledger.transition(operation_id, op['revision'], 'cancelled', worker=worker)
        raise SystemExit('Operation cancelled before worker start')
    if op['status'] != 'accepted':
        raise Conflict('Worker launch is no longer accepted')
    ledger.transition(operation_id, op['revision'], 'running', worker=worker, step='capture')
    failure = None
    try:
        yield
    except SystemExit as exc:
        if exc.code not in (None, 0):
            failure = {'code': 'SystemExit', 'message': str(exc)[:1000]}
        raise
    except BaseException as exc:
        failure = {'code': type(exc).__name__, 'message': str(exc)[:1000]}
        raise
    finally:
        op = ledger.get(operation_id)
        directory = Path(op['context']['artifact_dir'])
        restore = (directory / 'module_restore.json').exists()
        refs = {}
        state = {}
        name = 'scan' if op['kind'] == 'scan' else 'calibrate'
        filenames = (f'{name}_state.json', f'{name}_report.json') if op['kind'] in ('calibrate', 'observe', 'scan') else ('screen_analysis.json', 'screen_analysis.png') if op['kind'] == 'screen_analysis' else ()
        restore = restore and op['kind'] in ('calibrate', 'observe', 'scan')
        for filename in filenames:
            path = directory / filename
            if path.exists():
                refs[filename] = {'path': str(path), 'revision': file_revision(path)}
                if filename.endswith('_state.json') or filename == 'screen_analysis.json':
                    try:
                        state = json.loads(path.read_text(encoding='utf-8'))
                    except (OSError, ValueError) as exc:
                        failure = {'code': 'invalid_artifact', 'message': str(exc)}
        phase_names = {'c': 'cards', 'g': 'global', 'm': 'modules', 'u': 'guardians', 'b': 'bots', 'w': 'workshop', 'e': 'equipped_modules'}
        if op['kind'] == 'scan':
            phase_names = {'c': 'cards', 'g': 'guardians', 'm': 'modules', 'b': 'battle'}
        requested = op['request'].get('phases', 'c,g,m,u,b,w')
        if isinstance(requested, str):
            requested = requested.split(',')
        selected_names = {phase_names.get(key, key) for key in requested}
        if op['request'].get('bootstrap'):
            selected_names = {'bootstrap'}
        phases = state.get('phases', {})
        phase_errors = any(x.get('status') in ('error', 'stopped', 'running', 'needs_attention')
                           or any(step.get('status') in ('error', 'stopped', 'needs_attention', 'running') for step in x.get('steps', []))
                           for key, x in phases.items() if key in selected_names)
        if filenames and state.get('operation_id') != operation_id:
            failure = failure or {'code': 'missing_capture_outcome', 'message': 'Worker did not publish observations for this operation'}
        if op['kind'] == 'screen_analysis' and state.get('status') != 'done':
            failure = failure or {'code': 'analysis_incomplete', 'message': state.get('message', 'Screen analysis did not complete')}
        if restore:
            status = 'restoration_required'
        elif op['status'] == 'cancelling':
            status = 'cancelled'
        elif failure or phase_errors:
            status = 'failed'
        elif op['kind'] in ('calibrate', 'observe'):
            status = 'awaiting_apply'
        else:
            status = 'succeeded'
        ledger.transition(operation_id, op['revision'], status, result_refs=refs,
                          error=failure or ({'code': 'capture_incomplete', 'message': 'Some capture phases did not complete'} if phase_errors else None),
                          step='restore' if restore else 'capture_complete',
                          recovery_action='Restore original module equipment before continuing' if restore else None)
