import { within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textOutsideCatalogue } from '../../copy/renderedText.ts';
import { e0Config } from '../../support/dataLayer.ts';
import {
  dashboardCase,
  dashboardPagesCase,
  type DashboardCase,
} from '../../support/dashboardFixture.ts';
import { sample, statusBody } from '../../support/fixture.ts';
import { renderPage, type PageOptions } from '../dashboard/harness.tsx';

/**
 * F6-11 Runs leftovers (backend/logs/reviews/ui-pages/f6-11-runs-leftovers-brief.md) on the
 * whole wired app, replaying the recorded live-change family
 * (backend/tests/fixtures/dashboard_contract_pages_v1.json, run_controls_live).
 */
const live = (name: string) => dashboardPagesCase(`run_controls_live.${name}`);
const BATTLE = /^\/api\/battles\/active$/u;
const RESET = live('accepted_null_resets_a_path_to_the_battles_starting_value');
const RESET_KEY = (RESET.request.body as { idempotency_key: string }).idempotency_key;

/**
 * The battle the recorded reset was sent to: revision 2 with its ad-gem numbers applied.
 * Modified recorded case: no read was recorded between the numbers change and the reset,
 * so the battle of `accepted_numbers_after_the_previous_change_applied` (control revision 2)
 * gets the driver's application of it (applied revision 2, applied overrides = overrides).
 */
function battleBeforeReset(): DashboardCase {
  const answered = live('accepted_numbers_after_the_previous_change_applied');
  const read = live('read_after_the_driver_applied_the_change');
  const battle = structuredClone((answered.body as { battle: Record<string, unknown> }).battle);
  battle['applied_revision'] = battle['control_revision'];
  battle['applied_overrides'] = structuredClone(battle['overrides']);
  const body = { ...(read.body as Record<string, unknown>), battle };
  return { ...read, body };
}

async function openLive(read: () => DashboardCase, options: PageOptions = {}) {
  window.location.hash = '#runs/live';
  const page = await renderPage({
    status: () => statusBody(sample('status.off')),
    config: () => e0Config(true),
    ...options,
    before: (fake) => {
      fake.route('GET', BATTLE, () => {
        const found = read();
        return { status: found.status, body: found.body };
      });
      options.before?.(fake);
    },
  });
  await page.advance(1_000);
  return page;
}

function liveRegion(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-region="runsLive"]');
  if (found === null) throw new Error('live region missing');
  return found;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('dialog[open]');
  if (found === null) throw new Error('no open dialog');
  return found;
}

const resetRows = () => [...liveRegion().querySelectorAll<HTMLElement>('[data-path]')];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  window.location.hash = '';
  vi.useRealTimers();
});

