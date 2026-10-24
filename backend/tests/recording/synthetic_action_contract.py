"""The same action through the real Dashboard, recorded for the UI's tests (roadmap item 6, A2-7 backend request B1). TEST-ONLY.

`synthetic_probe` is registered, twice (two configured instances), only in a COPY of the action catalog that this generator swaps in with `use_catalog`.
No production file names it (test_the_synthetic_action_is_named_in_no_production_file): the app's non-test code must not either (spec 2.6), so these
recordings live in their own fixture, backend/tests/fixtures/synthetic_action_contract_v1.json, which the app loads from its tests only. They are NOT part of
dashboard_contract_pages_v1.json and never reach `src/contract/generated`.

Every answer is the real Flask route's (frontend/dashboard.py) over a synthetic world (the World of test_dashboard_contract.py: a temporary root, ledger and
leases, one fixed clock, an in-memory adb server and process table). The driver is a real `BattleSession` with a real `ActionSession`; the extension's handler,
binding and saved adapter are the ones test_action_synthetic_extension.py proves (`Probe`, `ProbeBinding`, `ProbeSaved`). Nothing touches a live dashboard,
device, ledger, lease or process.

  one family, `synthetic_action`:
    active / live controls   the two instances in GET /api/battles/active (item, key, descriptor, values, capabilities); a live-only field accepted and applied, refused outside its
                             bounds (400), refused for an unknown field or instance, a null that inherits the frozen value
    Run now                  accepted, started, completed (effect `unconfirmed`: the handler cannot confirm), the command and the execution it started linked in one read, a variant
                             token accepted, an unknown variant refused, the same key replayed after the driver ended (200, the same receipt), the same key with another payload (409),
                             a stale generation (409), an unknown reply (500 command_outcome_unknown) and the read that settles it
    history                  the executions of the battle in GET /api/battles/<id>
    newer schema             a projection written by a driver of a newer build (schema_version 2)
    next unknown             an action that cannot say when it is next due: `next.due_at` null with `next.reason`
    harvest                  turning Harvest on with the action present: the overlay is for the two gem routines only
"""
import contextlib
from types import SimpleNamespace

from control import battles as battle_api
from control import harvest
from player import playerprofile, saved_controls
from runtime import action_session as action_session_module
from runtime.action_session import ActionSession
from towerpilot_workflows import actions as actions_module
from towerpilot_workflows.action_contract import CATALOG, use_catalog

import test_dashboard_contract as dashboard
from test_action_synthetic_extension import DEFINITION, KEYS, Probe, ProbeBinding, ProbeSaved
from test_dashboard_contract import Driver, action_body, action_url, raising, with_orbit

SA = 'synthetic_action'
NOTE = (__doc__ or '').strip()
A, B = KEYS


@contextlib.contextmanager
def world(gen, name):
    """A contract world with the extension registered in a catalog copy (and its schema row and saved adapter), the way test_action_synthetic_extension.py does."""
    with gen.world(name) as w:
        catalog = CATALOG.copy()
        catalog.register(DEFINITION)
        w.mp.setattr(playerprofile, 'GATHER_KEYS', playerprofile.GATHER_KEYS + ('synthetic_probe',))
        w.mp.setitem(saved_controls.SAVED, 'synthetic_probe_saved', ProbeSaved())
        w.mp.setattr(actions_module, 'time', w.clock)
        w.mp.setattr(w.dash, '_HARVEST_HOST', {'last_tick_at': None, 'last_error': None})      # the dashboard remembers its last tick for the whole process: each world starts without one
        w.edit_profile(lambda profile: profile['policies']['gather']['shared'].update(synthetic_probe={'probe_a': {'interval_sec': 60}, 'probe_b': {'interval_sec': 90}}))
        with use_catalog(catalog):
            yield w


