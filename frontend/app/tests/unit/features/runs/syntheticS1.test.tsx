import { act, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syntheticCase } from '../../../support/synthetic-action-fixtures.mjs';
import { collectionEvidence, gemFlags, runGemReport } from '../../../../src/core/collection.ts';
import { gemPolicy, policyCollects } from '../../../../src/core/gemSource.ts';
import { historyCollection } from '../../../../src/core/history.ts';
import { overlayView } from '../../../../src/core/overlay.ts';
import { ownPath } from '../../../../src/core/read.ts';
import { readHarvest } from '../../../../src/core/readability.ts';
import { collectGate } from '../../../../src/core/readiness.ts';
import { collectionGuard } from '../../../../src/core/guards.ts';
import { unknownFact } from '../../../../src/core/facts.ts';
import { selectGemSlot } from '../../../../src/store/selectors/gemSlot.ts';
import { required } from '../../../support/required.ts';
import { e0Config, postBodies } from '../../../support/dataLayer.ts';
import { statusBody } from '../../../support/fixture.ts';
import { renderPage } from '../dashboard/harness.tsx';

const STATUS = 'synthetic_harvest_on_keeps_collection_gem_only';
const BATTLE = 'synthetic_harvest_on_battle_read';
const ACCEPTED = 'synthetic_harvest_on_accepted';
const TOKEN = String(ownPath(syntheticCase('synthetic_run_now_accepted').request.body, 'action'));
const ID = required(TOKEN.split('@')[0]);

/** Counterfactual: remove only this test action, keeping every gem value and clock identical. */
function withoutSynthetic(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .filter((entry) =>
        typeof entry === 'string' ? !entry.includes(ID) : ownPath(entry, 'id') !== ID,
      )
      .map(withoutSynthetic);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.includes(ID))
      .map(([key, entry]) => [key, withoutSynthetic(entry)]),
  );
}

