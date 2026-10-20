"""Driver adapter for the durable battle ledger; checkpoints never send input."""
import copy
import os
import time
import uuid

from player.run_controls import FIELDS, flatten, resolve
from towerpilot_workflows.battles import Battles


class BattleSession:
    def __init__(self, store, operation_id, preset, config, *, envelope=None, origin='started', previous_battle_id=None, prepared=None):
        self.store, self.operation_id = store, operation_id
        self.generation = str(uuid.uuid4())
        self.battle = None
        self.base_preset = copy.deepcopy(preset)
        self.config = copy.deepcopy(config)
        self.effective = copy.deepcopy(preset)
        self.manual = None
        self._published_at = 0
        self._last_observation = None
        self._last_visible = False
        self._observed_duration = 0.0
        self._gap_started_at = None
        self._observation_gaps = []
        if prepared is None:
            self.prepare_next(preset, config, envelope=envelope, origin=origin, previous_battle_id=previous_battle_id)
        else:
            self.battle = copy.deepcopy(prepared)
            self.generation = prepared['generation']
            self.base_preset = copy.deepcopy(prepared['envelope']['preset'])
            self.effective = copy.deepcopy(self.base_preset)
            self.config = copy.deepcopy(prepared['envelope']['config'])
            self.gates = {key: value['enabled'] for key, value in prepared['envelope']['controls']['routines'].items()}
            self._tag()

    @classmethod
    def from_environment(cls, preset, config, *, origin='started'):
        operation_id, path = os.environ.get('TOWER_OPERATION_ID'), os.environ.get('TOWER_OPERATION_DB')
        if not operation_id or not path:
            return None
        store = Battles(path)
        from towerpilot_workflows.operations import Operations
        operation = Operations(path).get(operation_id)
        if os.environ.get('TOWER_BATTLE_ID'):
            from runtime.battle_source import accepted_envelope
            envelope = accepted_envelope(operation)
            prepared = store.get(os.environ['TOWER_BATTLE_ID'])
            if envelope.get('preset_key') != config.get('preset'):
                raise ValueError('Delegated child selected a different frozen preset')
            return cls(store, operation_id, envelope['preset'], envelope['config'], prepared=prepared)
        previous = None
        for old in store.active(operation['context']['device_key']):
            owner = Operations(path).get(old['operation_id'])
            if owner['status'] not in ('accepted', 'running'):
                store.finish(old['id'], old['generation'], reason='driver_operation_ended', status='interrupted')
                previous = old['id']
        envelope = operation['request'].get('battle_envelope')
        if envelope and envelope.get('preset_key', config.get('preset')) != config.get('preset'):
            envelope = None
        if envelope:
            preset = envelope['preset']
            config = envelope.get('config', config)
        session = cls(store, operation_id, preset, config, envelope=envelope,
                      origin='partial_adoption' if previous else origin, previous_battle_id=previous)
        return session

    def prepare_next(self, preset=None, config=None, *, envelope=None, origin='started', previous_battle_id=None):
        if self.battle and self.battle['status'] in ('prepared', 'active'):
            raise ValueError('Cannot replace a live battle envelope')
        if preset is not None:
            self.base_preset = copy.deepcopy(preset)
        if config is not None:
            self.config = copy.deepcopy(config)
        from towerpilot_workflows.operations import Operations
        operation = Operations(self.store.path).get(self.operation_id)
        frozen = copy.deepcopy(envelope) if envelope is not None else {
            'preset': copy.deepcopy(self.base_preset), 'config': copy.deepcopy(self.config),
            'controls': resolve(self.base_preset, self.config),
            'source': copy.deepcopy(self.base_preset.get('_source')), 'source_revision': None,
        }
        if self.base_preset.get('shopping_plan') is not None:
            frozen.setdefault('controls', {})['shopping_plan'] = copy.deepcopy(self.base_preset['shopping_plan'])
        self.battle = self.store.create(self.operation_id, operation['context'], frozen,
                                        generation=self.generation, origin=origin,
                                        previous_battle_id=previous_battle_id)
        self.base_preset = copy.deepcopy(frozen['preset'])
        self.effective = copy.deepcopy(self.base_preset)
        self.gates = {key: value['enabled'] for key, value in frozen['controls'].get('routines', {}).items()}
        self.manual = None
        self._last_observation = None
        self._last_visible = False
        self._observed_duration = 0.0
        self._gap_started_at = None
        self._observation_gaps = []
        self._tag()
        return self.battle

    def _tag(self):
        from runtime import logger
        if hasattr(logger, 'set_battle_context'):
            logger.set_battle_context(dict(battle_id=self.battle['id'], driver_segment=self.generation,
                                          envelope_hash=self.battle['envelope_hash']))

    def effective_preset(self):
        return copy.deepcopy(self.effective)

    def capabilities(self, rs):
        if getattr(rs, 'shop', None) is None:
            return dict(controls=[f'routines.{routine}.{field}' for routine in ('ad_gems', 'floating_gems')
                                  for field in FIELDS[routine]], actions=['ad_gems', 'floating_gems'])
        controls = [f'routines.{routine}.{field}' for routine, fields in FIELDS.items()
                    for field in fields]
        actions = ['ad_gems', 'floating_gems']
        if getattr(rs, 'shop', None) is not None and rs.shop.plan is not None:
            from player.shopping_plan import catalog
            controls.append('shopping_plan')
            actions += ['shopping'] + [f'shopping:{s}' for s in ('attack', 'defense', 'utility')]
            actions += [f"shopping:{c['section']}:{c['id']}" for c in catalog()]
        return dict(controls=controls, actions=actions)

    def observe(self, rs, wave):
        """Call after boundary classification, before any action-producing helper."""
        if wave is not None and self.battle['status'] == 'prepared':
            self.battle = self.store.activate(self.battle['id'], self.generation, self.capabilities(rs))
        return self.battle['status'] == 'active'

    def finish(self, reason, outcome='unknown', evidence=None, status='ended'):
        self.battle = self.store.finish(self.battle['id'], self.generation, reason=reason,
                                        outcome=outcome, evidence=evidence, status=status)
        return self.battle

    def _apply_control(self, rs, path, value):
        if path == 'shopping_plan':
            if value is None:
                raise ValueError('No frozen shopping plan to inherit')
            plan = copy.deepcopy(value)
            interval_override = self.battle['overrides'].get('routines', {}).get('shopping', {}).get('interval_sec')
            enabled_gate = self.battle['requested_controls']['routines']['shopping']['enabled']
            if interval_override is not None:
                plan['interval_sec'] = interval_override
            plan['enabled'] = enabled_gate
            rs.shopping_enabled = enabled_gate
            rs.shop.update_plan(plan)
            self.effective['shopping_plan'] = plan
            return True
        _, routine, field = path.split('.')
        if routine == 'rewards' and rs.mission.active:
            return False
        if routine in ('ad_gems', 'floating_gems'):
            collector = rs.gems.ad_gems if routine == 'ad_gems' else rs.gems.orbit
            collector.configure({field: value})
        elif routine == 'shopping':
            if field == 'enabled':
                rs.shopping_enabled = value
                if self.effective.get('shopping_plan') is not None:
                    self.effective['shopping_plan']['enabled'] = value
                    rs.shop.update_plan(self.effective['shopping_plan'])
                if not value:
                    rs.shop.abort()
            elif field == 'interval_sec':
                self.effective['shop_interval_sec'] = value
                if self.effective.get('shopping_plan') is not None:
                    self.effective['shopping_plan']['interval_sec'] = value
                    rs.shop.update_plan(self.effective['shopping_plan'])
        elif routine == 'rewards':
            rs.rewards_enabled = value
        elif routine == 'repeat':
            rs.repeat_enabled = value
        elif routine in ('abilities', 'rescue'):
            self.gates[routine] = value
            if routine == 'abilities' and value:
                rs.cl_normalized = False
                rs.uw_normalized = False
                rs.uw_done.clear()
        else:
            raise ValueError('Runtime gate is unsupported')
        return True

    def checkpoint(self, rs, *, battle_visible):
        if self.battle['status'] not in ('prepared', 'active'):
            return
        self._manual_progress(rs)
        commands = self.store.pending_commands(self.battle['id'], self.generation)
        for command in commands:
            if command['kind'] != 'controls':
                continue
            self.battle = self.store.get(self.battle['id'])
            target = flatten(self.battle['requested_controls'])
            applied = list(command['applied_paths'])
            for path in flatten(command['payload']):
                if path not in applied and self._apply_control(rs, path, target.get(path)):
                    applied.append(path)
            self._acknowledge(command, applied_paths=applied,
                              reason='finishing_owned_flow' if len(applied) < len(flatten(command['payload'])) else None)
        # Manual requests run through the same foreground, battle and collector
        # evidence checks as scheduled actions. No menu recovery is introduced.
        for command in commands:
            if command['kind'] != 'action':
                continue
            action = command['payload']['action']
            if command['state'] == 'requested':
                if self.manual is not None:
                    continue
                if not battle_visible or (rs.mission is not None and rs.mission.active) or (rs.shop is not None and rs.shop.active):
                    continue
                if action in ('ad_gems', 'floating_gems'):
                    collector = rs.gems.ad_gems if action == 'ad_gems' else rs.gems.orbit
                    if not collector.request_now():
                        continue
                    self.manual = dict(id=command['id'], action=action, collector=collector, began=False, command=command)
                else:
                    pieces = action.split(':')
                    if not rs.shop.request_once(section=pieces[1] if len(pieces) > 1 else None,
                                                upgrade=pieces[2] if len(pieces) > 2 else None):
                        continue
                    self.manual = dict(id=command['id'], action=action, began=True, command=command)
                    self.manual['command'] = self._acknowledge(command, state='started', evidence={'outcome': 'unknown'},
                                                               diagnostic=rs.shop.status())
            self._manual_progress(rs)
        self.publish(rs, battle_visible=battle_visible)

    def _acknowledge(self, before, *, diagnostic=None, **changes):
        """Mirror durable command progress once, after the ledger accepts it."""
        command = self.store.acknowledge(self.battle['id'], self.generation, before['id'], **changes)
        progress = ('state', 'applied_paths', 'reason', 'evidence')
        if all(before.get(key) == command.get(key) for key in progress):
            return command
        from runtime import logger
        evidence = command.get('evidence')
        identifiers = ('window_id', 'offer_id', 'claim_attempt_id', 'attempt_id', 'sweep_id')
        correlation = {key: value for key, value in (diagnostic or {}).items()
                       if key in identifiers and value is not None}
        if isinstance(evidence, dict):
            correlation.update({key: value for key, value in evidence.items()
                                if key in identifiers and value is not None})
        outcome = command['state']
        reason = command.get('reason')
        if isinstance(evidence, dict):
            if isinstance(evidence.get('outcome'), str):
                outcome = evidence['outcome']
            elif evidence.get('confirmed') is not None:
                outcome = 'confirmed' if evidence['confirmed'] else 'unconfirmed'
            elif isinstance((diagnostic or {}).get('last_sweep'), dict):
                outcome = diagnostic['last_sweep']['outcome']
            if reason is None:
                reason = evidence.get('reason')
                if reason is None and isinstance((diagnostic or {}).get('last_sweep'), dict):
                    reason = diagnostic['last_sweep'].get('reason')
        logger.event('battle_command_acknowledged', command_id=command['id'],
                     command_kind=command['kind'], action=command['payload'].get('action'),
                     battle_id=self.battle['id'], operation_id=self.operation_id,
                     driver_segment=self.generation, revision=command['revision'],
                     state=command['state'], outcome=outcome, reason=reason,
                     applied_paths=command.get('applied_paths', []), evidence=evidence,
                     **correlation)
        return command

    def _manual_progress(self, rs):
        if self.manual is None:
            return
        manual = self.manual
        if manual['action'] in ('ad_gems', 'floating_gems'):
            state = manual['collector'].status()
            if not manual['began'] and state['manual_active']:
                manual['command'] = self._acknowledge(manual['command'], state='started', diagnostic=state)
                manual['began'] = True
            if not state['manual_pending'] and not state['manual_active']:
                if not manual['began']:
                    manual['command'] = self._acknowledge(manual['command'], state='started', diagnostic=state)
                outcome = state['last_outcome']
                self._acknowledge(manual['command'], state='completed', evidence=outcome, diagnostic=state)
                self.manual = None
        else:
            status = rs.shop.status()
            if not status['active']:
                self._acknowledge(manual['command'], state='completed', evidence=status.get('manual'), diagnostic=status)
                self.manual = None

    def publish(self, rs, *, battle_visible):
        now = time.monotonic()
        if self._last_observation is not None:
            delta = now-self._last_observation
            if battle_visible and self._last_visible and delta <= 10:
                self._observed_duration += delta
            elif self._gap_started_at is None:
                self._gap_started_at = time.time()-delta
        if battle_visible and self._gap_started_at is not None:
            self._observation_gaps.append(dict(started_at=self._gap_started_at, ended_at=time.time()))
            self._gap_started_at = None
        self._last_observation, self._last_visible = now, battle_visible
        if now-self._published_at < 1:
            return
        self._published_at = now
        self.battle = self.store.get(self.battle['id'])
        routines = {'ad_gems': rs.gems.ad_gems.status(), 'floating_gems': rs.gems.orbit.status()}
        if not battle_visible and hasattr(rs.gems.ad_gems, 'mark_unknown'):
            rs.gems.ad_gems.mark_unknown('waiting_for_game_state')
            routines['ad_gems'] = rs.gems.ad_gems.status()
        epoch = time.time()
        interval = (self.effective.get('shopping_plan') or {}).get('interval_sec', self.effective.get('shop_interval_sec', 90))
        if rs.shop is not None:
            routines['shopping'] = dict(enabled=rs.shopping_enabled,
                                     state='active' if rs.shop.active else 'scheduled' if rs.shopping_enabled else 'off',
                                     next_due_at=epoch + rs.last_shop+interval-now,
                                     window_ends_at=None, last_outcome=rs.shop.status())
            routines['rewards'] = dict(enabled=rs.rewards_enabled, state='active' if rs.mission.active else 'watching' if rs.rewards_enabled else 'off',
                                    next_due_at=None, window_ends_at=None)
            for routine in ('abilities', 'rescue'):
                enabled = self.gates.get(routine, True)
                routines[routine] = dict(enabled=enabled, state='watching' if enabled else 'off',
                                         next_due_at=None, window_ends_at=None)
            routines['repeat'] = dict(enabled=rs.repeat_enabled, state='boundary_wait' if rs.repeat_enabled else 'off',
                                       next_due_at=None, window_ends_at=None)
        for state in routines.values():
            state.update(blocker=state.get('blocker') if battle_visible else 'waiting_for_game_state', server_time=epoch)
        self.store.update_status(self.battle['id'], self.generation, dict(routines=routines, server_time=epoch,
            observed_wave=rs.tracker.last, last_wave_provenance='observed',
            observed_duration_sec=self._observed_duration, observation_gaps=copy.deepcopy(self._observation_gaps),
            observation_gap_started_at=self._gap_started_at,
            driver_generation=self.generation, observation_status='observing' if battle_visible else 'waiting_for_game_state'))

    @property
    def manual_shopping(self):
        return self.manual is not None and self.manual['action'].startswith('shopping')
