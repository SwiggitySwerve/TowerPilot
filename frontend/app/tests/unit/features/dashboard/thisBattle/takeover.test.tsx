import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { afterEach, expect, it, vi } from 'vitest';
import { own } from '../../../../../src/core/read.ts';
import { ThisBattle } from '../../../../../src/features/dashboard/thisBattle/ThisBattle.tsx';
import type { DashboardState } from '../../../../../src/store/types.ts';
import { textOutsideCatalogue } from '../../../copy/renderedText.ts';
import { addBody, addCase, regionState } from '../../../store/regionHelpers.ts';
import { dashboardBody } from '../../../../support/dashboardFixture.ts';
import { e0Config, postBodies } from '../../../../support/dataLayer.ts';
import { sample, statusBody } from '../../../../support/fixture.ts';
import { takeoverRecorded } from '../../../../support/takeoverFixture.ts';
import { renderPage, renderRegion } from '../harness.tsx';

afterEach(() => {
  vi.useRealTimers();
});

const guards = dashboardBody('status.guards_clear');

/** A free emulator with no tracked battle and a run to pick: where a battle on screen is a person's. */
function freeState(): DashboardState {
  return addCase(
    addBody(addCase(regionState(), 'runs', 'runs.ready'), 'status', {
      ...statusBody(sample('status.off')),
      setup_battle_guard: own(guards, 'setup_battle_guard'),
      collection_guard: own(guards, 'collection_guard'),
    }),
    'battlesActive',
    'battles_active.null_no_driver',
  );
}

async function audit(container: HTMLElement) {
  expect(textOutsideCatalogue(container)).toEqual([]);
  expect(await axe(container)).toHaveNoViolations();
}

it('is offered where nothing tracks a battle and nothing holds the emulator, and only opens the confirmation', async () => {
  const { view, commands } = renderRegion(freeState(), <ThisBattle />);
  const button = view.getByRole('button', { name: 'Take over this battle' });
  expect(button).not.toHaveAttribute('aria-disabled');
  button.click();
  expect(await view.findByRole('dialog')).toBeVisible();
  expect(view.getByRole('heading', { name: 'Take over the battle on screen?' })).toBeVisible();
  expect(commands.takeOver).not.toHaveBeenCalled();
  await audit(view.container);
});

it('sends the confirmed request through the takeOver command, and cancel sends nothing', async () => {
  const { view, commands } = renderRegion(freeState(), <ThisBattle />);
  const user = userEvent.setup();
  await user.click(view.getByRole('button', { name: 'Take over this battle' }));
  await user.click(within(await view.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(commands.takeOver).not.toHaveBeenCalled();
  await user.click(view.getByRole('button', { name: 'Take over this battle' }));
  await user.click(
    within(await view.findByRole('dialog')).getByRole('button', { name: 'Take over' }),
  );
  expect(commands.takeOver).toHaveBeenCalledExactlyOnceWith({
    epoch: expect.any(Number) as number,
    preset: expect.any(String) as string,
  });
});

it.each([
  [
    'a battle is tracked',
    addCase(freeState(), 'battlesActive', 'battles_active.runtime_ad_orbit_shopping'),
  ],
  [
    'a collector holds the emulator',
    addBody(freeState(), 'status', {
      ...(dashboardBody('status.processes_linked_collector') as object),
      setup_battle_guard: own(guards, 'setup_battle_guard'),
      collection_guard: own(guards, 'collection_guard'),
    }),
  ],
  [
    'the emulator has not been read',
    addCase(regionState(), 'battlesActive', 'battles_active.null_no_driver'),
  ],
])('is not offered when %s', (_name, state) => {
  const { view } = renderRegion(state, <ThisBattle />);
  expect(view.queryByRole('button', { name: 'Take over this battle' })).toBeNull();
});

it('is disabled with Start next’s reason while no run is picked', () => {
  const { view } = renderRegion(
    addBody(freeState(), 'runs', { runs: {}, readiness: {} }),
    <ThisBattle />,
  );
  const button = view.getByRole('button', { name: 'Take over this battle' });
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(button).toHaveAccessibleDescription('Pick a run');
});

it.each([
  [
    'the worker read the battle off the screen',
    takeoverRecorded('real_worker.battle_read_after_the_real_worker_entered').body['battle'],
    true,
  ],
  [
    'a takeover is prepared but the worker has not read the screen',
    takeoverRecorded('launch_collector.battle_with_the_later_wave_but_no_entry_observation').body[
      'battle'
    ],
    false,
  ],
])('shows the battle as taken over only when %s', (_name, battle, shown) => {
  const { view } = renderRegion(
    addBody(regionState(), 'battlesActive', { battle }),
    <ThisBattle />,
  );
  const fact = view.queryByText('Taken over from the screen');
  expect(fact !== null).toBe(shown);
  expect(view.queryByRole('button', { name: 'Take over this battle' })).toBeNull();
});

const PREVIEW = '/api/takeover/preview?preset=bp_farm';

async function takeOver(
  routes: (
    fake: Parameters<NonNullable<Parameters<typeof renderPage>[0]>['before'] & object>[0],
  ) => void,
) {
  vi.useFakeTimers();
  const page = await renderPage({
    config: () => e0Config(true),
    status: () => ({
      ...statusBody(sample('status.off')),
      setup_battle_guard: own(guards, 'setup_battle_guard'),
      collection_guard: own(guards, 'collection_guard'),
    }),
    before: routes,
  });
  await page.advance(5000);
  expect(page.fake.writes()).toEqual([]);
  await page.user.click(page.view.getByRole('button', { name: 'Take over this battle' }));
  expect(page.fake.requests.some((request) => request.path.startsWith('/api/takeover'))).toBe(
    false,
  );
  await page.user.click(page.view.getByRole('button', { name: 'Take over' }));
  await page.advance();
  return page;
}

it('a click reads the preview, sends the one request and words an accepted launch as requested, never attached', async () => {
  const page = await takeOver((fake) => {
    const preview = takeoverRecorded('preview_free.run_preview_nothing_owns_the_emulator');
    fake.route('GET', PREVIEW, () => ({ status: preview.status, body: preview.body }));
    const accepted = takeoverRecorded('launch_free.accepted_nothing_owns_the_emulator');
    fake.route('POST', '/api/control', () => ({ status: accepted.status, body: accepted.body }));
  });
  try {
    const sent = postBodies(page.fake, '/api/control');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      action: 'takeover',
      preset: 'bp_farm',
      attach: { mode: 'current_battle', attestation: 'current_battle_takeover' },
    });
    const text = page.view.container.textContent;
    expect(text).toContain('Takeover requested; the worker has not attached yet');
    expect(text).not.toContain('Taken over');
    await page.advance(10000);
    expect(postBodies(page.fake, '/api/control')).toHaveLength(1);
  } finally {
    page.data.stop();
  }
});

