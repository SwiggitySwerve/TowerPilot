import { finite, own, ownPath, record, stringList } from './read.ts';
import { contextsEqual } from './readiness.ts';

/**
 * Taking over the battle on screen (backend/control/takeover.py; rules in takeover.rules.md).
 * These readers decide nothing about the run, the readiness or the owners: the server judges
 * all of that when it is asked, and its refusal is shown as it sent it. They only read what the
 * request must carry from the preview, and what the server has said since.
 */

/** The five keys of `expected_context`, each text or null (takeover.parse). */
const CONTEXT_KEYS = ['instance', 'account', 'serial', 'rendering', 'profile'] as const;

export interface TakeoverContext {
  readonly instance: string | null;
  readonly account: string | null;
  readonly serial: string | null;
  readonly rendering: string | null;
  readonly profile: string | null;
}

export type TakeoverRead =
  | {
      readonly kind: 'answered';
      readonly status: number;
      readonly body: unknown;
      /** False when the page context changed while the read was in flight. */
      readonly sameContext: boolean;
    }
  | { readonly kind: 'failed' };

export type TakeoverPreview =
  | {
      readonly kind: 'ready';
      readonly preset: string;
      readonly policyRevision: string;
      /** The preview's own context, sent back as `expected_context`. */
      readonly context: TakeoverContext;
      /** The battle the server named; with nothing holding the emulator all three are null. */
      readonly expectedBattle: {
        readonly battleId: string | null;
        readonly generation: string | null;
        readonly observedWave: number | null;
      };
    }
  /** The emulator, account or profile is not the one the page shows, or something now holds the emulator. */
  | { readonly kind: 'changed' }
  /** No preview of this run could be read (failed, refused, or not the shape the contract records). */
  | { readonly kind: 'unreadable' };

function textOrNull(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

/**
 * What a `POST /api/control action=takeover` may carry, read from `GET /api/takeover/preview?preset=`.
 * A run the server calls incompatible or not ready is still `ready` here: asking is harmless (a
 * refusal records nothing and sends nothing to the game) and the refusal is the server's own words.
 * What the person confirmed was a battle nothing owns, so an emulator that is no longer free is
 * `changed`, not sent.
 */
export function takeoverPreview(
  read: TakeoverRead,
  preset: string,
  pageContext: unknown,
): TakeoverPreview {
  if (read.kind !== 'answered' || read.status !== 200) return { kind: 'unreadable' };
  const body = read.body;
  const revision = ownPath(body, 'run', 'policy_revision');
  const battle = own(body, 'current_battle');
  const context = own(body, 'context');
  const fields = CONTEXT_KEYS.map((key) => textOrNull(own(context, key)));
  const battleId = textOrNull(own(battle, 'battle_id'));
  const generation = textOrNull(own(battle, 'generation'));
  const observedWave = own(battle, 'observed_wave');
  if (
    own(body, 'ok') !== true ||
    own(body, 'preset') !== preset ||
    typeof revision !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(revision) ||
    stringList(own(body, 'blockers')) === undefined ||
    record(context) === undefined ||
    fields.some((field) => field === undefined) ||
    battleId === undefined ||
    generation === undefined ||
    (observedWave !== null && finite(observedWave) === undefined)
  )
    return { kind: 'unreadable' };
  if (!read.sameContext || !contextsEqual(context, pageContext, CONTEXT_KEYS))
    return { kind: 'changed' };
  if (ownPath(body, 'device', 'state') !== 'free') return { kind: 'changed' };
  if (battleId !== null || generation !== null || observedWave !== null)
    return { kind: 'unreadable' };
  return {
    kind: 'ready',
    preset,
    policyRevision: revision,
    context: {
      instance: textOrNull(own(context, 'instance')) ?? null,
      account: textOrNull(own(context, 'account')) ?? null,
      serial: textOrNull(own(context, 'serial')) ?? null,
      rendering: textOrNull(own(context, 'rendering')) ?? null,
      profile: textOrNull(own(context, 'profile')) ?? null,
    },
    expectedBattle: { battleId: null, generation: null, observedWave: null },
  };
}

/**
 * True when the battle read says the takeover worker looked at the screen: `attach.observed_wave`
 * comes from the worker's entry gate (`attach.observed_wave_source: "entry_gate"`) and from nothing
 * else. The `attach` block alone is not enough: it is on the battle from the moment it is prepared,
 * before the worker has seen anything, so it only says a takeover was asked for.
 */
export function workerAttached(battle: unknown): boolean {
  const attach = own(battle, 'attach');
  const wave = own(attach, 'observed_wave');
  return (
    own(attach, 'mode') === 'current_battle' &&
    own(attach, 'observed_wave_source') === 'entry_gate' &&
    typeof wave === 'number' &&
    Number.isSafeInteger(wave) &&
    wave >= 0
  );
}