describe('F6-11 RL1 reset one live override', () => {
  it('RL1 a battle with no override offers no reset', async () => {
    await openLive(() => live('read_before_the_first_change'));
    expect(resetRows()).toEqual([]);
    expect(within(liveRegion()).queryByRole('button', { name: /starting value/u })).toBeNull();
  });

  it('RL1 every applied override of the battle is listed with its reset; a waiting one is not', async () => {
    await openLive(() => live('read_after_several_changes_overrides_and_applied_values'));
    expect(resetRows().map((row) => row.dataset['path'])).toEqual([
      'routines.ad_gems.enabled',
      'routines.ad_gems.window_sec',
      'routines.floating_gems.enabled',
      'routines.floating_gems.interval_sec',
      'routines.floating_gems.tap_interval_sec',
      'routines.shopping.enabled',
      'routines.shopping.interval_sec',
      'routines.rewards.enabled',
    ]);
    window.location.hash = '';
  });

  it('RL1 an override still waiting to apply offers no reset yet', async () => {
    await openLive(() => live('read_after_the_change_lists_the_command_and_its_key'));
    expect(resetRows()).toEqual([]);
  });

  it('RL1 Cancel sends nothing; a confirmed reset sends the recorded body and key once', async () => {
    const page = await openLive(battleBeforeReset, { newKey: () => RESET_KEY });
    const row = liveRegion().querySelector<HTMLElement>(
      '[data-path="routines.ad_gems.interval_sec"]',
    );
    if (row === null) throw new Error('no reset row');
    await page.user.click(within(row).getByRole('button', { name: /starting value/u }));
    expect(within(dialog()).getByText(/can differ from the saved settings/u)).toBeInTheDocument();
    await page.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await page.advance(1_000);
    expect(page.fake.writes()).toEqual([]);
    page.fake.route('POST', /live-controls$/u, () => ({ status: RESET.status, body: RESET.body }));
    await page.user.click(within(row).getByRole('button', { name: /starting value/u }));
    await page.user.click(within(dialog()).getByRole('button', { name: 'Use starting value' }));
    await page.advance(1_000);
    const writes = page.fake.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(RESET.request.path);
    expect(JSON.parse(writes[0]?.body ?? 'null')).toEqual(RESET.request.body);
    expect(within(liveRegion()).getByText('Sent to this battle - waiting to apply')).toBeVisible();
    await page.advance(30_000);
    expect(page.fake.writes()).toHaveLength(1);
  });

  it('RL1 a reset whose answer is lost stays unknown and is never resent on its own; the person may resend the identical request', async () => {
    const page = await openLive(battleBeforeReset, { newKey: () => RESET_KEY });
    page.fake.route('POST', /live-controls$/u, () => 'hold');
    const row = liveRegion().querySelector<HTMLElement>(
      '[data-path="routines.ad_gems.interval_sec"]',
    );
    if (row === null) throw new Error('no reset row');
    await page.user.click(within(row).getByRole('button', { name: /starting value/u }));
    await page.user.click(within(dialog()).getByRole('button', { name: 'Use starting value' }));
    await page.advance(100);
    page.fake.next(/live-controls$/u, 'POST').lose();
    await page.advance(60_000);
    expect(page.fake.writes()).toHaveLength(1);
    // While its outcome is unknown, a second reset of this battle waits.
    const again = liveRegion().querySelector<HTMLElement>(
      '[data-path="routines.ad_gems.interval_sec"]',
    );
    expect(
      within(again ?? liveRegion()).getByRole('button', { name: /starting value/u }),
    ).toHaveAttribute('aria-disabled', 'true');
    page.fake.route('POST', /live-controls$/u, () => ({ status: RESET.status, body: RESET.body }));
    await page.user.click(
      within(liveRegion()).getByRole('button', { name: 'Send same request again' }),
    );
    await page.advance(1_000);
    const writes = page.fake.writes();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toBe(writes[0]?.body);
  });

  it('RL1 the reset list uses catalogue words and passes axe', async () => {
    const page = await openLive(() =>
      live('read_after_several_changes_overrides_and_applied_values'),
    );
    expect(textOutsideCatalogue(page.view.container)).toEqual([]);
    vi.useRealTimers();
    expect(await axe(page.view.container)).toHaveNoViolations();
  });
});

const recordedBattle = (name: string) => () => dashboardCase(`battles_active.${name}`);
const detailsOf = (routine: string): HTMLDetailsElement => {
  const body = liveRegion().querySelector(`[data-routine-details="${routine}"]`);
  const found = body?.closest('details');
  if (found === null || found === undefined) throw new Error(`no ${routine} details`);
  return found;
};
const rowsOf = (routine: string): Record<string, string> =>
  Object.fromEntries(
    [...detailsOf(routine).querySelectorAll('.tp-run-details__row')].map((row) => [
      row.querySelector('dt span')?.textContent ?? '',
      row.querySelector('dd')?.textContent ?? '',
    ]),
  );