function s1(status: unknown, battle: unknown) {
  const read = readHarvest(ownPath(status, 'harvest'));
  if (read.kind !== 'known') throw new Error('B1 harvest must pass D-1');
  const routines = ownPath(battle, 'effective', 'routines');
  const policy = gemPolicy(routines);
  const guard = collectionGuard({ scope: 'collection', blocks_launch: false }, 1);
  if (guard.kind !== 'permit') throw new Error('Missing test permit');
  const context = ownPath(battle, 'context');
  const preview = { blueprint: 'farm', context, settings: { routines } };
  return {
    overlay: overlayView(read.value),
    collection: collectionEvidence(read.value),
    runGems: runGemReport(read.value),
    flags: gemFlags(routines),
    source: policy,
    collects: policyCollects(policy),
    readiness: collectGate(
      guard.permit,
      { kind: 'answered', sameContext: true, body: preview },
      context,
      'bp_farm',
      false,
      unknownFact('test_ownership'),
    ),
    history: historyCollection(battle),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('AC7 keyboard Turn on sends the exact harvest request; recorded read-side S1 outputs stay unchanged', async () => {
  const receipt = syntheticCase(ACCEPTED);
  const harvest = ownPath(syntheticCase(STATUS).body, 'harvest') as Record<string, unknown>;
  // Pre-enable B1 derivative: only choice/enabled/revision change to off/false/0.
  // Startup transport metadata supplies a connected device, fresh scan and permitting guard.
  Object.assign(ownPath(harvest, 'desired') as object, {
    choice: 'off',
    enabled: false,
    revision: ownPath(receipt.request.body, 'expected_revision'),
  });
  let status: unknown = {
    ...statusBody(harvest),
    device_state: 'device',
    collection_guard: { scope: 'collection', blocks_launch: false },
  };
  let active: unknown = syntheticCase('synthetic_active_two_instances').body;
  const page = await renderPage({
    config: () => e0Config(true),
    status: () => status,
    newKey: () => String(ownPath(receipt.request.body, 'idempotency_key')),
    before: (fake) => {
      fake.route('GET', '/api/battles/active', () => ({ status: 200, body: active }));
      fake.route('POST', receipt.request.path, () => receipt);
    },
  });
  await page.advance(100);
  expect(page.view.getAllByRole('button', { name: 'Run now Synthetic probe' })).toHaveLength(2);
  const slot = () =>
    required(page.view.getByRole('heading', { name: 'Gem harvesting' }).closest('section'));
  const turnOn = within(slot()).getByRole('button', { name: 'Turn on' });
  expect(selectGemSlot(page.data.store.getSnapshot()).turnOn.enabled).toBe(true);
  act(() => {
    turnOn.focus();
  });
  expect(turnOn).toHaveFocus();
  await page.user.keyboard('{Enter}');
  await page.advance(100);
  expect(page.fake.writes()).toHaveLength(1);
  expect(page.fake.writes()[0]).toMatchObject({
    method: receipt.request.method,
    path: receipt.request.path,
  });
  expect(postBodies(page.fake)).toEqual([receipt.request.body]);
  status = syntheticCase(STATUS).body;
  active = syntheticCase(BATTLE).body;
  act(() => {
    page.data.commands.checkStatus();
    page.data.commands.checkBattle();
  });
  await page.advance(100);
  expect(selectGemSlot(page.data.store.getSnapshot()).choice.word).toBe('on');
  expect(within(slot()).queryByRole('button', { name: 'Turn on' })).toBeNull();
  const withVM = selectGemSlot(page.data.store.getSnapshot());
  const withText = slot().textContent;
  const withControls = [...slot().querySelectorAll('button, select')].map(
    (element) => element.outerHTML,
  );
  for (const name of [ACCEPTED, STATUS]) {
    const body = syntheticCase(name).body;
    const battle = ownPath(active, 'battle');
    // D-6 is explicitly NOT covered by B1: both records stop at no_operation.
    expect(s1(body, battle).collection).toEqual({ kind: 'unknown', reason: 'no_operation' });
    expect(s1(body, battle)).toEqual(s1(withoutSynthetic(body), withoutSynthetic(battle)));
    expect(s1(body, battle).overlay.routines.map((row) => row.routine)).toEqual([
      'ad_gems',
      'floating_gems',
    ]);
  }
  const battle = ownPath(active, 'battle');
  const command = required((ownPath(battle, 'commands') as Record<string, unknown>[])[0]);
  expect(ownPath(command, 'payload')).toEqual({ routines: { floating_gems: { enabled: true } } });
  const acceptedOwner = ownPath(syntheticCase(ACCEPTED).body, 'harvest', 'owner', 'routines');
  const afterRoutines = ownPath(battle, 'runtime', 'routines');
  for (const key of Object.keys(acceptedOwner as object).filter((key) => key.includes(ID))) {
    expect(ownPath(afterRoutines, key, 'enabled')).toBe(ownPath(acceptedOwner, key, 'enabled'));
    expect(ownPath(battle, 'effective', 'routines', key, 'enabled')).toBe(true);
    expect(ownPath(command, 'applied_paths')).not.toContain(`routines.${key}.enabled`);
  }
  status = withoutSynthetic(status);
  active = withoutSynthetic(active);
  act(() => {
    page.data.commands.checkStatus();
    page.data.commands.checkBattle();
  });
  await page.advance(100);
  expect(selectGemSlot(page.data.store.getSnapshot())).toEqual(withVM);
  expect(slot().textContent).toBe(withText);
  expect(
    [...slot().querySelectorAll('button, select')].map((element) => element.outerHTML),
  ).toEqual(withControls);
  expect(postBodies(page.fake)).toEqual([receipt.request.body]);
});

it('AC7 S1 only enabled synthetic routines never qualify as a gem source or Collect authority', () => {
  const active = syntheticCase(BATTLE).body;
  const battle = ownPath(active, 'battle');
  // Adversarial B1 derivative: both real gem routines off; both synthetic instances stay on.
  const routines = ownPath(battle, 'effective', 'routines') as Record<string, unknown>;
  for (const key of ['ad_gems', 'floating_gems'])
    Reflect.set(routines[key] as object, 'enabled', false);
  const result = s1(syntheticCase(STATUS).body, battle);
  expect(result.flags).toEqual({ adGems: false, floatingGems: false });
  expect(result.collects).toBe(false);
  expect(result.readiness).toEqual({ enabled: false, reason: 'gem_routines_off' });
  expect(result).toEqual(
    s1(withoutSynthetic(syntheticCase(STATUS).body), withoutSynthetic(battle)),
  );
});