class Host:
    """The run driver of one world: the contract's driver (the real BattleSession launched through POST /api/control) with the extension's two instances bound to it."""

    def __init__(self, w, key):
        self.w = w
        self.d = Driver(w, key, origin='started')
        self.session = ActionSession.for_battle(self.d.session, 'test')
        clock = self.session.clock = SimpleNamespace(mono=w.clock.monotonic, wall=w.clock.time)
        self.probes = {name: Probe(self.session, name.partition('@')[2], clock, interval=interval) for name, interval in zip(KEYS, (60, 90))}
        self.d.rs.action_bindings = {name: ProbeBinding(probe) for name, probe in self.probes.items()}
        self.d.observe()

    @property
    def battle(self):
        return self.d.battle

    def tick(self, *, polls=True, visible=True):
        if polls:
            for probe in self.probes.values():
                probe.poll()
        self.d.checkpoint(visible)

    def live(self, changes, key, case=None, *, expect=200):
        body = dict(battle_id=self.battle['id'], generation=self.d.generation, expected_revision=self.battle['control_revision'], idempotency_key=key, changes=changes)
        url = action_url(self.d.op, 'live-controls')
        reply = self.w.post(SA, case, url, body) if case else self.w.plain_post(url, body)
        assert reply.status_code == expect, reply.get_json()
        return reply.get_json()

    def run_now(self, action, key, case=None, *, expect=200, **changes):
        body = action_body(self.d, action, key, **changes)
        url = action_url(self.d.op)
        reply = self.w.post(SA, case, url, body) if case else self.w.plain_post(url, body)
        assert reply.status_code == expect, reply.get_json()
        return reply

    def read(self, case):
        reply = self.w.get(SA, case, '/api/battles/active')
        assert reply.status_code == 200
        return reply.get_json()['battle']

    def commands(self):
        return {entry['request_keys'][0]: entry for entry in self.d.store.commands(self.battle['id'])}

    def items(self, battle):
        return {item['key']: item for item in battle['runtime']['actions']['items']}

    def pause(self, *keys):
        self.live({f'routines.{key}.enabled': False for key in keys}, 'pause-' + '-'.join(key.partition('@')[2] for key in keys))
        self.tick(polls=False)


