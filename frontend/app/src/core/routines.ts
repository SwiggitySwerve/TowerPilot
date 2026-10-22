import {
  battleView,
  freshBattleReport,
  recordDecision,
  type BattleIdentity,
  type RecordDecision,
} from './battle.ts';
import { commandTerminal, commandView, type CommandView } from './commands.ts';
import type { ContextRead } from './connection.ts';
import { finite, hasOwn, id, list, own, ownPath, record, revision, stringList } from './read.ts';
import { opaqueToken, sameToken, type OpaqueToken } from './tokens.ts';
import { decide, type ChipDecision } from './vocabulary.ts';

export type Routine = 'ad_gems' | 'floating_gems' | 'shopping';

export type RoutineTiming = (ChipDecision | RecordDecision) & {
  readonly nextInSec: number | null;
  readonly windowEndsAt: number | null;
  readonly blocker: unknown;
  readonly state: unknown;
  readonly savedEnabled: unknown;
  readonly savedIntervalSec: unknown;
};

/** F-050/F-055: all deadlines are relative to runtime.server_time. */
export function routineTiming(
  read: ContextRead,
  shown: BattleIdentity | null,
  routine: Routine,
  elapsedSec = 0,
): RoutineTiming {
  const battle =
    read?.kind === 'answered' && read.sameContext ? own(read.body, 'battle') : undefined;
  const raw = ownPath(battle, 'runtime', 'routines', routine);
  const fields = {
    nextInSec: null,
    windowEndsAt: null,
    blocker: own(raw, 'blocker'),
    state: own(raw, 'state'),
    savedEnabled: ownPath(battle, 'effective', 'routines', routine, 'enabled'),
    savedIntervalSec: ownPath(battle, 'effective', 'routines', routine, 'interval_sec'),
  };
  if (own(battle, 'status') === 'prepared')
    return {
      ...(typeof fields.savedEnabled === 'boolean'
        ? recordDecision(
            'F-050',
            fields.savedEnabled ? 'on_when_wave_starts' : 'prepared_routine_off',
            battle,
          )
        : decide('F-050', 'unknown', 'prepared_setting_unconfirmed', null)),
      ...fields,
    };
  const report = freshBattleReport(read, shown, elapsedSec);
  if (report.kind === 'unknown')
    return { ...decide('F-055', 'unknown', 'old_report', null), ...fields };
  if (record(raw) === undefined)
    return { ...decide('F-055', 'unknown', 'routine_unreported', null), ...fields };
  const windowEndsAt = finite(own(raw, 'window_ends_at'));
  const nextDue = finite(own(raw, 'next_due_at'));
  const now = report.value.runtimeTime + elapsedSec;
  if (windowEndsAt !== undefined && windowEndsAt > now && own(raw, 'enabled') === false)
    return { ...decide('F-055', null, 'paused_until_window', 'EV-9'), ...fields, windowEndsAt };
  if (fields.blocker !== null && fields.blocker !== undefined)
    return {
      ...decide('F-055', 'waiting', 'routine_blocker', 'EV-9'),
      ...fields,
      windowEndsAt: windowEndsAt ?? null,
    };
  const knownState = ['active', 'scheduled', 'off', 'watching', 'boundary_wait'].some(
    (state) => state === fields.state,
  );
  if (!knownState)
    return { ...decide('F-055', 'unknown', 'routine_state_unrecognised', null), ...fields };
  const enabled = own(raw, 'enabled');
  if (typeof enabled !== 'boolean')
    return { ...decide('F-055', 'unknown', 'routine_setting_unconfirmed', null), ...fields };
  return {
    ...decide(
      'F-055',
      null,
      !enabled ? 'routine_off' : nextDue !== undefined ? 'next_due' : 'routine_reported',
      'EV-9',
    ),
    ...fields,
    nextInSec: enabled && nextDue !== undefined ? Math.max(0, nextDue - now) : null,
    windowEndsAt: windowEndsAt ?? null,
  };
}

export interface RoutineResult {
  readonly decision: ChipDecision | RecordDecision;
  readonly confirmed: boolean;
  readonly observedAt: number | null;
  readonly reason: unknown;
  readonly raw: unknown;
  readonly confirmedPurchases: number | null;
}

