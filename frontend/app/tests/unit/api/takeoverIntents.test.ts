import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settledPhase } from '../../../src/api/intents/phases.ts';
import { takeoverClick } from '../../../src/api/intents/takeover.ts';
import { E0_CONTEXT, machineHarness, postBodies } from '../../support/dataLayer.ts';
import { counter } from '../../support/fakeTransport.ts';
import { takeoverCaseNames, takeoverRecorded } from '../../support/takeoverFixture.ts';

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const PAGE = { ...E0_CONTEXT, rendering: null };
const PREVIEW = 'preview_free.run_preview_nothing_owns_the_emulator';

function click(
  harness: ReturnType<typeof machineHarness>,
  preview: { status: number; body: unknown } | 'hold' = takeoverRecorded(PREVIEW),
) {
  harness.fake.route('GET', /^\/api\/takeover\/preview/, () => preview);
  return takeoverClick(
    {
      machine: harness.machine,
      transport: harness.fake.transport,
      newKey: counter('key'),
      epoch: () => 0,
    },
    { preset: 'bp_farm', context: E0_CONTEXT, pageContext: PAGE },
  );
}

describe('a takeover click', () => {
  it('reads the preview of the run, then sends the recorded request body once and nothing else', async () => {
    const harness = machineHarness();
    expect((await click(harness)).kind).toBe('sent');
    expect(harness.fake.requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      'GET /api/takeover/preview?preset=bp_farm',
      'POST /api/control',
    ]);
    const recorded = takeoverRecorded('launch_free.accepted_nothing_owns_the_emulator').request as {
      attach: object;
    };
    // The recorded request declared tier 15; this page never declares one.
    expect(postBodies(harness.fake, '/api/control')).toEqual([
      {
        ...recorded,
        idempotency_key: 'key-0001',
        attach: { ...recorded.attach, tier: { value: null, provenance: 'unknown' } },
      },
    ]);
  });

  it.each([
    [
      'the emulator is held by a collector',
      'preview_collector.run_preview_collector_owns_the_emulator',
    ],
    ['another runner holds it', 'preview_blocked.run_preview_another_runner_owns_the_emulator'],
  ])('sends nothing when %s: the person confirmed a battle nobody owns', async (_name, path) => {
    const harness = machineHarness();
    expect(await click(harness, takeoverRecorded(path))).toEqual({
      kind: 'not_sent',
      reason: 'changed',
    });
    expect(harness.fake.writes()).toEqual([]);
  });

  it('sends nothing when the preview is refused or cannot be read', async () => {
    const refused = machineHarness();
    expect(
      await click(refused, takeoverRecorded('preview_blocked.run_preview_unknown_run')),
    ).toEqual({ kind: 'not_sent', reason: 'unreadable' });
    const broken = machineHarness();
    expect(await click(broken, { status: 500, body: 'boom' })).toEqual({
      kind: 'not_sent',
      reason: 'unreadable',
    });
    expect([...refused.fake.writes(), ...broken.fake.writes()]).toEqual([]);
  });

  it('sends the request of a run the server calls incompatible: the refusal is the server’s to word', async () => {
    const harness = machineHarness();
    expect(
      (await click(harness, takeoverRecorded('preview_blocked.run_preview_incompatible'))).kind,
    ).toBe('sent');
    expect(harness.fake.writes()).toHaveLength(1);
  });
});

describe('what the answer settles (a takeover is settled like a start)', () => {
  const answerOf = (path: string) => {
    const recorded = takeoverRecorded(path);
    return { status: recorded.status, body: recorded.body, contract: 'exact' as const, issues: [] };
  };
  const phaseOf = (path: string) => settledPhase('takeover', answerOf(path), {});

  it.each([
    ['launch_free.accepted_nothing_owns_the_emulator', 'confirmed'],
    ['launch_free.failed_after_accept_read_back_by_the_same_request', 'confirmed'],
    ['refusals.takeover_not_compatible', 'refused'],
    ['refusals.calibration_needed', 'refused'],
    ['refusals.context_changed', 'refused'],
    ['refusals.device_owned_by_another_runner', 'refused'],
    ['refusals.invalid_unknown_run', 'refused'],
    ['refusals_collector.attach_battle_changed', 'refused'],
  ] as const)('%s is %s', (path, phase) => {
    expect(phaseOf(path)).toBe(phase);
  });

  it('every recorded takeover answer settles to a phase, never throws', () => {
    for (const path of takeoverCaseNames().filter(
      (name) => name.startsWith('refusals') || name.startsWith('launch_'),
    ))
      expect(['confirmed', 'refused', 'unconfirmed']).toContain(phaseOf(path));
  });

  it('a reply that is not an answer leaves the outcome unknown', () => {
    expect(
      settledPhase('takeover', { status: 500, body: 'boom', contract: 'drift', issues: [] }, {}),
    ).toBe('unconfirmed');
  });
});