def synthetic_action_cases(gen):
    with world(gen, 'synthetic_controls') as w:
        h = Host(w, 'controls')
        h.d.publish()
        active = h.read('synthetic_active_two_instances')
        shown = h.items(active)
        assert [item['key'] for item in active['runtime']['actions']['items']] == ['ad_gems', 'floating_gems', 'shopping', A, B]
        for key in KEYS:
            item = shown[key]
            assert (item['id'], item['instance'], item['label'], item['state'], item['coverage']) == ('synthetic_probe', key.partition('@')[2], 'Synthetic probe', 'due', 'full'), item
            assert [(field['path'], field['live'], field['saved']) for field in item['descriptor']['fields']] == [('enabled', True, True), ('interval_sec', True, True), ('burst', True, False)]
            assert [variant['token'] for variant in item['descriptor']['variants']] == ['fast', 'slow'] and item['descriptor']['capabilities']['run_now'] is True
            assert item['next']['basis'] == 'start_to_start' and item['last'] is None and item['active'] is None
        assert shown[A]['values'] == dict(enabled=True, interval_sec=60, burst=3) and shown[B]['values'] == dict(enabled=True, interval_sec=90, burst=3)
        assert set(active['capabilities']['controls']) >= {f'routines.{key}.{field}' for key in KEYS for field in ('enabled', 'interval_sec', 'burst')}
        assert set(active['capabilities']['actions']) >= {*KEYS, *(f'{key}:{variant}' for key in KEYS for variant in Probe.VARIANTS)}
        before = h.battle['control_revision']
        accepted = h.live({f'routines.{A}.burst': 7}, 'burst-1', 'synthetic_live_field_accepted')
        assert accepted['command']['state'] == 'requested' and accepted['control_revision'] == before + 1
        h.tick(polls=False)
        applied = h.read('synthetic_live_field_read_applied')
        assert h.probes[A].burst == 7 and h.probes[B].burst == 3 and h.commands()['burst-1']['state'] == 'applied'
        assert applied['effective']['routines'][A]['burst'] == 7 and h.items(applied)[A]['values']['burst'] == 7 and h.items(applied)[B]['values']['burst'] == 3
        revision = h.battle['control_revision']
        refused = h.live({f'routines.{A}.burst': 99}, 'burst-2', 'synthetic_live_field_out_of_bounds_refused', expect=400)
        assert f'Invalid value: routines.{A}.burst' in refused['error'] and h.battle['control_revision'] == revision
        assert 'Unknown control' in h.live({f'routines.{A}.nothing': 1}, 'unknown-field', 'synthetic_live_field_unknown_refused', expect=400)['error']
        assert 'Unsupported controls' in h.live({'routines.synthetic_probe@probe_z.burst': 4}, 'unknown-instance', 'synthetic_live_instance_unknown_refused', expect=400)['error']
        h.live({f'routines.{A}.burst': None}, 'burst-3', 'synthetic_live_field_null_inherits')
        h.tick(polls=False)
        inherited = h.read('synthetic_live_field_null_inherits_read')
        assert h.probes[A].burst == 3 and h.items(inherited)[A]['values']['burst'] == 3 and 'burst' not in h.battle['overrides'].get('routines', {}).get(A, {})
    with world(gen, 'synthetic_run_now') as w:
        h = Host(w, 'run-now')
        h.pause(*KEYS)
        assert not any(probe.opened for probe in h.probes.values())
        first = h.run_now(A, 'run-1', 'synthetic_run_now_accepted').get_json()
        assert first['command']['state'] == 'requested' and first['command']['payload'] == dict(action=A)
        h.tick(polls=False)                                                  # the checkpoint hands the request to the binding; the handler has not run yet
        h.tick()                                                             # the handler polls: due by request, its window opens
        started = h.read('synthetic_run_now_read_started')
        command_id = first['command']['id']
        assert h.commands()['run-1']['state'] == 'started' and h.items(started)[A]['state'] == 'running' and h.items(started)[A]['active']['window_ends_at'] is not None
        for _ in range(4):
            h.tick()
        done = h.read('synthetic_run_now_read_completed_unconfirmed')
        last = h.items(done)[A]['last']
        assert h.commands()['run-1']['state'] == 'completed' and h.commands()['run-1']['evidence']['effect'] == 'unconfirmed', h.commands()['run-1']
        assert (last['effect'], last['trigger'], last['result'], last['command_id']) == ('unconfirmed', 'manual', 'succeeded', command_id), last
        variant = h.run_now(f'{B}:fast', 'run-2', 'synthetic_run_now_variant_accepted').get_json()
        assert variant['command']['payload'] == dict(action=f'{B}:fast') and variant['command']['state'] == 'requested'
        refused = h.run_now(f'{A}:nope', 'run-3', 'synthetic_run_now_unknown_variant_refused', expect=400).get_json()
        assert refused['error'] == 'Unsupported manual action'
        h.run_now(f'{A}:fast', 'run-1', 'synthetic_run_now_changed_payload_refused', expect=409)
        h.run_now(A, 'run-4', 'synthetic_stale_generation_refused', expect=409, generation='an-older-driver')
        for _ in range(8):
            h.tick()
        assert h.commands()['run-2']['state'] == 'completed'
        detail = w.get(SA, 'synthetic_battle_detail_executions', f"/api/battles/{h.battle['id']}").get_json()
        mine = [row for row in detail['executions']['items'] if row['action'] == 'synthetic_probe']
        assert [(row['instance'], row['trigger'], row['state'], row['command_id']) for row in mine] == [('probe_b', 'manual', 'succeeded', variant['command']['id']),
                                                                                                    ('probe_a', 'manual', 'succeeded', command_id)], mine
        w.table.exit(h.d.op['worker']['pid'])
        replay = h.run_now(A, 'run-1', 'synthetic_run_now_replay_after_driver_ended').get_json()
        assert replay['command']['id'] == command_id and replay['command']['state'] == 'completed' and replay['command']['evidence']['effect'] == 'unconfirmed'
    with world(gen, 'synthetic_reply_unknown') as w:
        h = Host(w, 'unknown')
        h.pause(*KEYS)
        real = battle_api.public
        w.mp.setattr(battle_api, 'public', raising(KeyError('battle row vanished')))
        unknown = h.run_now(A, 'run-5', 'synthetic_run_now_reply_unknown', expect=500).get_json()
        assert unknown['code'] == 'command_outcome_unknown'
        w.mp.setattr(battle_api, 'public', real)
        read = h.read('synthetic_run_now_reply_unknown_read')
        assert [entry['request_keys'] for entry in read['commands'] if entry['kind'] == 'action'] == [['run-5']] and h.commands()['run-5']['state'] == 'requested'
    with world(gen, 'synthetic_newer_schema') as w:
        h = Host(w, 'newer')
        h.d.publish()
        w.mp.setattr(action_session_module, 'SCHEMA_VERSION', 2)             # the driver is a newer build: it writes the projection with its own version
        h.d.publish()
        newer = h.read('synthetic_projection_newer_schema')
        assert newer['runtime']['actions']['schema_version'] == 2 and {A, B} <= set(h.items(newer))
    with world(gen, 'synthetic_next_unknown') as w:
        h = Host(w, 'unknown-next')
        probe = h.probes[A]
        known = probe.status
        w.mp.setattr(probe, 'status', lambda: dict(known(), next_due_at=None))      # an action that cannot say when it is next due
        h.d.publish()
        unknown_next = h.read('synthetic_next_unknown_due_at_null')
        item = h.items(unknown_next)[A]
        assert item['next']['due_at'] is None and item['next']['reason'] == 'unknown' and item['state'] == 'waiting', item
    with world(gen, 'synthetic_harvest') as w:
        h = Host(w, 'harvest')
        w.edit_profile(with_orbit)         # after the battle froze its settings, the run's gathering settings gained timed orbit clicks: turning Harvest on has something to put on
        h.tick(polls=False)
        synthetic_before = {key: dict(h.d.battle['applied_controls']['routines'][key]) for key in KEYS}
        ident = harvest.identity_for(w.cfg)
        turn_on = dict(enabled=True, preset='bp_farm', expected_revision=0, idempotency_key='turn-on-synthetic',
                       expected_context={name: ident[name] for name in ('instance', 'account', 'serial', 'profile')})
        reply = w.post(SA, 'synthetic_harvest_on_accepted', '/api/harvest', turn_on)
        assert reply.status_code == 200, reply.get_json()
        w.dash._harvest_tick()
        status = dashboard.answer(w.client.get('/api/status'), 'GET', '/api/status')
        status['body'] = {key: value for key, value in status['body'].items() if key in ('harvest', 'battle', 'operations')}
        gen.cases.setdefault(SA, {})['synthetic_harvest_on_keeps_collection_gem_only'] = status
        overlay = status['body']['harvest']['overlay']
        assert overlay['state'] == 'requested' and overlay['paths'] == ['routines.floating_gems.enabled'] and set(overlay['targets']) == set(harvest.GEM_ROUTINES), overlay
        h.tick(polls=False)                                                       # the driver's checkpoint applies the overlay command
        active = h.read('synthetic_harvest_on_battle_read')
        sent = [entry for entry in active['commands'] if entry['kind'] == 'controls' and entry['request_keys'][0].startswith(harvest.OVERLAY_PREFIX)]
        assert len(sent) == 1 and sent[0]['state'] == 'applied' and list(sent[0]['payload']['routines']) == ['floating_gems'], sent
        assert {key: active['effective']['routines'][key] for key in KEYS} == synthetic_before and active['effective']['routines']['floating_gems']['enabled'] is True


