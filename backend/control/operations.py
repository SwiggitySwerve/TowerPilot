"""Local application operation adapter; no device/runtime-settings imports."""
import copy
import os
from pathlib import Path

from towerpilot_workflows.operations import Conflict, Operations, digest, file_revision


def ledger(root):
    return Operations(Path(root) / 'logs' / 'operations.sqlite3')


def context(root, cfg, command, profile_path):
    from player import accounts
    from device import adbclient
    inst = cfg.get('active_instance', 'main')
    device = (cfg.get('instances') or {}).get(inst) or {}
    host, port = adbclient._HOST
    host = '127.0.0.1' if str(host).lower() in ('localhost', '::1') else str(host).lower()
    return dict(instance=inst, account=accounts.identity(cfg), serial=device.get('serial'),
                rendering=device.get('rendering'), profile=cfg.get('active_profile'),
                profile_path=profile_path, profile_revision=file_revision(profile_path) if profile_path else None,
                selected_run=command.get('selected_run', command.get('preset')),
                config_revision=digest(cfg), artifact_dir=str(accounts.calibration_dir(root, cfg)),
                adb_host=host, adb_port=int(port),
                device_key=digest({'host': host, 'port': int(port), 'serial': device.get('serial')}),
                config=copy.deepcopy(cfg))


def public(op):
    result = copy.deepcopy(op)
    result['context'].pop('config', None)
    result.get('request', {}).pop('battle_envelope', None)
    return result


def worker_alive(worker):
    if not worker:
        return False
    import psutil
    try:
        proc = psutil.Process(worker['pid'])
        return abs(proc.create_time() - worker['creation_time']) < 0.01 and proc.is_running()
    except (psutil.NoSuchProcess, psutil.AccessDenied, KeyError):
        return False


def launch(root, cfg, kind, command, cmd, popen, profile_path=None, **kwargs):
    previous = retry(root, cfg, kind, command, profile_path)
    if previous:
        return previous
    store = ledger(root)
    payload = {k: v for k, v in command.items() if k != 'idempotency_key'}
    target = context(root, cfg, payload, profile_path)
    expected = command.get('expected_context')
    if expected is not None:
        if not isinstance(expected, dict) or any(expected.get(key) != target.get(key) for key in ('instance', 'account', 'serial', 'rendering', 'profile')):
            raise Conflict('Selected account, device or profile changed before acceptance')
    for active in store.active(target['device_key']):
        store.reconcile(active['id'], worker_alive)
    op, created = store.accept(kind, target, payload, command.get('idempotency_key'))
    if not created:
        return op
    env = dict(os.environ, TOWER_OPERATION_DB=store.path, TOWER_OPERATION_ID=op['id'])
    try:
        process = popen([cmd[0], '-m', 'runtime.operation_worker', *cmd[1:]], env=env, **kwargs)
        import psutil
        try:
            creation_time = psutil.Process(process.pid).create_time()
        except psutil.NoSuchProcess:
            creation_time = None
        if creation_time is not None:
            store.launched(op['id'], {'pid': process.pid, 'creation_time': creation_time})
    except (OSError, ValueError) as exc:
        store.transition(op['id'], op['revision'], 'failed', error={'code': 'launch_failed', 'message': str(exc)})
        raise
    return store.get(op['id'])


def resolve(root, operation_id):
    store = ledger(root)
    return store.reconcile(operation_id, worker_alive)


def retry(root, cfg, kind, command, profile_path):
    """Resolve an identical retried command before legacy process guards."""
    if not command.get('idempotency_key'):
        return None
    store = ledger(root)
    with store._db() as db:
        row = db.execute('SELECT id FROM operations WHERE idempotency_key=?', (command['idempotency_key'],)).fetchone()
    if row is None:
        return None
    payload = {k: v for k, v in command.items() if k != 'idempotency_key'}
    original = store.get(row[0])
    current = context(root, cfg, payload, profile_path)
    identity = ('instance', 'account', 'serial', 'rendering', 'profile', 'device_key', 'selected_run')
    original_payload = {k: v for k, v in original['request'].items() if k != 'battle_envelope'}
    payload.pop('battle_envelope', None)
    if (original['kind'] != kind or original_payload != payload
            or any(original['context'].get(key) != current.get(key) for key in identity)):
        raise Conflict('Idempotency key already belongs to another command or target')
    return resolve(root, row[0])


def require_revision(root, body, allowed):
    if not body.get('operation_id') or not isinstance(body.get('expected_revision'), int):
        raise Conflict('operation_id and expected_revision are required')
    try:
        op = resolve(root, body['operation_id'])
    except KeyError:
        raise Conflict('Unknown operation') from None
    if op['revision'] != body['expected_revision'] or op['status'] not in allowed:
        raise Conflict('Operation changed; refresh its status before trying again')
    return op


def cancel(root, body):
    op = require_revision(root, body, ('accepted', 'running', 'cancelling'))
    store = ledger(root)
    if op['status'] == 'cancelling':
        return op
    op = store.transition(op['id'], op['revision'], 'cancelling', step='stop_requested')
    if op['kind'] not in ('scan', 'calibrate', 'observe'):
        # Driver cancellation stops input, never surrenders the game battle.
        import psutil
        if worker_alive(op['worker']):
            process = psutil.Process(op['worker']['pid'])
            family = process.children(recursive=True) + [process]
            for child in family:
                try:
                    child.terminate()
                except psutil.NoSuchProcess:
                    pass
            _, alive = psutil.wait_procs(family, timeout=3)
            if alive:
                return op
        op = store.get(op['id'])
        if op['status'] != 'cancelling':
            return op
        return store.transition(op['id'], op['revision'], 'cancelled', step='driver_stopped')
    directory = Path(op['context']['artifact_dir'])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / ('scan_stop' if op['kind'] == 'scan' else 'calibrate_stop')).write_text(op['id'], encoding='utf-8')
    return op


def project_processes(root, rows):
    """Attach durable identity only to a verified live worker/launcher family."""
    import psutil
    output = copy.deepcopy(rows)
    for prior in ledger(root).active():
        op = resolve(root, prior['id'])
        if op['status'] not in ('accepted', 'running', 'cancelling') or not worker_alive(op.get('worker')):
            continue
        try:
            process = psutil.Process(op['worker']['pid'])
            family = {process.pid, *(parent.pid for parent in process.parents())}
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        row = next((row for row in output if row.get('pid') in family), None)
        if row is None:
            row = {'pid': process.pid, 'runner': op['kind'], 'cmdline': ''}
            output.append(row)
        row.update(operation_id=op['id'], operation_revision=op['revision'], operation_context=public(op)['context'], operation=public(op))
        row['stop_flag'] = (Path(root) / 'logs' / op['context']['instance'] / 'stop_after_run').exists()
    return output
