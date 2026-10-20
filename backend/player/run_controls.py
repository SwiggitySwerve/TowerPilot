"""Pure effective battle settings. Saved profiles and CONFIG are never mutated.

Numbers here describe configuration only; driver-owned clocks and counters must
survive edits. A null override removes that override and inherits the envelope.
"""
import copy

from player.gather_settings import resolve_ad_gem_options, ORBIT_TIMING_FIELDS

from towerpilot_workflows.control_settings import FIELDS, flatten, validate_patch, merge_patch

REWARD_GATHER_KEYS = ('free_store_gems', 'guild_store', 'quests_8h', 'quest_rewards', 'guild')
REWARD_GLOBAL_KEYS = ('free_store_gems', 'daily_missions', 'event_missions', 'guild_progress')

def resolve(preset: dict, config: dict) -> dict:
    gather = preset.get('gather', {})
    options = resolve_ad_gem_options(gather.get('ad_gem_options'))
    orbit = gather.get('gem_orbit') or {}
    global_rewards = preset.get('global_behaviors', {})
    interval = options['confirmed_cooldown_sec']
    # A range is retained in the frozen preset; the normalized scalar is its
    # lower bound until an explicit numeric override replaces both endpoints.
    settings = {'routines': {
        'ad_gems': {'enabled': gather.get('ad_gems', True),
                    'interval_sec': interval[0], 'window_sec': options['attempt_timeout_sec']},
        'floating_gems': {'enabled': orbit.get('enabled', False),
                          'interval_sec': orbit.get('interval_sec', ORBIT_TIMING_FIELDS['interval_sec']['default']),
                          'window_sec': orbit.get('attempt_timeout_sec', ORBIT_TIMING_FIELDS['attempt_timeout_sec']['default']),
                          'tap_interval_sec': orbit.get('retry_interval_sec', ORBIT_TIMING_FIELDS['retry_interval_sec']['default'])},
        'shopping': {'enabled': ((preset['shopping_plan'].get('enabled', True)) if preset.get('shopping_plan') is not None else bool(preset.get('shopping'))),
                     'interval_sec': (preset.get('shopping_plan') or {}).get('interval_sec', preset.get('shop_interval_sec', 90))},
        'rewards': {'enabled': any(gather.get(key, key in ('quests_8h', 'quest_rewards', 'guild')) for key in REWARD_GATHER_KEYS)
                    or any(global_rewards.get(key, False) for key in REWARD_GLOBAL_KEYS)},
        'abilities': {'enabled': True}, 'rescue': {'enabled': True},
        'repeat': {'enabled': config.get('repeat', True)},
    }}
    for routine, enabled in preset.get('automation', {}).items():
        if routine in settings['routines']:
            settings['routines'][routine]['enabled'] = (enabled and settings['routines'][routine]['enabled']) if routine == 'shopping' else enabled
    settings['shopping_plan'] = copy.deepcopy(preset.get('shopping_plan'))
    return settings


def apply_to_preset(preset: dict, settings: dict) -> dict:
    """Materialize supported aliases in a copy; runtime gates own enablement.

    In particular, disabling shopping must not erase the frozen plan/counters.
    Only driver gates interpret abilities/rescue/repeat.
    """
    validate_patch(settings)
    out = copy.deepcopy(preset)
    routines = settings.get('routines', {})
    if settings.get('shopping_plan') is not None:
        out['shopping_plan'] = copy.deepcopy(settings['shopping_plan'])
    gather = out.setdefault('gather', {})
    ad = routines.get('ad_gems', {})
    if ad.get('enabled') is not None:
        gather['ad_gems'] = ad['enabled']
    opts = gather.setdefault('ad_gem_options', {})
    if ad.get('interval_sec') is not None:
        opts['confirmed_cooldown_sec'] = [ad['interval_sec'], ad['interval_sec']]
    if ad.get('window_sec') is not None:
        opts['attempt_timeout_sec'] = ad['window_sec']
    orbit = gather.setdefault('gem_orbit', {})
    for source, target in (('enabled', 'enabled'), ('interval_sec', 'interval_sec'),
                           ('window_sec', 'attempt_timeout_sec'), ('tap_interval_sec', 'retry_interval_sec')):
        value = routines.get('floating_gems', {}).get(source)
        if value is not None:
            orbit[target] = value
    shopping = routines.get('shopping', {})
    if shopping.get('interval_sec') is not None:
        out['shop_interval_sec'] = shopping['interval_sec']
    if routines.get('rewards', {}).get('enabled') is False:
        for key in REWARD_GATHER_KEYS:
            gather[key] = False
        global_rewards = out.setdefault('global_behaviors', {})
        for key in REWARD_GLOBAL_KEYS:
            global_rewards[key] = False
    return out
