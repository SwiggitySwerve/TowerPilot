import { act, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dashboardPagesCase } from '../../support/dashboardFixture.ts';
import { postBodies } from '../../support/dataLayer.ts';
import { renderPage, type PageOptions } from '../dashboard/harness.tsx';
import { selectCollectionPage } from '../../../src/store/selectors/collection.ts';
import { textOutsideCatalogue } from '../../copy/renderedText.ts';

const recorded = (name: string) => dashboardPagesCase(`profile_target.${name}`);

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('required test value missing');
  return value;
}

type Source = { profile: { policies: { gather: Record<string, unknown> } }; revision: string };

// Modified recorded source: the generator records intermediate patch receipts, not GETs.
// Project each receipt's persisted profile/revision into the recorded source envelope.
function sourceAfter(name: string) {
  const receipt = recorded(name).body as Source;
  return {
    ...recorded('same_account_inactive_target_source'),
    body: {
      ...(recorded('same_account_inactive_target_source').body as object),
      profile: receipt.profile,
      revision: receipt.revision,
    },
  };
}

async function openTarget(
  source = recorded('same_account_inactive_target_source'),
  hash = '#collection',
  options: PageOptions = {},
) {
  window.location.hash = hash;
  const page = await renderPage({
    ...options,
    before: (fake) => {
      for (const [path, name] of [
        ['/api/config', 'inactive_editor_context_before_save'],
        ['/api/profile-files', 'same_account_inactive_target_listed'],
        ['/api/profile-src/second', 'same_account_inactive_target_source'],
      ]) {
        fake.route('GET', required(path), () => recorded(required(name)));
      }
      fake.route('GET', '/api/profile-src/mine', () =>
        dashboardPagesCase('collection_policies.read_before_the_first_save'),
      );
      fake.route('GET', '/api/profile-src/second', () => source);
      fake.route('GET', '/api/settings', () => {
        const found = dashboardPagesCase('settings.populated_account_every_module');
        // Modified recorded settings: the legacy fixture uses an unbound installation;
        // the profile_target world binds the same active mine profile to account alpha.
        const body = found.body as { context: Record<string, unknown> };
        return { ...found, body: { ...body, context: { ...body.context, account: 'alpha' } } };
      });
      fake.route('GET', '/api/vocab', () => dashboardPagesCase('profile_reads.vocab_ok'));
      fake.route('GET', '/api/run-templates', () =>
        dashboardPagesCase(
          'collection_first_policy.read_the_run_templates_that_carry_the_default_gathering_policies',
        ),
      );
      options.before?.(fake);
    },
  });
  await page.advance(1_000);
  act(() => {
    page.data.commands.pickEditingTarget({
      epoch: page.data.store.getSnapshot().epoch,
      name: 'second',
    });
  });
  await page.advance(1_000);
  return page;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  window.location.hash = '';
  vi.useRealTimers();
});

it('PE4 policy commands use the editing target source, scope and runtime fence', async () => {
  const page = await openTarget();
  await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Offline');
  await page.user.click(page.view.getByRole('button', { name: /Save name/u }));
  await page.advance();
  expect(postBodies(page.fake, '/api/profile-patch')).toEqual([
    {
      ...(recorded('inactive_gather_label_saved').request.body as object),
      // Modified recorded request: this isolated journey starts before the plan save.
      expected_revision: (
        recorded('same_account_inactive_target_source').body as { revision: string }
      ).revision,
    },
  ]);
});