/** F-057/F-068: result evidence is never converted into a balance or gem count. */
export function routineResult(runtime: unknown, routine: Routine): RoutineResult {
  // backend/runtime/battle_session.py publish/_manual_progress: raw paths only.
  const outcome = ownPath(runtime, 'routines', routine, 'last_outcome');
  const routineRecord = ownPath(runtime, 'routines', routine);
  const confirmed = own(outcome, 'confirmed') === true;
  const fields = {
    confirmed,
    observedAt: finite(own(outcome, 'observed_at')) ?? null,
    reason:
      routine === 'shopping' ? ownPath(outcome, 'last_sweep', 'reason') : own(outcome, 'reason'),
    raw: outcome,
    confirmedPurchases:
      routine === 'shopping'
        ? (finite(ownPath(outcome, 'last_sweep', 'confirmed_purchases')) ?? null)
        : null,
  };
  if (
    record(routineRecord) === undefined ||
    !hasOwn(routineRecord, 'last_outcome') ||
    (outcome !== null && record(outcome) === undefined)
  )
    return { ...fields, decision: decide('F-057', 'unknown', 'routine_result_unreadable', null) };
  if (outcome === null)
    return { ...fields, decision: recordDecision('F-057', 'no_result_yet', routineRecord) };
  if (routine === 'shopping')
    return { ...fields, decision: recordDecision('F-068', 'shopping_result_reported', outcome) };
  return {
    ...fields,
    decision: confirmed
      ? recordDecision(
          'F-057',
          routine === 'ad_gems' ? 'claim_confirmed' : 'floating_claim_confirmed',
          outcome,
        )
      : decide('F-057', 'unknown', 'result_unconfirmed', null),
  };
}

export interface ActionGate {
  readonly enabled: boolean;
  readonly reason:
    | 'ready'
    | 'no_tracked_battle'
    | 'battle_not_active'
    | 'action_unsupported'
    | 'report_unavailable'
    | 'control_change_pending'
    | 'another_action_in_progress'
    | 'commands_unreadable'
    | 'earlier_outcome_unknown';
}

/** F-056: one open action blocks ALL three buttons; controls do not. */
export function actionGate(
  read: ContextRead,
  shown: BattleIdentity | null,
  routine: Routine,
  earlierOutcomeUnknown: boolean,
  elapsedSec = 0,
): ActionGate {
  const deny = (reason: ActionGate['reason']): ActionGate => ({ enabled: false, reason });
  if (read?.kind !== 'answered' || !read.sameContext) return deny('report_unavailable');
  const battle = own(read.body, 'battle');
  if (battle === null) return deny('no_tracked_battle');
  if (own(battle, 'status') !== 'active') return deny('battle_not_active');
  if (!stringList(ownPath(battle, 'capabilities', 'actions'))?.includes(routine))
    return deny('action_unsupported');
  if (freshBattleReport(read, shown, elapsedSec).kind === 'unknown')
    return deny('report_unavailable');
  const header = battleView(read, shown, elapsedSec);
  if (header.row !== 'B5') return deny('control_change_pending');
  const commands = list(own(battle, 'commands'));
  if (commands === undefined) return deny('commands_unreadable');
  for (const command of commands) {
    if (commandView(command).decision.row === 'K7') return deny('commands_unreadable');
    if (own(command, 'kind') === 'action' && !commandTerminal(command))
      return deny('another_action_in_progress');
  }
  if (earlierOutcomeUnknown) return deny('earlier_outcome_unknown');
  return { enabled: true, reason: 'ready' };
}

export type RunNowAnswer =
  | { readonly kind: 'lost' }
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown };

export type RunNowSettlement =
  | { readonly kind: 'recorded'; readonly command: CommandView }
  | { readonly kind: 'not_recorded'; readonly reason: unknown }
  | { readonly kind: 'unknown'; readonly decision: ChipDecision };

/** F-059/7.4: an HTTP answer settles this request; another action is no proof. */
export function runNowAnswer(answer: RunNowAnswer): RunNowSettlement {
  return commandAnswer(answer, 'action');
}

/**
 * The answer of one battle command request (the actions and live-controls
 * routes share one handler, dashboard.py api_battle_command): 200 with a
 * command of that kind recorded it; 400, 404 or 409 refused it before anything
 * was recorded; every other answer leaves it unknown.
 */
