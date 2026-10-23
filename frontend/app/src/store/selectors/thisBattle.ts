import { COMPAT_ROUTINES, isShoppingAction, type ActionKey } from '../../core/actions.ts';
import { battleIdentity, battleView } from '../../core/battle.ts';
import { commandView, type CommandView } from '../../core/commands.ts';
import { entries, finite, id, list, own, ownPath, revision, text } from '../../core/read.ts';
import {
  actionGate,
  commandReceiptPending,
  routineResult,
  routineTiming,
  runNowAnswer,
  shoppingView,
} from '../../core/routines.ts';
import { fromServer, type ServerText } from '../../copy/server.ts';
import type { RunNowCommand } from '../commands.ts';
import { contextIntents } from '../intents.ts';
import { settledByRead } from '../fences.ts';
import { answeredBody, contextReadOf, latestRead, readAgeSec } from '../reads.ts';
import type { DashboardState } from '../types.ts';
import { chipVM, commandVM, type ChipVM, type CommandVM } from '../viewModels.ts';
import { shoppingLiveScope } from './shoppingLive.ts';
import { selectOutcomes, type OutcomeLineVM } from './outcomes.ts';

export interface RoutineRowVM {
  readonly routine: ActionKey;
  readonly timing: ChipVM;
  readonly nextInSec: number | null;
  readonly windowEndsAt: number | null;
  readonly blocker: ServerText<'message'> | null;
  readonly state: ServerText<'detail'> | null;
  readonly stateCode: string | null;
  readonly savedEnabled: boolean | null;
  readonly savedIntervalSec: number | null;
  readonly resultAgeSec: number | null;
  readonly result: {
    readonly chip: ChipVM;
    readonly confirmed: boolean;
    readonly observedAt: number | null;
    readonly reason: ServerText<'message'> | null;
    readonly confirmedPurchases: number | null;
  };
  readonly runNow: CommandVM<RunNowCommand>;
}

export interface ThisBattleVM {
  readonly header: ChipVM;
  readonly routines: readonly RoutineRowVM[];
  readonly commands: readonly BattleCommandVM[];
  readonly noTrackedBattle: boolean;
  readonly battleKey: string;
  /** The battle's run (`blueprint`), for the "Saved settings in Runs" link (Runs brief RUN-12). */
  readonly runKey: string | null;
  readonly label: ServerText<'name'> | null;
  readonly wave: number | null;
  readonly changed: boolean;
  readonly readAgeSec: number | null;
  readonly reportAgeSec: number | null;
  readonly queue: QueueVM;
  readonly outcomes: readonly (OutcomeLineVM & { readonly command: BattleCommandVM | null })[];
  readonly resendAvailable: boolean;
  readonly tryOnce: readonly ShoppingTryOnceVM[];
}

export interface ShoppingTryOnceVM {
  readonly action: string;
  readonly label: ServerText<'name'> | null;
  readonly known: 'shopping' | 'attack' | 'defense' | 'utility' | null;
  readonly button: CommandVM<RunNowCommand>;
}

export interface QueueVM {
  readonly needsReview: boolean;
  readonly mode: string | null;
  readonly cadence: string | null;
  readonly reserve: number | null;
  readonly items: readonly {
    readonly key: string;
    readonly label: ServerText<'name'> | null;
    readonly enabled: boolean;
    readonly tapLimit: number | null;
    readonly weight: number | null;
    readonly tryOnce: ShoppingTryOnceVM | null;
  }[];
  readonly warnings: readonly ChipVM[];
  readonly reportedAgeSec: number | null;
  readonly decision: ServerText<'detail'> | null;
  readonly decisionReason: ServerText<'message'> | null;
  readonly decisionUpgrade: ServerText<'name'> | null;
  readonly pendingUpgrade: ServerText<'name'> | null;
  readonly confirmationUpgrade: ServerText<'name'> | null;
  readonly confirmationOutcome: ServerText<'detail'> | null;
  readonly confirmationReason: ServerText<'message'> | null;
}