const OPERATION = /^\/api\/operations\//u;

it('follows the accepted operation and shows the worker’s refusal in its own words, code and detail', async () => {
  const refusal = takeoverRecorded(
    'real_worker_refused.operation_failed_read_by_id_after_the_real_worker_refused',
  );
  const error = (refusal.body['operation'] as { error: { code: string; message: string } }).error;
  const page = await takeOver((fake) => {
    const preview = takeoverRecorded('preview_free.run_preview_nothing_owns_the_emulator');
    fake.route('GET', PREVIEW, () => ({ status: preview.status, body: preview.body }));
    const accepted = takeoverRecorded('launch_free.accepted_nothing_owns_the_emulator');
    fake.route('POST', '/api/control', () => ({ status: accepted.status, body: accepted.body }));
    fake.route('GET', OPERATION, () => ({ status: refusal.status, body: refusal.body }));
  });
  try {
    await page.advance(3000);
    const text = page.view.container.textContent;
    expect(text).toContain(error.code);
    expect(text).toContain(error.message);
    expect(text).not.toContain('Takeover requested; the worker has not attached yet');
    expect(text).not.toContain('Taken over');
    expect(postBodies(page.fake, '/api/control')).toHaveLength(1);
    const reads = page.fake.requests.filter((request) => OPERATION.test(request.path));
    expect(reads.length).toBeGreaterThan(0);
    await page.advance(10000);
    expect(page.fake.requests.filter((request) => OPERATION.test(request.path))).toHaveLength(
      reads.length,
    );
  } finally {
    page.data.stop();
  }
});

it('keeps reading the operation while the worker has not ended it, and says requested until it does', async () => {
  const running = takeoverRecorded('real_worker_refused.operation_running_read_by_id');
  const failed = takeoverRecorded(
    'real_worker_refused.operation_failed_read_by_id_after_the_real_worker_refused',
  );
  let answer = running;
  const page = await takeOver((fake) => {
    const preview = takeoverRecorded('preview_free.run_preview_nothing_owns_the_emulator');
    fake.route('GET', PREVIEW, () => ({ status: preview.status, body: preview.body }));
    const accepted = takeoverRecorded('launch_free.accepted_nothing_owns_the_emulator');
    fake.route('POST', '/api/control', () => ({ status: accepted.status, body: accepted.body }));
    fake.route('GET', OPERATION, () => ({ status: answer.status, body: answer.body }));
  });
  try {
    await page.advance(5000);
    expect(page.view.container.textContent).toContain(
      'Takeover requested; the worker has not attached yet',
    );
    const reads = page.fake.requests.filter((request) => OPERATION.test(request.path));
    expect(reads.length).toBeGreaterThan(1);
    answer = failed;
    await page.advance(3000);
    const text = page.view.container.textContent;
    expect(text).toContain('attach_no_battle');
    expect(text).not.toContain('Takeover requested; the worker has not attached yet');
  } finally {
    page.data.stop();
  }
});

it('shows the server’s own words for a refusal', async () => {
  const refused = takeoverRecorded('refusals.takeover_not_compatible');
  const page = await takeOver((fake) => {
    const preview = takeoverRecorded('preview_blocked.run_preview_incompatible');
    fake.route('GET', PREVIEW, () => ({ status: preview.status, body: preview.body }));
    fake.route('POST', '/api/control', () => ({ status: refused.status, body: refused.body }));
  });
  try {
    expect(postBodies(page.fake, '/api/control')).toHaveLength(1);
    const text = page.view.container.textContent;
    expect(text).toContain('The takeover was refused');
    expect(text).toContain(String(refused.body['error']));
    expect(text).not.toContain('Taken over');
  } finally {
    page.data.stop();
  }
});

it('sends nothing, and says why, when the emulator is held by the time it is confirmed', async () => {
  const page = await takeOver((fake) => {
    const preview = takeoverRecorded('preview_collector.run_preview_collector_owns_the_emulator');
    fake.route('GET', PREVIEW, () => ({ status: preview.status, body: preview.body }));
  });
  try {
    expect(page.fake.writes()).toEqual([]);
    expect(page.view.container.textContent).toContain(
      'Takeover not sent: the emulator or its owner changed since this page last read it',
    );
  } finally {
    page.data.stop();
  }
});
