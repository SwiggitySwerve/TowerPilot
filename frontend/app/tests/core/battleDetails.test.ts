import { describe, expect, it } from 'vitest';
import { BATTLE_REPORT_MAX_AGE_SEC, battleServerNow } from '../../src/core/battle.ts';
import { ownPath } from '../../src/core/read.ts';
import { adGemsDetails, floatingRefusal, routineEventsQuery } from '../../src/core/routines.ts';
import { dashboardBody, dashboardPagesCase } from '../support/dashboardFixture.ts';

/**
 * F6-11 RL7 (backend/logs/reviews/ui-pages/f6-11-runs-leftovers-brief.md, spec F-062, F-063):
 * the battle details the Runs live section shows, from the recorded battle reads
 * (dashboard_contract_v1.json battles_active, dashboard_contract_pages_v1.json run_controls_live).
 */
const RECORDED = dashboardBody('battles_active.runtime_ad_orbit_shopping');
const battleOf = (body: unknown) => ownPath(body, 'battle');
const routine = (body: unknown, name: string): Record<string, unknown> => {
  const found = ownPath(body, 'battle', 'runtime', 'routines', name);
  if (typeof found !== 'object' || found === null) throw new Error(`no ${name} routine`);
  return { ...(found as Record<string, unknown>) };
};
const live = (name: string) => dashboardPagesCase(`run_controls_live.${name}`).body;
const NOW = 1_800_000_002;

describe('F6-11 RL7 Ad gems details', () => {
  it('RL7 the recorded report: offer not observed, window open, counters and timing as sent', () => {
    expect(adGemsDetails(routine(RECORDED, 'ad_gems'), NOW)).toEqual({
      visibility: 'unknown',
      visibilityReason: 'not_observed',
      observationStale: false,
      firstSeenAt: null,
      appearance: null,
      lastObservedAt: null,
      collection: { kind: 'window', responseDueAt: null, windowEndsAt: 1_800_000_020 },
      nextCheckAt: 0,
      failedAttempt: null,
      counters: { attempts: 0, confirmed: 1, skips: 0, windowsMissed: 0 },
      durations: { schedulingWaitSec: null, responseDelaySec: null, verificationSec: 2 },
    });
  });

  it('RL7 a switched-off collector reads "off"; a scheduled one names its next window (recorded)', () => {
    const off = routine(live('read_after_several_changes_overrides_and_applied_values'), 'ad_gems');
    expect(off['enabled']).toBe(false);
    expect(adGemsDetails(off, NOW).collection).toEqual({ kind: 'off' });
    const on = routine(live('read_before_the_first_change'), 'ad_gems');
    expect(adGemsDetails(on, NOW).collection).toEqual({
      kind: 'scheduled',
      nextDueAt: 1_800_000_002,
    });
  });

  // Modified recorded case: no recorded read has a seen offer or a failed attempt yet
  // (requested as battles_active.ad_gems_offer_seen_and_failed_attempt); the recorded
  // collector gets an observation, a sighting and a failure in its own field names.
  function seen(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      ...routine(RECORDED, 'ad_gems'),
      visibility: 'visible',
      visibility_reason: null,
      last_observed_at: NOW - 3,
      first_seen_at: NOW - 10,
      appearance_after_at: NOW - 12.5,
      last_failed_attempt: { reason: 'claim_not_confirmed', observed_at: NOW - 4 },
      ...overrides,
    };
  }

  it('RL7 a fresh observation shows the offer as seen, with its appearance bounds and failure', () => {
    const details = adGemsDetails(seen({}), NOW);
    expect(details.visibility).toBe('visible');
    expect(details.visibilityReason).toBeNull();
    expect(details.observationStale).toBe(false);
    expect(details.appearance).toEqual({ afterAt: NOW - 12.5, byAt: NOW - 10, gapSec: 2.5 });
    expect(details.failedAttempt).toEqual({ reason: 'claim_not_confirmed', observedAt: NOW - 4 });
  });

  it("RL7 an observation older than the collector's own limit is not trusted: visibility unknown", () => {
    const details = adGemsDetails(seen({ last_observed_at: NOW - 9 }), NOW);
    expect(details.visibility).toBe('unknown');
    expect(details.observationStale).toBe(true);
    // Without a server clock nothing counts as fresh.
    expect(adGemsDetails(seen({}), null).visibility).toBe('unknown');
  });

  it('RL7 without stale_after_sec the battle report limit applies', () => {
    const base = seen({ stale_after_sec: undefined });
    expect(
      adGemsDetails({ ...base, last_observed_at: NOW - BATTLE_REPORT_MAX_AGE_SEC }, NOW).visibility,
    ).toBe('visible');
    expect(
      adGemsDetails({ ...base, last_observed_at: NOW - BATTLE_REPORT_MAX_AGE_SEC - 1 }, NOW)
        .visibility,
    ).toBe('unknown');
  });

  it('RL7 a failed attempt without a reason names its outcome; a manual collection keeps its timing', () => {
    const details = adGemsDetails(
      seen({
        last_failed_attempt: { outcome: 'window_missed', observed_at: NOW - 4 },
        enabled: false,
        manual_pending: true,
        window_ends_at: NOW + 6,
        response_due_at: NOW + 2,
      }),
      NOW,
    );
    expect(details.failedAttempt).toEqual({ reason: 'window_missed', observedAt: NOW - 4 });
    expect(details.collection).toEqual({
      kind: 'window',
      responseDueAt: NOW + 2,
      windowEndsAt: NOW + 6,
    });
  });
});

describe('F6-11 RL7 Floating gems refusal and the Runtime link', () => {
  it('RL7 the recorded Floating gems report has no refusal', () => {
    expect(floatingRefusal(routine(RECORDED, 'floating_gems'))).toBeNull();
  });

  // Modified recorded case: no recorded read has a refusal yet (requested as
  // battles_active.floating_gems_refusal_recorded).
  it('RL7 a recorded refusal is shown with its reason and time', () => {
    const raw = {
      ...routine(RECORDED, 'floating_gems'),
      last_refusal: { reason: 'human_owner', observed_at: NOW - 30 },
    };
    expect(floatingRefusal(raw)).toEqual({ reason: 'human_owner', observedAt: NOW - 30 });
  });

  it("RL7 Inspect events filters Runtime by the battle, its operation and the routine's offer", () => {
    expect(routineEventsQuery(battleOf(RECORDED), routine(RECORDED, 'ad_gems'))).toEqual({
      battle_id: '00000015-0000-4000-8000-000000000000',
      operation_id: '00000016-0000-4000-8000-000000000000',
      offer_id: 'battles_runtime-offer',
    });
    expect(routineEventsQuery(battleOf(RECORDED), routine(RECORDED, 'shopping'))).toEqual({
      battle_id: '00000015-0000-4000-8000-000000000000',
      operation_id: '00000016-0000-4000-8000-000000000000',
    });
  });

  it('RL7 a sighted offer starts the Runtime filter a minute before its first sighting', () => {
    const raw = { ...routine(RECORDED, 'ad_gems'), first_seen_at: NOW - 10 };
    expect(routineEventsQuery(battleOf(RECORDED), raw)['since']).toBe(String(NOW - 70));
    expect(routineEventsQuery(battleOf(RECORDED), { first_seen_at: 30 })['since']).toBe('0');
  });

  it("RL7 the server clock is the read's server_time plus the time since it arrived", () => {
    expect(battleServerNow(RECORDED, 4)).toBe(NOW + 4);
    expect(battleServerNow({}, 4)).toBeNull();
    expect(battleServerNow(RECORDED, -1)).toBeNull();
  });
});
