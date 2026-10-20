"""Read models and command admission for the local battle workspace."""
import copy
import time

from control import operations
from towerpilot_workflows.battles import Battles


def ledger(root):
    return Battles(operations.ledger(root).path)


def reconcile(root, store, device=None):
    for battle in store.active(device):
        operation = operations.resolve(root, battle['operation_id'])
        if operation['status'] not in ('accepted', 'running', 'cancelling'):
            store.finish(battle['id'], battle['generation'], reason='driver_observation_lost',
                         status='interrupted', evidence={'operation_status': operation['status']})


def public(store, battle):
    result = copy.deepcopy(battle)
    result['context'].pop('config', None)
    envelope = result['envelope']
    envelope.pop('config', None)
    envelope.pop('profile', None)
    preset = envelope.get('preset', {})
    runtime = result.get('runtime', {})
    boundary = result.get('boundary_evidence') or {}
    final_wave = boundary.get('last_observed_wave', boundary.get('previous_wave'))
    result.update(label=preset.get('label'), blueprint=(preset.get('_source') or {}).get('blueprint'),
                  tier=preset.get('tier'), started_at=result.get('observed_started_at'),
                  wave=runtime.get('observed_wave'), final_wave=final_wave,
                  wave_provenance='last_observed' if final_wave is not None else 'unknown',
                  result=result.get('outcome'), end_reason=result.get('reason'),
                  effective=copy.deepcopy(result['applied_controls']))
    result['commands'] = store.commands(battle['id'])
    return result


def active(root, device):
    store = ledger(root)
    reconcile(root, store, device)
    rows = store.active(device)
    from player.shopping_plan import catalog
    return dict(battle=public(store, rows[0]) if rows else None,
                catalog=catalog(), server_time=time.time())


def command(root, operation_id, body, *, action=False):
    if not isinstance(body, dict):
        raise ValueError('Command must be an object')
    for key in ('battle_id', 'generation', 'idempotency_key'):
        if not isinstance(body.get(key), str) or not body[key]:
            raise ValueError(f'{key} is required')
    if type(body.get('expected_revision')) is not int:
        raise ValueError('expected_revision is required')
    operation = operations.resolve(root, operation_id)
    if operation['status'] not in ('accepted', 'running'):
        raise operations.Conflict('The battle driver is no longer active')
    store = ledger(root)
    args = (body['battle_id'], operation_id, body['generation'])
    if action:
        accepted = store.request_action(*args, body.get('action'), body['idempotency_key'],
                                        expected_revision=body['expected_revision'])
    else:
        from control.run_workspace import normalize_changes
        patch = normalize_changes(body.get('changes', body.get('patch')))
        accepted = store.request_controls(*args, body['expected_revision'], patch, body['idempotency_key'])
    battle = public(store, store.get(body['battle_id']))
    return dict(ok=True, command=accepted, battle=battle, control_revision=battle['control_revision'])
