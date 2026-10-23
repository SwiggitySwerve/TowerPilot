"""Allowlisted, pure battle control patch validation and immutable merging."""
import copy
import math

from towerpilot_workflows.action_contract import CATALOG

# The controls of every migrated action are generated from its catalog entry, so a range exists once. The four
# gates below have no catalog entry yet (they are not timed actions of the pilot); each moves with its migration.
_GATES = {'rewards': {'enabled': bool}, 'abilities': {'enabled': bool}, 'rescue': {'enabled': bool}, 'repeat': {'enabled': bool}}
FIELDS = {**CATALOG.control_fields(), **_GATES}


def flatten(value: dict, prefix: str = '') -> dict:
    result = {}
    for key, item in value.items():
        path = f'{prefix}.{key}' if prefix else key
        if isinstance(item, dict) and path != 'shopping_plan':
            result.update(flatten(item, path))
        else:
            result[path] = item
    return result


def validate_patch(patch: dict) -> dict:
    """Return an independent allowlisted patch, rejecting coercion and NaN."""
    if not isinstance(patch, dict) or set(patch) - {'routines', 'shopping_plan'}:
        raise ValueError('Unknown control patch fields')
    if patch.get('shopping_plan') is not None:
        from towerpilot_workflows.shopping_plan import normalize_plan
        normalize_plan(patch['shopping_plan'])
    routines = patch.get('routines', {})
    if not isinstance(routines, dict):
        raise ValueError('routines must be a mapping')
    for routine, values in routines.items():
        if routine not in FIELDS or not isinstance(values, dict):
            raise ValueError(f'Unknown routine or invalid mapping: {routine}')
        for field, value in values.items():
            spec = FIELDS[routine].get(field)
            if spec is None:
                raise ValueError(f'Unknown control: routines.{routine}.{field}')
            if value is None:
                continue
            valid = (type(value) is bool if spec is bool else
                     type(value) in (int, float) and math.isfinite(value)
                     and spec[0] <= value <= spec[1])
            if not valid:
                raise ValueError(f'Invalid value: routines.{routine}.{field}')
    if not flatten(patch):
        raise ValueError('Empty control patch')
    return copy.deepcopy(patch)


def merge_patch(base: dict, overrides: dict) -> dict:
    """Apply sparse overrides to an independent copy; null inherits base."""
    out = copy.deepcopy(base)
    for key, value in overrides.items():
        if value is None:
            continue
        if key == 'shopping_plan':
            out[key] = copy.deepcopy(value)
        elif isinstance(value, dict):
            out[key] = merge_patch(out.get(key, {}), value)
        else:
            out[key] = copy.deepcopy(value)
    return out
