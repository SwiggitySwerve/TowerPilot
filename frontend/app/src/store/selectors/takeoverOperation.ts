import { classifyStatus } from '../../core/operationStatus.ts';
import { classifyStartAnswer, type StartAnswerClass } from '../../core/outcomes/start.ts';
import { own } from '../../core/read.ts';
import { operationView, type OperationView } from '../../core/recognition.ts';
import { contextIntents } from '../intents.ts';
import type { DashboardState, IntentView } from '../types.ts';

/**
 * The operation an accepted takeover started, followed by its id until the worker ends it
 * (GET /api/operations/{id}). The worker's entry gate refuses on its first frame, before any
 * input, and records the refusal on the operation (`failed`, `error.code` attach_*); nothing else
 * on this page says so, so without this read an accepted takeover stays "requested" forever.
 */

/** The operation `record`'s accepted answer named, or null (not a takeover, or not accepted). */
function acceptedOperation(record: IntentView): string | null {
  if (record.kind !== 'takeover' || record.answer === null) return null;
  const answer = classifyStartAnswer(record.answer);
  return answer.kind === 'started' ? answer.operationId : null;
}

/** The operation of the newest takeover of this context that is still shown, when it was accepted. */
export function followedTakeover(state: DashboardState): string | null {
  const takeovers = contextIntents(state).filter(
    (record) => record.kind === 'takeover' && !record.dismissed,
  );
  const newest = takeovers[takeovers.length - 1];
  return newest === undefined ? null : acceptedOperation(newest);
}

/** The newest answered read of `operationId`, when it names that operation. */
export function takeoverOperationRead(
  state: DashboardState,
  operationId: string,
): OperationView | null {
  const read = state.reads.takeoverOperation.lastAnswered;
  if (read?.outcome.kind !== 'answered' || read.outcome.status !== 200) return null;
  const operation = operationView(own(read.outcome.body, 'operation'));
  return operation?.id === operationId ? operation : null;
}

/** The followed operation is still the worker's to end (or has not been read yet). */
export function takeoverOperationWorking(state: DashboardState): boolean {
  const operationId = followedTakeover(state);
  if (operationId === null) return false;
  const read = takeoverOperationRead(state, operationId);
  return read === null || classifyStatus(read.status) === 'active';
}

export function takeoverOperationPath(state: DashboardState): `/api/${string}` | null {
  const operationId = followedTakeover(state);
  return operationId === null ? null : `/api/operations/${encodeURIComponent(operationId)}`;
}

const ENDS = ['failed', 'cancelled', 'interrupted', 'succeeded'] as const;

/**
 * The operation `record` started, once a read of it says the worker ended it, worded as the
 * answer class that Start's own results use for an accepted launch that ended; else null.
 */
export function takeoverEnd(
  state: DashboardState,
  record: IntentView,
): Extract<StartAnswerClass, { kind: (typeof ENDS)[number] }> | null {
  const operationId = acceptedOperation(record);
  if (operationId === null) return null;
  const read = takeoverOperationRead(state, operationId);
  const kind = ENDS.find((status) => status === read?.status);
  return read === null || kind === undefined
    ? null
    : { kind, operationId, operation: null, error: read.error };
}
