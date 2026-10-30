import { describe, expect, it } from 'vitest';
import { takeoverPreview, workerAttached, type TakeoverRead } from '../../../src/core/takeover.ts';
import { takeoverRecorded } from '../../support/takeoverFixture.ts';

const PAGE = {
  instance: 'main',
  account: null,
  serial: 'fake:1',
  rendering: null,
  profile: 'mine',
};

type Answered = Extract<TakeoverRead, { kind: 'answered' }>;

function answered(path: string, patch: Record<string, unknown> = {}): Answered {
  const recorded = takeoverRecorded(path);
  return {
    kind: 'answered',
    status: recorded.status,
    body: { ...recorded.body, ...patch },
    sameContext: true,
  };
}

describe('takeoverPreview: what the confirmation may send', () => {
  it('reads the revision, context and battle of a free emulator as the server sent them', () => {
    const preview = takeoverPreview(
      answered('preview_free.run_preview_nothing_owns_the_emulator'),
      'bp_farm',
      PAGE,
    );
    expect(preview).toEqual({
      kind: 'ready',
      preset: 'bp_farm',
      policyRevision: '5e55f85597292d3321c3a0724f017818bc14c369ea3e2e58cc3fa2a586aa5f30',
      context: PAGE,
      expectedBattle: { battleId: null, generation: null, observedWave: null },
    });
  });

  it.each([
    // The server refuses these with its own reason when asked; the page does not guess.
    'preview_blocked.run_preview_incompatible',
    'preview_blocked.run_preview_calibration_needed',
    'preview_blocked.run_preview_tournament_recognition_missing',
  ])('%s is still sent, so the backend refuses it in its own words', (path) => {
    expect(takeoverPreview(answered(path), 'bp_farm', PAGE).kind).toBe('ready');
  });

  it.each([
    'preview_collector.run_preview_collector_owns_the_emulator',
    'preview_blocked.run_preview_another_runner_owns_the_emulator',
  ])('%s is changed: the battle is not an unowned one any more', (path) => {
    expect(takeoverPreview(answered(path), 'bp_farm', PAGE).kind).toBe('changed');
  });

  it('is changed when the answer names another context than the page', () => {
    const read = answered('preview_free.run_preview_nothing_owns_the_emulator');
    expect(takeoverPreview(read, 'bp_farm', { ...PAGE, profile: 'other' }).kind).toBe('changed');
  });

  it('is changed when the page context moved while the read was in flight', () => {
    const read = answered('preview_free.run_preview_nothing_owns_the_emulator');
    expect(takeoverPreview({ ...read, sameContext: false }, 'bp_farm', PAGE).kind).toBe('changed');
  });

  it.each<[string, TakeoverRead]>([
    ['a failed read', { kind: 'failed' }],
    ['an unknown run (400)', answered('preview_blocked.run_preview_unknown_run')],
    [
      'a run the server could not read (no revision)',
      answered('preview_free.run_preview_nothing_owns_the_emulator', {
        run: { preset: 'bp_farm', verdict: 'unreadable', reasons: [], policy_revision: null },
      }),
    ],
    [
      'a revision that is not 64 hex digits',
      answered('preview_free.run_preview_nothing_owns_the_emulator', {
        run: { preset: 'bp_farm', verdict: 'compatible', reasons: [], policy_revision: 'abc' },
      }),
    ],
    [
      'an answer for another run',
      answered('preview_free.run_preview_nothing_owns_the_emulator', { preset: 'bp_other' }),
    ],
    [
      'a battle id on a free emulator',
      answered('preview_free.run_preview_nothing_owns_the_emulator', {
        current_battle: { battle_id: 'b1', generation: 'g1', observed_wave: 3 },
      }),
    ],
    [
      'a missing context',
      answered('preview_free.run_preview_nothing_owns_the_emulator', { context: null }),
    ],
  ])('is unreadable for %s', (_name, read) => {
    expect(takeoverPreview(read, 'bp_farm', PAGE).kind).toBe('unreadable');
  });
});

describe('workerAttached: only the worker having read the battle makes it taken over', () => {
  it('is true for the recorded battle whose entry gate observed the wave', () => {
    const battle = takeoverRecorded('real_worker.battle_read_after_the_real_worker_entered').body[
      'battle'
    ];
    expect(workerAttached(battle)).toBe(true);
  });

  it.each([
    // The attach block is on the battle from the moment it is prepared; no entry observation yet.
    'launch_collector.battle_after_taking_over_the_collectors_battle',
    'launch_collector.battle_with_the_later_wave_but_no_entry_observation',
    'attached_battle.battle_after_stop_is_interrupted_and_the_game_battle_is_untouched',
    'real_worker_refused.no_battle_after_the_real_worker_refused',
  ])('is false for %s', (path) => {
    expect(workerAttached(takeoverRecorded(path).body['battle'])).toBe(false);
  });

  it('is false for an accepted launch answer, a null battle, another mode and a wave that is not a count', () => {
    const accepted = takeoverRecorded('launch_free.accepted_nothing_owns_the_emulator').body;
    const entry = { mode: 'current_battle', observed_wave_source: 'entry_gate' };
    expect(workerAttached(accepted)).toBe(false);
    expect(workerAttached(null)).toBe(false);
    expect(workerAttached({ attach: { ...entry, mode: 'other', observed_wave: 4388 } })).toBe(
      false,
    );
    expect(
      workerAttached({ attach: { ...entry, observed_wave_source: null, observed_wave: 4388 } }),
    ).toBe(false);
    expect(workerAttached({ attach: { ...entry, observed_wave: null } })).toBe(false);
    expect(workerAttached({ attach: { ...entry, observed_wave: -1 } })).toBe(false);
    expect(workerAttached({ attach: { ...entry, observed_wave: 4388 } })).toBe(true);
  });
});
