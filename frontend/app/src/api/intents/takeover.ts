import { takeoverPreview, type TakeoverRead } from '../../core/takeover.ts';
import { readEndpoint } from '../client.ts';
import type { PageContext } from '../context.ts';
import { ENDPOINTS } from '../wire.ts';
import type { StartClickDeps } from './start.ts';
import { sendOnce, type SendResult } from './send.ts';

/**
 * Take over the battle on screen (POST /api/control action=takeover; backend
 * control/takeover.py). The body is the spec 3.1 shape and nothing else: no `harvest`,
 * no `desire_revision`, no `battle_envelope`. A click first reads
 * `GET /api/takeover/preview?preset=` (never polled) for what the server must recognise
 * (the context, the policy revision, the battle it names) and sends only when
 * core/takeover.ts `takeoverPreview` finds the emulator still free and the context still the
 * page's. The tier is always `unknown`: this page never declares one. The attestation is the
 * person's confirmation in the dialog that called this; it is made here and nowhere else.
 * A lost, 5xx or `action_lock` answer leaves the record unconfirmed and nothing is sent again.
 */
export const TAKEOVER_TARGET = 'takeover';
const ATTESTATION = 'current_battle_takeover';

export interface TakeoverClickInput {
  readonly preset: string;
  readonly context: PageContext;
  /** The page's launch context (with its rendering), which the preview must name too. */
  readonly pageContext: unknown;
}

/** One takeover click: the preview read, the check, then one send (or nothing, with the reason). */
export async function takeoverClick(
  deps: StartClickDeps,
  input: TakeoverClickInput,
): Promise<SendResult> {
  const epoch = deps.epoch();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? 5000);
  let read: TakeoverRead;
  try {
    const outcome = await readEndpoint(
      deps.transport,
      (deps.endpoints ?? ENDPOINTS).takeoverPreview,
      `/api/takeover/preview?preset=${encodeURIComponent(input.preset)}`,
      controller.signal,
    );
    read =
      outcome.kind === 'answered'
        ? {
            kind: 'answered',
            status: outcome.answer.status,
            body: outcome.answer.body,
            sameContext: deps.epoch() === epoch,
          }
        : { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
  const preview = takeoverPreview(read, input.preset, input.pageContext);
  if (preview.kind !== 'ready') return { kind: 'not_sent', reason: preview.kind };
  return sendOnce(deps.machine, TAKEOVER_TARGET, input.context, () => {
    const key = deps.newKey();
    return deps.machine.send({
      kind: 'takeover',
      target: TAKEOVER_TARGET,
      endpoint: 'takeover',
      path: '/api/control',
      body: {
        action: 'takeover',
        preset: preview.preset,
        idempotency_key: key,
        expected_context: { ...preview.context },
        attach: {
          mode: 'current_battle',
          policy_revision: preview.policyRevision,
          expected_battle: {
            battle_id: preview.expectedBattle.battleId,
            generation: preview.expectedBattle.generation,
            observed_wave: preview.expectedBattle.observedWave,
          },
          tier: { value: null, provenance: 'unknown' },
          attestation: ATTESTATION,
        },
      },
      key,
      meta: { preset: preview.preset },
      context: input.context,
      supersedes: [],
    });
  });
}
