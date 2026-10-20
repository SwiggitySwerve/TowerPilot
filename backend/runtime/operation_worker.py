"""Isolated worker bootstrap for every dashboard long-running launch."""
import runpy
import sys
import os
from functools import partial
from pathlib import Path

from runtime.operations import Conflict, environment_operation, file_revision, restore_worker_context, worker_operation


def main():
    from runtime import diagnostics
    ledger, operation_id = environment_operation()
    op = ledger.get(operation_id) if ledger else None
    identity = op['context'] if op else {}
    # Bootstrap errors happen before worker_operation (notably lease refusal).
    fields = {'operation_id': operation_id, 'instance': identity['instance']} if op else {}
    log_root = Path(os.environ['TOWER_OPERATION_DB']).parent if op else Path(__file__).resolve().parents[1] / 'logs'
    emit = partial(diagnostics.event_to, log_root / identity.get('instance', '_worker'))
    with diagnostics.context(**fields):
        with diagnostics.attempt('operation.bootstrap', emit=emit) as attempt:
            try:
                _main()
            except SystemExit as exc:
                if exc.code in (None, 0):
                    attempt.finish('exited', exit_code=exc.code)
                raise
            if ledger:
                attempt.finish(ledger.get(operation_id)['status'])


def _main():
    ledger, operation_id = environment_operation()
    if ledger:
        op = ledger.get(operation_id)
        from runtime.device_lease import acquire
        try:
            acquire(op['context']['serial'], op['context'].get('adb_host', '127.0.0.1'), op['context'].get('adb_port', 5037))
            profile = op['context'].get('profile_path')
            if profile and not op['request'].get('battle_envelope') and file_revision(profile) != op['context'].get('profile_revision'):
                raise Conflict('Profile changed after this operation was accepted')
        except Exception as exc:
            op = ledger.get(operation_id)
            ledger.transition(op['id'], op['revision'], 'failed', error={'code': 'device_busy', 'message': str(exc)})
            raise
        from device import adbclient
        adbclient._HOST = (op['context'].get('adb_host', '127.0.0.1'), op['context'].get('adb_port', 5037))
        import settings
        restore_worker_context(settings)
    with worker_operation():
        args = sys.argv[1:]
        if not args:
            raise ValueError('Worker target is required')
        if args[0] == '-m':
            module = args[1]
            sys.argv = [module, *args[2:]]
            runpy.run_module(module, run_name='__main__')
        else:
            sys.argv = args
            runpy.run_path(args[0], run_name='__main__')


if __name__ == '__main__':
    main()
