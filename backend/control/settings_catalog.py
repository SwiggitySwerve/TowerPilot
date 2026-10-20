"""Explicit dashboard settings, independent of device-bound runner imports."""
import copy
import math
from player.gather_settings import AD_GEM_FIELDS, ORBIT_TIMING_FIELDS


def field(key, label, kind, default, low=None, high=None, unit='', description='', whole_numbers=False):
    return dict(key=key, path=key, label=label, type=kind, default=default,
                min=low, max=high, step=1 if kind == 'integer' or whole_numbers else 'any',
                wholeNumbers=whole_numbers,
                unit=unit, description=description)


def read(data, key, default):
    node = data
    for part in key.split('.'):
        if not isinstance(node, dict) or part not in node:
            return copy.deepcopy(default)
        node = node[part]
    return copy.deepcopy(node)


def write(data, key, value):
    parts = key.split('.')
    for part in parts[:-1]:
        if part not in data:
            data[part] = {}
        if not isinstance(data[part], dict):
            raise ValueError(f'{part}: existing value is not an object')
        data = data[part]
    data[parts[-1]] = copy.deepcopy(value)


def validate(spec, value):
    kind = spec['type']
    if kind == 'boolean':
        valid = isinstance(value, bool)
    elif kind in ('range', 'point'):
        valid = isinstance(value, list) and len(value) == 2
    else:
        valid = not isinstance(value, bool) and isinstance(value, (int, float))
        if kind == 'integer':
            valid = type(value) is int
    if not valid:
        raise ValueError(f"{spec['label']}: expected {kind}")
    if kind == 'boolean':
        return
    numbers = value if kind in ('range', 'point') else [value]
    for number in numbers:
        if spec.get('wholeNumbers') and type(number) is not int:
            raise ValueError(f"{spec['label']}: both bounds must be integers")
        if (isinstance(number, bool) or not isinstance(number, (int, float))
                or (isinstance(number, float) and not math.isfinite(number))):
            raise ValueError(f"{spec['label']}: use finite numbers")
        if spec['min'] is not None and number < spec['min']:
            raise ValueError(f"{spec['label']}: minimum is {spec['min']}")
        if spec['max'] is not None and number > spec['max']:
            raise ValueError(f"{spec['label']}: maximum is {spec['max']}")
    if kind == 'range' and value[0] > value[1]:
        raise ValueError(f"{spec['label']}: minimum must not exceed maximum")