/** Each row remains a ChipVM, with the command's dated reason and action evidence. */
export interface BattleCommandVM extends ChipVM {
  readonly key: string;
  readonly action: string | null;
  readonly actionText: ServerText<'id'> | null;
  readonly serverEvidence: ServerText<'detail'> | null;
  readonly shoppingState: 'requested' | 'started' | 'completed' | null;
  readonly resultAgeSec: number | null;
  readonly resultChip: ChipVM | null;
  readonly id: ServerText<'id'> | null;
  readonly revision: number | null;
  readonly requestedAt: number | null;
  readonly updatedAt: number | null;
  readonly reason: ServerText<'message'> | null;
  readonly result: {
    readonly confirmed: boolean;
    readonly observedAt: number | null;
    readonly reason: ServerText<'message'> | null;
    readonly confirmedPurchases: number | null;
  };
}

/** Project a command read or receipt through the same command and routine rules. */
function commandRow(
  view: CommandView,
  index: number,
  age: (at: number | null) => number | null,
): BattleCommandVM {
  const action = text(own(view.payload, 'action')) ?? null;
  const routine = COMPAT_ROUTINES.find((routine) => routine === action);
  const result =
    routine === undefined || view.kind !== 'action'
      ? null
      : routineResult({ routines: { [routine]: { last_outcome: view.evidence } } }, routine);
  return {
    ...chipVM(view.decision),
    key: text(view.id) ?? String(index),
    action,
    actionText: fromServer('id', action),
    serverEvidence: fromServer(
      'detail',
      view.evidence === null || view.evidence === undefined ? null : JSON.stringify(view.evidence),
    ),
    shoppingState:
      action !== null &&
      isShoppingAction(action) &&
      (view.state === 'requested' || view.state === 'started' || view.state === 'completed')
        ? view.state
        : null,
    resultAgeSec: age(result?.observedAt ?? null),
    resultChip: result === null ? null : chipVM(result.decision),
    id: fromServer('id', view.id),
    revision: view.revision,
    requestedAt: view.requestedAt,
    updatedAt: view.updatedAt,
    reason: fromServer('message', view.reason),
    result: {
      confirmed: result?.confirmed ?? false,
      observedAt: result?.observedAt ?? null,
      reason: fromServer('message', result?.reason),
      confirmedPurchases: result?.confirmedPurchases ?? null,
    },
  };
}

