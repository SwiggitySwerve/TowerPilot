import { automationSlot } from '../../core/automation.ts';
import { fromServer, type ServerText } from '../../copy/server.ts';
import type { TakeoverCommand } from '../commands.ts';
import { contextIntents } from '../intents.ts';
import type { DashboardState } from '../types.ts';
import { commandVM, type CommandVM } from '../viewModels.ts';
import { controlFacts } from './controlFacts.ts';
import { selectStartNext } from './startNext.ts';
import { selectThisBattle } from './thisBattle.ts';

/**
 * The "Take over" control of This battle: offered while there is no tracked battle and a D-4
 * read confirms nothing holds the emulator (the Automation slot's idle or free claim, from core), so a
 * battle on screen can only be a person's. It is Start's launch, so every reason about the page
 * (no run picked, the setup guard, game input, the connection, a request in flight) is Start
 * next's own; the server judges the run, its readiness and the owners when it is asked.
 */
export interface TakeoverVM {
  readonly takeover: CommandVM<TakeoverCommand>;
  /** The reason's Start next code and, for the setup guard, its code (as Start next words them). */
  readonly guardCode: string | null;
  /** The run the takeover would use: the one picked in Start next. */
  readonly runLabel: ServerText<'name'> | null;
}

export function selectTakeover(state: DashboardState): TakeoverVM {
  // The core decision behind the Automation slot, not its view model: a fault in that region's
  // selector must not take this control down with it.
  const facts = controlFacts(state);
  const slot = automationSlot({
    status: facts.status,
    extraClaims: facts.claims,
    lastIdleAgeSec: null,
  });
  const unowned =
    slot.rows.length === 0 &&
    (slot.summary?.claim?.state === 'idle' || slot.summary?.claim?.state === 'free');
  const start = selectStartNext(state);
  const selected = start.picker.selected;
  const startReason = start.reasons.find((reason) => reason.action === 'start') ?? null;
  const sending = contextIntents(state).some(
    (record) => record.kind === 'takeover' && record.phase === 'sending',
  );
  const reason = sending ? 'sending' : (startReason?.code ?? null);
  const run = start.picker.runs.find((candidate) => candidate.name === selected);
  return {
    takeover: commandVM(
      unowned && selectThisBattle(state).noTrackedBattle,
      reason === null,
      reason,
      sending,
      selected === null ? null : { preset: selected, epoch: state.epoch },
    ),
    guardCode: startReason?.guardCode ?? null,
    runLabel: run?.label ?? fromServer('name', selected),
  };
}