def catalog(cfg, profile, editable):
    modules = []

    def add(ident, title, group, scope, path, data, specs, description):
        modules.append(dict(id=ident, title=title, group=group, scope=scope,
                            description=description, editable=scope != 'profile' or editable,
                            fields=[dict(s, value=read(data, s['key'], s['default'])) for s in specs],
                            storage_path=path))

    add('tap', 'Tap timing', 'Machine', 'machine', ['tap'], cfg.get('tap', {}), [
        field('jitter_ms', 'Delay before each tap', 'range', [15, 50], 0, 5000, 'ms'),
        field('jitter_px', 'Position jitter', 'integer', 4, 0, 40, 'px'),
        field('max_rate_per_sec', 'Maximum tap rate', 'number', 12, .1, 30, 'taps/sec')],
        'Shared tap timing for every emulator on this machine.')
    inst = cfg.get('active_instance', 'main')
    instance = (cfg.get('instances') or {}).get(inst) or {}
    for ident, title, specs in [
        ('loop', 'Observation loop', [field('fps', 'Frames per second', 'number', 2, .1, 30, 'fps'), field('dry_run', 'Log taps without sending them', 'boolean', False)]),
        ('missions', 'Mission visits', [field('visit_delay_sec', 'Delay between mission visits', 'range', [60, 600], 0, 86400, 'sec')]),
        ('fleet', 'Fleet windows', [field('hold_window', 'Hold window before fleet', 'integer', 100, 0, 100000, 'waves'), field('post_window', 'Window after fleet', 'integer', 150, 0, 100000, 'waves')])]:
        data = dict(cfg.get(ident) or {})
        data.update(instance.get(ident) or {})
        add(ident, title, 'Emulator', 'instance', ['instances', inst, ident], data, specs,
            'Applies to the selected emulator when its runner next starts.')
    add('logging', 'Logging', 'Machine', 'machine', ['logging'], cfg.get('logging', {}), [
        field('screenshot_on_trigger', 'Save screenshots on triggers', 'boolean', True),
        field('bench_interval_sec', 'Performance log interval', 'number', 30, 1, 86400, 'sec')], 'Shared diagnostic settings.')
    policies = profile.get('policies') or {}
    add('rewards', 'Global rewards', 'Rewards', 'profile', ['policies', 'global_behaviors'], policies.get('global_behaviors') or {}, [
        field(k, label, 'boolean', default) for k, label, default in [
            ('free_store_gems', 'Free Store gems', False), ('daily_missions', 'Daily missions', False),
            ('event_missions', 'Event missions', False), ('guild_progress', 'Guild progress', False)]], 'Shared by runs in this account profile.')
    add('global_abilities', 'Global abilities', 'Abilities', 'profile', ['policies', 'global_behaviors'],
        policies.get('global_behaviors') or {}, [
            field('demon_mode_always', 'Use Demon Mode whenever ready', 'boolean', False)],
        'Overrides the held Demon Mode rescue timing in every run in this profile.')
    for name, gather in sorted((policies.get('gather') or {}).items()):
        path = ['policies', 'gather', name]
        label = gather.get('label') or name.replace('_', ' ')
        affected = [bp.get('label', key) for key, bp in (profile.get('blueprints') or {}).items()
                    if (bp.get('policies') or {}).get('gather') == name]
        description = 'Shared gathering policy. Runs: ' + (', '.join(affected) or 'No runs currently bind this policy')
        add('gather:' + name, 'Gathering · ' + label, 'Gathering', 'profile', path, gather, [
            *[field(k, title, 'boolean', k in ('quests_8h', 'quest_rewards', 'guild')) for k, title in [
                ('quests_8h', 'Eight-hour quests'), ('quest_rewards', 'Quest rewards'),
                ('guild', 'Guild rewards'), ('free_store_gems', 'Free Store gems'), ('guild_store', 'Guild store')]]], description)
        add('ad:' + name, 'Ad Gems · ' + label, 'Ad Gems', 'profile', path, gather, [
            field('ad_gems', 'Collect HUD Ad Gems', 'boolean', True),
            field('gem_delay_sec', 'Gem response delay', 'range', [3, 10], 0, 3600, 'sec',
                  'Random response delay after observing a HUD Ad Gems offer.', whole_numbers=True),
            *[field('ad_gem_options.' + key, spec['label'],
                    'integer' if spec['type'] == 'int' else spec['type'],
                    spec['default'], spec['min'], spec['max'], spec['unit'], spec['description'])
              for key, spec in AD_GEM_FIELDS.items()]], description)
        add('orbit:' + name, 'Orbiting gems · ' + label, 'Orbit', 'profile', path, gather, [
            field('gem_orbit.enabled', 'Enable timed orbit taps', 'boolean', False),
            field('gem_orbit.center', 'Orbit center [x, y]', 'point', [510, 805], 0, 2559, 'px'),
            field('gem_orbit.radius', 'Radius', 'number', 170, 1, 1000, 'px'),
            field('gem_orbit.angle_deg', 'Angle', 'number', 135, -360, 360, 'degrees'),
            *[field('gem_orbit.' + key, spec['label'], 'number', spec['default'],
                    spec['min'], spec['max'], 'sec', spec['description'])
              for key, spec in ORBIT_TIMING_FIELDS.items()],
            field('gem_orbit.taps', 'Taps per set', 'integer', 3, 1, 20),
            field('gem_orbit.jitter_frac', 'Position variation', 'number', .03, 0, .5),
            field('gem_orbit.spread_deg', 'Angle between taps', 'number', 6, 0, 180, 'degrees')], description)
    return modules