# B1 case id of the brief (backend/logs/reviews/ui-pages/a2-7-actions-brief.md section 11) -> the case of the fixture that satisfies it
B1 = {
    'synthetic_active_two_instances': 'synthetic_active_two_instances',
    'synthetic_live_field_accepted': 'synthetic_live_field_accepted',
    'synthetic_live_field_read_applied': 'synthetic_live_field_read_applied',
    'synthetic_live_field_out_of_bounds_refused': 'synthetic_live_field_out_of_bounds_refused',
    'synthetic_live_field_null_inherits': 'synthetic_live_field_null_inherits',
    'synthetic_live_field_null_inherits_read': 'synthetic_live_field_null_inherits_read',
    'synthetic_run_now_accepted': 'synthetic_run_now_accepted',
    'synthetic_run_now_read_started': 'synthetic_run_now_read_started',
    'synthetic_run_now_read_completed_unconfirmed': 'synthetic_run_now_read_completed_unconfirmed',
    'synthetic_run_now_variant_accepted': 'synthetic_run_now_variant_accepted',
    'synthetic_run_now_unknown_variant_refused': 'synthetic_run_now_unknown_variant_refused',
    'synthetic_run_now_replay_after_driver_ended': 'synthetic_run_now_replay_after_driver_ended',
    'synthetic_run_now_changed_payload_refused': 'synthetic_run_now_changed_payload_refused',
    'synthetic_run_now_reply_unknown': 'synthetic_run_now_reply_unknown',
    'synthetic_run_now_reply_unknown_read': 'synthetic_run_now_reply_unknown_read',
    'synthetic_stale_generation_refused': 'synthetic_stale_generation_refused',
    'synthetic_projection_newer_schema': 'synthetic_projection_newer_schema',
    'synthetic_battle_detail_executions': 'synthetic_battle_detail_executions',
    'synthetic_harvest_on_keeps_collection_gem_only': 'synthetic_harvest_on_keeps_collection_gem_only',
}
EXTRAS = ['synthetic_live_field_unknown_refused', 'synthetic_live_instance_unknown_refused', 'synthetic_next_unknown_due_at_null', 'synthetic_harvest_on_accepted',
          'synthetic_harvest_on_battle_read']