export function selectThisBattle(state: DashboardState): ThisBattleVM {
  const read = latestRead(state, 'battlesActive');
  const answered = state.reads.battlesActive.lastAnswered;
  const identity = battleIdentity(
    own(answeredBody(state, 'battlesActive'), 'battle'),
    answered === null ? NaN : answered.arrivedAtMs / 1000,
  );
  const shown = identity.kind === 'known' ? identity.value : null;
  const contextRead = contextReadOf(read);
  const elapsed = read === null ? 0 : readAgeSec(state, read);
  const body = read?.outcome.kind === 'answered' ? read.outcome.body : undefined;
  const battle = own(body, 'battle');
  const header = chipVM(battleView(contextRead, shown, elapsed));
  const intents = contextIntents(state);
  const serverTime = finite(own(body, 'server_time'));
  const age = (timestamp: number | null): number | null =>
    timestamp === null || serverTime === undefined
      ? null
      : Math.max(0, serverTime - timestamp + elapsed);
  const shopping = shoppingView(body);
  const battleIntents = intents.filter(
    (r) =>
      r.kind === 'run_now' &&
      shown !== null &&
      r.meta.operationId === shown.operationId &&
      r.meta.battleId === shown.id &&
      r.meta.generation === shown.generation,
  );
  const commandIntents = intents.filter(
    (r) =>
      (r.kind === 'run_now' || r.kind === 'live_controls') &&
      shown !== null &&
      r.meta.battleId === shown.id &&
      r.meta.generation === shown.generation &&
      r.meta.operationId === shown.operationId,
  );
  const shoppingOptions = {
    requireQueue: true,
    liveDraft:
      shown !== null &&
      Object.keys(state.runDrafts[shoppingLiveScope(state, shown)] ?? {}).length > 0,
    unresolvedCommand: commandIntents.some(
      (r) => r.phase === 'unconfirmed' && settledByRead(state, r) === null,
    ),
    pendingAction: commandIntents.some(
      (r) =>
        r.kind === 'run_now' &&
        (r.phase === 'sending' ||
          commandReceiptPending(contextRead, shown, r.answer?.body, 'action')),
    ),
    pendingControl: commandIntents.some(
      (r) =>
        r.kind === 'live_controls' &&
        (r.phase === 'sending' ||
          commandReceiptPending(contextRead, shown, r.answer?.body, 'controls')),
    ),
  };
  const tryButton = (action: string): CommandVM<RunNowCommand> => {
    const gate = actionGate(contextRead, shown, action, false, elapsed, shoppingOptions);
    const expectedRevision = revision(own(battle, 'control_revision'));
    const command =
      shown === null || expectedRevision === undefined
        ? null
        : {
            ...{ operationId: shown.operationId, battleId: shown.id, generation: shown.generation },
            expectedRevision,
            action,
            epoch: state.epoch,
          };
    return commandVM(
      true,
      gate.enabled && command !== null,
      gate.reason === 'ready' ? null : gate.reason,
      shoppingOptions.pendingAction,
      command,
    );
  };
  const tryOnce: ShoppingTryOnceVM[] = [
    { action: 'shopping', known: 'shopping', label: null, button: tryButton('shopping') },
    ...(['attack', 'defense', 'utility'] as const).map((section) => ({
      action: `shopping:${section}`,
      known: section,
      label: null,
      button: tryButton(`shopping:${section}`),
    })),
  ];
  const upgradeTryOnce = (item: (typeof shopping.queue)[number]): ShoppingTryOnceVM | null => {
    if (own(item.raw, 'enabled') !== true) return null;
    const upgrade = id(own(item.raw, 'id'));
    const catalog = (list(own(body, 'catalog')) ?? []).find(
      (entry) => own(entry, 'id') === upgrade,
    );
    const section = id(own(catalog, 'section'));
    if (upgrade === undefined || section === undefined) return null;
    const action = `shopping:${section}:${upgrade}`;
    return {
      action,
      known: null,
      label: fromServer('name', item.label ?? upgrade),
      button: tryButton(action),
    };
  };
  const upgradeActions = shopping.queue.map(upgradeTryOnce);
  tryOnce.push(...upgradeActions.filter((item) => item !== null));
  const outcomes = selectOutcomes(state)
    .lines.filter((line) => battleIntents.some((record) => record.id === line.id))
    .map((line) => {
      const answer = battleIntents.find((record) => record.id === line.id)?.answer;
      const settled =
        answer === null || answer === undefined
          ? null
          : runNowAnswer({ kind: 'answered', status: answer.status, body: answer.body });
      return {
        ...line,
        command: settled?.kind === 'recorded' ? commandRow(settled.command, 0, age) : null,
      };
    });
  return {
    header,
    tryOnce,
    battleKey: shown === null ? 'untracked' : `${shown.id}/${shown.generation}`,
    runKey: id(own(battle, 'blueprint')) ?? null,
    label: fromServer('name', own(battle, 'label')),
    wave:
      finite(ownPath(battle, 'runtime', 'observed_wave')) ?? finite(own(battle, 'wave')) ?? null,
    changed: entries(own(battle, 'overrides')).length > 0,
    readAgeSec: answered === null ? null : readAgeSec(state, answered),
    reportAgeSec: age(finite(ownPath(battle, 'runtime', 'server_time')) ?? null),
    outcomes,
    resendAvailable:
      read?.outcome.kind === 'answered' && header.row !== 'B1' && header.row !== 'B2',
    queue: {
      needsReview: shopping.line === 'shopping_policy_needs_review',
      mode: text(own(shopping.plan, 'queue_mode')) ?? null,
      cadence: text(shopping.cadence) ?? null,
      reserve: finite(shopping.cashReserve) ?? null,
      items: shopping.queue.map((item, index) => ({
        key: text(own(item.raw, 'id')) ?? String(index),
        label: fromServer('name', item.label) ?? fromServer('name', own(item.raw, 'id')),
        enabled: own(item.raw, 'enabled') === true,
        tapLimit: finite(own(item.raw, 'tap_limit')) ?? null,
        weight: finite(own(item.raw, 'weight')) ?? null,
        tryOnce: upgradeActions[index] ?? null,
      })),
      warnings: shopping.warnings.map(chipVM),
      reportedAgeSec: age(shopping.reportedAt),
      decision: fromServer('detail', own(shopping.decision, 'action')),
      decisionReason: fromServer('message', own(shopping.decision, 'reason')),
      decisionUpgrade: fromServer('name', own(shopping.decision, 'upgrade')),
      pendingUpgrade: fromServer('name', own(shopping.pendingConfirmation, 'upgrade')),
      confirmationUpgrade: fromServer('name', own(shopping.lastConfirmation, 'upgrade')),
      confirmationOutcome: fromServer('detail', own(shopping.lastConfirmation, 'outcome')),
      confirmationReason: fromServer('message', own(shopping.lastConfirmation, 'reason')),
    },
    noTrackedBattle: header.row === 'B2',
    routines:
      header.row === 'B2'
        ? []
        : COMPAT_ROUTINES.map((routine): RoutineRowVM => {
            const matching = intents.filter(
              (r) =>
                r.kind === 'run_now' &&
                shown !== null &&
                r.meta.operationId === shown.operationId &&
                r.meta.battleId === shown.id &&
                r.meta.generation === shown.generation &&
                r.meta.action === routine,
            );
            const sending = matching.some((r) => r.phase === 'sending');
            const gate = actionGate(
              contextRead,
              shown,
              routine,
              matching.some((r) => r.phase === 'unconfirmed' && settledByRead(state, r) === null),
              elapsed,
              isShoppingAction(routine) ? shoppingOptions : {},
            );
            const timing = routineTiming(contextRead, shown, routine, elapsed);
            const result = routineResult(own(battle, 'runtime'), routine);
            const expectedRevision = revision(own(battle, 'control_revision'));
            const command: RunNowCommand | null =
              shown === null || expectedRevision === undefined
                ? null
                : {
                    operationId: shown.operationId,
                    battleId: shown.id,
                    generation: shown.generation,
                    expectedRevision,
                    action: routine,
                    epoch: state.epoch,
                  };
            return {
              routine,
              timing: chipVM(timing),
              nextInSec: timing.nextInSec,
              windowEndsAt: timing.windowEndsAt,
              blocker: fromServer('message', timing.blocker),
              state: fromServer('detail', timing.state),
              stateCode: text(timing.state) ?? null,
              savedEnabled: typeof timing.savedEnabled === 'boolean' ? timing.savedEnabled : null,
              savedIntervalSec: finite(timing.savedIntervalSec) ?? null,
              resultAgeSec: age(result.observedAt),
              result: {
                chip: chipVM(result.decision),
                confirmed: result.confirmed,
                observedAt: result.observedAt,
                reason: fromServer('message', result.reason),
                confirmedPurchases: result.confirmedPurchases,
              },
              runNow: commandVM(
                true,
                gate.enabled && !sending && command !== null,
                sending ? 'sending' : gate.reason === 'ready' ? null : gate.reason,
                sending,
                command,
              ),
            };
          }),
    commands: (list(ownPath(body, 'battle', 'commands')) ?? []).map((row, index) =>
      commandRow(commandView(row), index, age),
    ),
  };
}