export function commandAnswer(answer: RunNowAnswer, kind: 'action' | 'controls'): RunNowSettlement {
  if (answer.kind === 'answered') {
    if (
      answer.status === 200 &&
      own(answer.body, 'ok') === true &&
      record(own(answer.body, 'command')) !== undefined &&
      id(ownPath(answer.body, 'command', 'id')) !== undefined &&
      ownPath(answer.body, 'command', 'kind') === kind
    )
      return { kind: 'recorded', command: commandView(own(answer.body, 'command')) };
    if ([400, 404, 409].includes(answer.status))
      return { kind: 'not_recorded', reason: own(answer.body, 'error') };
  }
  return { kind: 'unknown', decision: decide('F-059', 'unknown', 'may_have_been_recorded', null) };
}

/** A later row settles only the retained key AND battle/operation/generation. */
export function settleRunNow(
  read: ContextRead,
  shown: BattleIdentity,
  requestKey: OpaqueToken,
): RunNowSettlement {
  return settleCommand(read, shown, requestKey, 'action');
}

/** A later read settles a battle command only by a command of its kind carrying its key. */
export function settleCommand(
  read: ContextRead,
  shown: BattleIdentity,
  requestKey: OpaqueToken,
  kind: 'action' | 'controls',
): RunNowSettlement {
  if (read?.kind === 'answered' && read.sameContext) {
    const battle = own(read.body, 'battle');
    const identityMatches =
      own(battle, 'id') === shown.id &&
      own(battle, 'generation') === shown.generation &&
      own(battle, 'operation_id') === shown.operationId;
    if (identityMatches) {
      for (const command of list(own(battle, 'commands')) ?? []) {
        if (
          own(command, 'kind') !== kind ||
          own(command, 'battle_id') !== shown.id ||
          own(command, 'generation') !== shown.generation ||
          own(command, 'operation_id') !== shown.operationId ||
          id(own(command, 'id')) === undefined ||
          revision(own(command, 'revision')) === undefined
        )
          continue;
        if (
          (list(own(command, 'request_keys')) ?? []).some((key) =>
            sameToken(requestKey, opaqueToken(key)),
          )
        )
          return { kind: 'recorded', command: commandView(command) };
      }
    }
  }
  return { kind: 'unknown', decision: decide('F-059', 'unknown', 'may_have_been_recorded', null) };
}

export interface ShoppingView {
  readonly plan: unknown;
  readonly line: 'queue_for_this_battle' | 'shopping_policy_needs_review';
  readonly queue: readonly { readonly raw: unknown; readonly label: unknown }[];
  readonly cadence: unknown;
  readonly cashReserve: unknown;
  readonly decision: unknown;
  readonly pendingConfirmation: unknown;
  readonly lastConfirmation: unknown;
  readonly reportedAt: number | null;
  readonly warnings: readonly ChipDecision[];
}

/** F-066–F-069: raw paths, full queue, independent protection warnings. */
export function shoppingView(body: unknown): ShoppingView {
  const battle = own(body, 'battle');
  const plan = ownPath(battle, 'effective', 'shopping_plan');
  const outcome = ownPath(battle, 'runtime', 'routines', 'shopping', 'last_outcome');
  const catalog = list(own(body, 'catalog')) ?? [];
  const warnings: ChipDecision[] = [];
  if (own(outcome, 'reserve_supported') === false)
    warnings.push(decide('F-069', 'blocked', 'reserve_not_protected', null));
  if (own(outcome, 'quantity_observation_supported') === false)
    warnings.push(decide('F-069', 'waiting', 'purchase_quantity_unverified', null));
  return {
    plan,
    line: own(plan, 'version') === 2 ? 'queue_for_this_battle' : 'shopping_policy_needs_review',
    queue: (list(own(plan, 'queue')) ?? []).map((raw) => ({
      raw,
      label: own(
        catalog.find(
          (item) => id(own(item, 'id')) !== undefined && own(item, 'id') === own(raw, 'id'),
        ),
        'label',
      ),
    })),
    cadence: own(plan, 'cadence'),
    cashReserve: own(plan, 'cash_reserve'),
    decision: own(outcome, 'decision'),
    pendingConfirmation: own(outcome, 'pending_confirmation'),
    lastConfirmation: own(outcome, 'last_confirmation'),
    reportedAt: finite(ownPath(battle, 'runtime', 'routines', 'shopping', 'server_time')) ?? null,
    warnings,
  };
}