it('PE4 active settings retain their active heading and disable Save with a visible reason', async () => {
  const page = await openTarget();
  const rewards = required(document.querySelector<HTMLElement>('[data-module="rewards"]'));
  expect(within(rewards).getAllByRole('checkbox').length).toBeGreaterThan(0);
  expect(within(rewards).getAllByRole('checkbox')[0]).toBeDisabled();
  expect(within(rewards).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(
    page.view.getAllByText('Return editing to the active profile to change these').length,
  ).toBeGreaterThan(0);
  expect(page.view.getAllByText('Active profile:').length).toBeGreaterThan(0);
  expect(postBodies(page.fake, '/api/settings')).toEqual([]);
});

it('PE4 Save controls and outcomes name second beside the action', async () => {
  const page = await openTarget(sourceAfter('inactive_plan_saved_while_runner_listed'));
  await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Offline');
  await page.user.click(page.view.getByRole('button', { name: /Save name.*second/u }));
  page.fake
    .next('/api/profile-patch', 'POST')
    .respond(200, recorded('inactive_gather_label_saved').body);
  await page.advance(1_000);
  const outcome = required(page.view.container.querySelector('[data-collection-outcome]'));
  expect(outcome).toHaveTextContent('second');
  expect(outcome).toHaveTextContent('Saved');
});

it('PE4 an inactive target can save twice with no active profile or active settings/source reads', async () => {
  const page = await openTarget(
    sourceAfter('inactive_plan_saved_while_runner_listed'),
    '#collection',
    {
      before: (fake) => {
        fake.route('GET', '/api/config', () => recorded('read_after_unbind_account_context'));
        fake.route('GET', '/api/settings', () => 'hold');
      },
    },
  );
  await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Offline');
  await page.user.click(page.view.getByRole('button', { name: /Save name/u }));
  page.fake.route('GET', '/api/profile-src/second', () =>
    sourceAfter('inactive_gather_label_saved'),
  );
  // Modified recorded request: the runtime is explicitly unbound; the same named-target
  // patch receipt/readback proves a save without any active-source or settings read.
  page.fake
    .next('/api/profile-patch', 'POST')
    .respond(200, recorded('inactive_gather_label_saved').body);
  await page.advance(1_000);
  await page.user.clear(page.view.getByRole('textbox', { name: 'Name shown' }));
  await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Another label');
  const command = selectCollectionPage(page.data.store.getSnapshot(), null).editor?.saveLabel;
  expect(command?.reason).toBeNull();
  expect(command?.enabled).toBe(true);
  await page.user.click(page.view.getByRole('button', { name: /Save name/u }));
  await page.advance();
  expect(page.fake.writes()).toHaveLength(2);
});

const operations = [
  ['label', 'inactive_plan_saved_while_runner_listed', 'inactive_gather_label_saved'],
  ['copy', 'inactive_gather_label_saved', 'inactive_gather_copy_saved'],
  ['create', 'inactive_gather_copy_saved', 'inactive_gather_template_created'],
  ['delete', 'inactive_gather_template_created', 'inactive_unused_gather_deleted'],
  ['chores', 'inactive_unused_gather_deleted', 'inactive_chores_saved'],
] as const;

for (const [operation, before, saved] of operations) {
  it(`PE4 ${operation} sends exactly ${saved} once and reads second back`, async () => {
    const source = sourceAfter(before);
    if (operation === 'copy') {
      // Modified source: the recorded "copy" POST creates GATHER directly; no recorded
      // source holds that value. Put that recorded value in all_on to exercise copying.
      source.body.profile = structuredClone(source.body.profile);
      source.body.profile.policies.gather['all_on'] = (
        recorded(saved).request.body as { value: unknown }
      ).value;
    }
    const page = await openTarget(
      source,
      operation === 'delete' ? '#collection/policy/spare' : '#collection',
    );
    const vm = () => selectCollectionPage(page.data.store.getSnapshot(), null);
    const posted = recorded(saved);
    if (operation === 'label') {
      await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Offline');
      await page.user.click(page.view.getByRole('button', { name: /Save name/u }));
    } else if (operation === 'copy') {
      await page.user.type(page.view.getByRole('textbox', { name: 'New identifier' }), 'spare');
      await page.user.click(page.view.getByRole('button', { name: /Save copy/u }));
    } else if (operation === 'create') {
      await page.user.selectOptions(
        page.view.getByRole('combobox', { name: 'Template gathering default' }),
        JSON.stringify(['farm', 'all_on']),
      );
      await page.user.type(
        page.view.getByRole('textbox', { name: 'New policy identifier' }),
        'fresh',
      );
      await page.user.click(page.view.getByRole('button', { name: /Save policy/u }));
    } else if (operation === 'delete') {
      await page.user.click(page.view.getByRole('button', { name: /Delete this policy/u }));
      await page.user.click(page.view.getByRole('button', { name: 'Delete' }));
    } else {
      await page.user.click(page.view.getByRole('checkbox', { name: 'Quest scan' }));
      await page.user.click(page.view.getByRole('button', { name: /Save chores/u }));
    }
    await page.advance();
    expect(postBodies(page.fake, '/api/profile-patch')).toEqual([posted.request.body]);
    page.fake.route('GET', '/api/profile-src/second', () => sourceAfter(saved));
    page.fake.next('/api/profile-patch', 'POST').respond(posted.status, posted.body);
    await page.advance(2_000);
    expect(page.data.store.getSnapshot().context?.profile).toBe('mine');
    expect(vm().policies.find((row) => row.id === 'all_on')?.usedByKeys).toContain('farm');
    expect(postBodies(page.fake, '/api/settings')).toEqual([]);
    expect(page.fake.writes()).toHaveLength(1);
    if (operation === 'delete')
      expect(page.view.container.querySelector('[data-outcome="saved"]')).not.toBeNull();
  });
}

it('PE4 target switch and return restore only that target draft and revision; catalogue and axe', async () => {
  const page = await openTarget();
  const name = () => page.view.getByRole('textbox', { name: 'Name shown' });
  await page.user.type(name(), 'Offline');
  const scope = required(
    required(selectCollectionPage(page.data.store.getSnapshot(), null).editor).labelScope,
  );
  act(() => {
    page.data.commands.returnEditingToActive({ epoch: page.data.store.getSnapshot().epoch });
  });
  await page.advance(1_000);
  expect(name()).toHaveValue('');
  await page.user.type(name(), 'Active draft');
  act(() => {
    page.data.commands.pickEditingTarget({
      epoch: page.data.store.getSnapshot().epoch,
      name: 'second',
    });
  });
  await page.advance(1_000);
  expect(name()).toHaveValue('Offline');
  expect(page.data.store.getSnapshot().runDrafts[scope]?.['base_revision']).toBe(
    (recorded('same_account_inactive_target_source').body as Source).revision,
  );
  expect(page.fake.writes()).toEqual([]);
  expect(textOutsideCatalogue(page.view.container)).toEqual([]);
  vi.useRealTimers();
  expect(await axe(page.view.container)).toHaveNoViolations();
});

it('PE4 reload restores only the original target draft and starting revision', async () => {
  const source = sourceAfter('inactive_plan_saved_while_runner_listed');
  const page = await openTarget(source);
  await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Unsaved label');
  page.view.unmount();
  page.data.stop();
  const again = await openTarget(sourceAfter('inactive_gather_copy_saved'), '#collection', {
    storage: page.storage,
  });
  expect(again.view.getByRole('textbox', { name: 'Name shown' })).toHaveValue('Unsaved label');
  const command = required(
    selectCollectionPage(again.data.store.getSnapshot(), null).editor?.saveLabel.command,
  );
  expect(command.revision).toBe(source.body.revision);
  expect(command.profileName).toBe('second');
  expect(again.fake.writes()).toEqual([]);
});

it('PE4 inactive patch availability uses its source even without active rewards metadata', async () => {
  const page = await openTarget();
  const state = page.data.store.getSnapshot();
  const vm = selectCollectionPage(
    {
      ...state,
      reads: {
        ...state.reads,
        settings: { ...state.reads.settings, latest: null, lastAnswered: null },
      },
    },
    null,
  );
  expect(vm.rewards).toBeNull();
  expect(vm.editor?.remove.reason).toBe('policy_in_use');
  const scope = required(vm.editor?.labelScope);
  act(() => {
    page.data.commands.editDraft(scope, 'label', 'Offline');
  });
  const drafted = page.data.store.getSnapshot();
  const withNoSettings = selectCollectionPage(
    {
      ...drafted,
      reads: {
        ...drafted.reads,
        settings: { ...state.reads.settings, latest: null, lastAnswered: null },
      },
    },
    null,
  );
  expect(withNoSettings.editor?.saveLabel.command?.profileName).toBe('second');
});

for (const refusal of [
  'inactive_target_stale_revision',
  'inactive_target_deleted_before_patch',
  'inactive_target_write_failed',
] as const) {
  it(`PE4 ${refusal} keeps the draft and never retries`, async () => {
    const page = await openTarget();
    await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Offline');
    await page.user.click(page.view.getByRole('button', { name: /Save name/u }));
    const response = recorded(refusal);
    // Modified recorded response: the refusal/failed-write envelope is path independent;
    // the recorded producer requests plan, this journey requests a gathering label.
    page.fake.next('/api/profile-patch', 'POST').respond(response.status, response.body);
    await page.advance(10_000);
    expect(page.view.getByRole('textbox', { name: 'Name shown' })).toHaveValue('Offline');
    expect(page.fake.writes()).toHaveLength(1);
    expect(page.view.container.querySelector('[data-outcome]')).toHaveAttribute(
      'data-outcome',
      refusal.endsWith('write_failed') ? 'unknown' : 'refused',
    );
  });
}

it('PE4 lost inactive label stays Unknown on unchanged second; matching later target source alone settles it', async () => {
  const page = await openTarget(sourceAfter('inactive_plan_saved_while_runner_listed'));
  await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Offline');
  await page.user.click(page.view.getByRole('button', { name: /Save name/u }));
  page.fake.next('/api/profile-patch', 'POST').lose();
  await page.advance(2_000);
  expect(page.view.container.querySelector('[data-outcome]')).toHaveAttribute(
    'data-outcome',
    'unknown',
  );
  page.fake.route('GET', '/api/profile-src/second', () =>
    sourceAfter('inactive_gather_label_saved'),
  );
  page.data.commands.checkCollection();
  await page.advance(10_000);
  expect(page.view.container.querySelector('[data-outcome]')).toHaveAttribute(
    'data-outcome',
    'applied',
  );
  expect(page.fake.writes()).toHaveLength(1);
});

for (const change of ['context', 'generation', 'deleted'] as const) {
  it(`PE4 click-time ${change} change sends nothing and retains the draft`, async () => {
    const page = await openTarget();
    await page.user.type(page.view.getByRole('textbox', { name: 'Name shown' }), 'Offline');
    if (change === 'context')
      page.fake.route('GET', '/api/config', () =>
        recorded('read_config_after_editor_active_profile_switch'),
      );
    if (change === 'deleted')
      page.fake.route('GET', '/api/profile-files', () =>
        recorded('inactive_target_list_after_deletion'),
      );
    if (change === 'generation') page.fake.route('GET', '/api/profile-files', () => 'hold');
    await page.user.click(page.view.getByRole('button', { name: /Save name/u }));
    if (change === 'generation') {
      act(() => {
        page.data.commands.returnEditingToActive({ epoch: page.data.store.getSnapshot().epoch });
      });
      const held = page.fake.next('/api/profile-files', 'GET');
      held.respond(200, recorded('same_account_inactive_target_listed').body);
    }
    await page.advance();
    expect(page.fake.writes()).toEqual([]);
    expect(
      Object.values(page.data.store.getSnapshot().runDrafts).some(
        (draft) => draft['label'] === 'Offline',
      ),
    ).toBe(true);
    expect(page.view.container.querySelector('[data-not-sent]')).not.toBeNull();
  });
}
