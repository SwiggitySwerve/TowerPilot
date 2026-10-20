"""Pure saved run controls; persistence, revisions and locking belong to callers.

Editing a run clones shared policies before changing their contents. Reading a
legacy policy offers a reviewable queue conversion without installing it.
"""
from __future__ import annotations

import copy

from player import playerprofile, run_controls, shopping_plan


def normalize_changes(patch: dict) -> dict:
    """Accept the HTTP dotted-path patch or the canonical nested settings patch."""
    if not isinstance(patch, dict):
        raise ValueError('changes must be an object')
    if any('.' in key for key in patch):
        nested = {}
        for path, value in patch.items():
            if path == 'shopping_plan':
                nested[path] = copy.deepcopy(value)
                continue
            parts = path.split('.')
            if len(parts) != 3 or parts[0] != 'routines':
                raise ValueError(f'Unknown saved control: {path}')
            nested.setdefault('routines', {}).setdefault(parts[1], {})[parts[2]] = copy.deepcopy(value)
    else:
        nested = copy.deepcopy(patch)
    return run_controls.validate_patch(nested)


def _blueprint(profile: dict, run: str) -> dict:
    if not isinstance(run, str) or run not in profile.get('blueprints', {}):
        raise ValueError(f'Unknown blueprint: {run}')
    return profile['blueprints'][run]


def _capabilities(bp: dict) -> dict:
    supported = set(run_controls.FIELDS) if bp.get('kind') in ('coin', 'tournament') else {'ad_gems', 'floating_gems'}
    controls = [f'routines.{routine}.{field}'
                for routine, fields in run_controls.FIELDS.items()
                for field in fields
                if routine in supported]
    if bp.get('kind') in ('coin', 'tournament'):
        controls.append('shopping_plan')
    return {'controls': controls, 'actions': []}


def read(profile: dict, cfg: dict, run: str) -> dict:
    """Return saved effective controls and a separate explicit conversion draft."""
    bp = _blueprint(profile, run)
    preset = playerprofile.compile_preset(profile, run)
    constraints = {f'routines.{routine}.{field}': {'min': spec[0], 'max': spec[1]}
                   for routine, fields in run_controls.FIELDS.items()
                   for field, spec in fields.items() if spec is not bool}
    result = {'blueprint': run, 'settings': run_controls.resolve(preset, cfg),
              'catalog': shopping_plan.catalog(), 'capabilities': _capabilities(bp),
              'constraints': constraints}
    if bp.get('kind') not in ('coin', 'tournament'):
        result['notice'] = 'This driver supports saved collection settings. Live controls and per-battle history are currently available for farm and tournament drivers.'
    source = profile.get('policies', {}).get('shopping_lists', {}).get(bp.get('shopping'))
    if source is not None and not (isinstance(source, dict) and source.get('version') == 2):
        directives = source if isinstance(source, list) else source.get('directives', [])
        conversion = shopping_plan.convert_legacy(copy.deepcopy(directives),
                                                   interval_sec=preset.get('shop_interval_sec', 90))
        if isinstance(source, dict):
            conversion['plan']['enabled'] = source.get('enabled', True)
        result['legacy_conversion'] = conversion
    return result


def _owned_policy(profile: dict, run: str, section: str, slot: str) -> dict:
    bp = _blueprint(profile, run)
    table = profile.setdefault('policies', {}).setdefault(section, {})
    ref = bp.get('shopping') if slot == 'shopping' else bp.setdefault('policies', {}).get(slot)
    original = copy.deepcopy(table.get(ref, {}))
    stem = f'{run}_controls_{slot}'
    name, suffix = stem, 2
    while name in table:
        shared = any(other_name != run and
                     (other.get('shopping') if slot == 'shopping' else other.get('policies', {}).get(slot)) == name
                     for other_name, other in profile.get('blueprints', {}).items())
        if name == ref and not shared:
            break
        name, suffix = f'{stem}_{suffix}', suffix + 1
    table[name] = original
    if slot == 'shopping':
        bp['shopping'] = name
    else:
        bp.setdefault('policies', {})[slot] = name
    return table[name]


def _assign(node: dict, key: str, value) -> None:
    if value is None:
        node.pop(key, None)
    else:
        node[key] = copy.deepcopy(value)


def update(profile: dict, cfg: dict, run: str, patch: dict) -> dict:
    """Return {profile, settings, ...}; inputs and all unrelated runs stay intact."""
    changes = normalize_changes(patch)
    allowed = set(_capabilities(_blueprint(profile, run))['controls'])
    for path in run_controls.flatten(changes):
        if path not in allowed:
            raise ValueError(f'Control is unavailable for this run: {path}')
    updated = copy.deepcopy(profile)
    bp = _blueprint(updated, run)
    routines = changes.get('routines', {})
    gather = None
    if any(name in routines for name in ('ad_gems', 'floating_gems')):
        gather = _owned_policy(updated, run, 'gather', 'gather')
    for routine, values in routines.items():
        if 'enabled' in values:
            _assign(bp.setdefault('automation', {}), routine, values['enabled'])
    if 'ad_gems' in routines:
        ad = routines['ad_gems']
        if 'enabled' in ad:
            _assign(gather, 'ad_gems', ad['enabled'])
        if 'interval_sec' in ad:
            value = ad['interval_sec']
            _assign(gather.setdefault('ad_gem_options', {}), 'confirmed_cooldown_sec',
                    None if value is None else [value, value])
        if 'window_sec' in ad:
            _assign(gather.setdefault('ad_gem_options', {}), 'attempt_timeout_sec', ad['window_sec'])
    if 'floating_gems' in routines:
        orbit = gather.setdefault('gem_orbit', {})
        for source, target in (('enabled', 'enabled'), ('interval_sec', 'interval_sec'),
                               ('window_sec', 'attempt_timeout_sec'), ('tap_interval_sec', 'retry_interval_sec')):
            if source in routines['floating_gems']:
                _assign(orbit, target, routines['floating_gems'][source])
    if 'shopping_plan' in changes:
        if changes['shopping_plan'] is None:
            raise ValueError('Saved shopping_plan cannot be null; disable shopping to retain its settings')
        normalized = shopping_plan.normalize_plan(changes['shopping_plan'])
        _owned_policy(updated, run, 'shopping_lists', 'shopping')
        updated['policies']['shopping_lists'][bp['shopping']] = normalized
    if 'interval_sec' in routines.get('shopping', {}):
        value = routines['shopping']['interval_sec']
        _assign(bp, 'shop_interval_sec', value)
        source = updated.get('policies', {}).get('shopping_lists', {}).get(bp.get('shopping'))
        if isinstance(source, dict) and source.get('version') == 2:
            owned = _owned_policy(updated, run, 'shopping_lists', 'shopping')
            _assign(owned, 'interval_sec', value)
    if gather is not None:
        problems = playerprofile._validate_gather(f'blueprints.{run}.gather', gather)
        if problems:
            raise ValueError('; '.join(problems))
    result = read(updated, cfg, run)
    return {'profile': updated, **result}