describe('F6-11 RL7 battle details in the live section', () => {
  it('RL7 each reported routine has its own closed "battle details" disclosure', async () => {
    await openLive(recordedBattle('runtime_ad_orbit_shopping'));
    const summaries = [
      ...liveRegion().querySelectorAll<HTMLElement>(
        '[data-part="runsDetails"] > details > summary',
      ),
    ];
    expect(summaries.map((s) => s.textContent)).toEqual([
      'Abilities: battle details',
      'Ad gems: battle details',
      'Floating gems: battle details',
      'Repeat: battle details',
      'Rescue: battle details',
      'Rewards: battle details',
      'Shopping: battle details',
    ]);
    expect(summaries.every((s) => !(s.parentElement as HTMLDetailsElement).open)).toBe(true);
  });

  it('RL7 Ad gems shows the recorded offer, timing, counts and the Runtime link', async () => {
    await openLive(recordedBattle('runtime_ad_orbit_shopping'));
    expect(rowsOf('ad_gems')).toEqual({
      Offer: 'Not knownnot_observed',
      'First seen': 'Not seen yet',
      Appeared: 'Not known; the first sighting is not when it appeared',
      'Last look at the battle': 'No look recorded',
      Collection: 'Window closes in 18 s',
      'Next look': 'Due now, waiting for the automation',
      'Latest failed attempt': 'None recorded',
      Counts: 'Attempts 0, confirmed 1, skipped 0, windows missed 0',
      'Last timing': 'Schedule wait not reported, response delay not reported, verification 2 s',
    });
    // The reason is the server's code, shown as sent.
    expect(detailsOf('ad_gems').querySelector('[data-server-text="id"]')?.textContent).toBe(
      'not_observed',
    );
    const link = within(detailsOf('ad_gems')).getByRole('link', {
      name: 'Events of this battle on Runtime',
    });
    expect(link).toHaveAttribute(
      'href',
      '#runtime?battle_id=00000015-0000-4000-8000-000000000000&operation_id=00000016-0000-4000-8000-000000000000&offer_id=battles_runtime-offer',
    );
  });

  it('RL7 Floating gems with no recorded refusal says so; other routines show only their link', async () => {
    await openLive(recordedBattle('runtime_ad_orbit_shopping'));
    expect(rowsOf('floating_gems')).toEqual({ 'Latest refusal': 'None recorded' });
    expect(rowsOf('shopping')).toEqual({});
    expect(
      within(detailsOf('shopping')).getByRole('link', { name: 'Events of this battle on Runtime' }),
    ).toHaveAttribute(
      'href',
      '#runtime?battle_id=00000015-0000-4000-8000-000000000000&operation_id=00000016-0000-4000-8000-000000000000',
    );
  });

  it("RL7 each routine's reported values are the server's own object, shown as sent", async () => {
    const recorded = dashboardCase('battles_active.runtime_ad_orbit_shopping');
    await openLive(() => recorded);
    const raw = detailsOf('ad_gems').querySelector('[data-server-text="detail"]');
    const routines = (
      recorded.body as { battle: { runtime: { routines: Record<string, unknown> } } }
    ).battle.runtime.routines;
    expect(JSON.parse(raw?.textContent ?? 'null')).toEqual(routines['ad_gems']);
  });

  it('RL7 a report that is not fresh marks the details as last known', async () => {
    await openLive(recordedBattle('stale_report'));
    expect(within(liveRegion()).getByText('Last known values')).toBeInTheDocument();
    expect(detailsOf('ad_gems')).toBeInstanceOf(HTMLDetailsElement);
  });

  it('RL7 a fresh report has no last-known note; no tracked battle shows no details', async () => {
    const page = await openLive(recordedBattle('runtime_ad_orbit_shopping'));
    expect(within(liveRegion()).queryByText('Last known values')).toBeNull();
    page.view.unmount();
    await openLive(recordedBattle('null_no_driver'));
    expect(liveRegion().querySelector('[data-part="runsDetails"]')).toBeNull();
  });

  it('RL7 the opened details use catalogue words and pass axe', async () => {
    const page = await openLive(recordedBattle('runtime_ad_orbit_shopping'));
    for (const details of liveRegion().querySelectorAll('details')) details.open = true;
    expect(textOutsideCatalogue(page.view.container)).toEqual([]);
    vi.useRealTimers();
    expect(await axe(page.view.container)).toHaveNoViolations();
  });
});
