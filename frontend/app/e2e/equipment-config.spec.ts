import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { posts } from './helpers.ts';
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  loadJsonWithIdentity,
} from '../scripts/contract-fixture.mjs';
import { list, own, ownPath } from '../src/core/read.ts';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT =
  process.env['TP_F6_SCREENS_DIR'] ??
  path.resolve('../../backend/logs/reviews/frontend-f6-screens');
mkdirSync(OUT, { recursive: true });
const cases = own(loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture, 'cases');
const body = (family: string, key: string) => ownPath(cases, family, key, 'body');
const tournamentModule = (
  list(own(body('settings_modules', 'read_after_saved_run_defaults'), 'modules')) ?? []
).find((module) => own(module, 'id') === 'tournament-cards');
const fieldLabel = (path: string) =>
  String(
    own(
      (list(own(tournamentModule, 'fields')) ?? []).find((field) => own(field, 'path') === path),
      'label',
    ),
  );
const tournament = (page: Page) => page.locator('[data-module="tournament-cards"]');
const save = (page: Page) => page.getByRole('button', { name: 'Save selection', exact: true });
async function open(page: Page, width: number, scenario: string, loadout = 'plain') {
  if (page.url().startsWith('http'))
    await page.evaluate(() => {
      sessionStorage.clear();
    });
  await page.goto('about:blank');
  await page.setViewportSize({ width, height: 900 });
  await page.request.get(`/__fake/use?scenario=config_fields_equipment_${scenario}`);
  await page.goto('/ui/app/#equipment');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Equipment', exact: true }),
  ).toBeVisible();
  if (!['lists', 'invalid', 'stale', 'empty'].includes(scenario))
    await page.getByRole('button', { name: loadout, exact: true }).click();
}
async function add(page: Page, field: string, values: string[]) {
  const root = tournament(page).locator(`[data-field="${field}"]`);
  for (const value of values) {
    await root.getByRole('button', { name: /^Add entry/ }).focus();
    await page.keyboard.press('Enter');
    const input = root.getByRole('textbox').last();
    await input.focus();
    await page.keyboard.type(value);
  }
}
async function clearLists(page: Page) {
  // The recorded alpha account already has unsupported saved names. Remove them
  // explicitly before entering the exact recorded replacement request.
  for (const field of ['drop', 'add']) {
    const root = tournament(page).locator(`[data-field="${field}"]`);
    await expect(root.getByRole('button', { name: /^Add entry/ })).toBeVisible();
    while (await root.getByRole('button', { name: /^Remove entry/ }).count()) {
      await root
        .getByRole('button', { name: /^Remove entry/ })
        .first()
        .focus();
      await page.keyboard.press('Enter');
    }
  }
}
async function lists(page: Page) {
  await clearLists(page);
  await add(page, 'drop', ['cash', 'extra_orb']);
  await add(page, 'add', ['golden_orb']);
}
async function screenshot(page: Page, width: number, state: string) {
  await page.screenshot({
    path: path.join(OUT, `config-fields-equipment-${String(width)}-${state}.png`),
    fullPage: true,
  });
}
interface AxeResult {
  readonly violations: readonly { readonly id: string; readonly nodes: readonly unknown[] }[];
}
async function accessibility(page: Page, width: number) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const scope = window as unknown as {
      axe: { run: (root: Document, options: unknown) => Promise<AxeResult> };
    };
    const result = await scope.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return result.violations.map((v) => `${v.id} (${v.nodes.length})`);
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.locator('.tp-equipment').evaluate(
      (root, width) =>
        [...root.querySelectorAll('button, select, input, summary')]
          .filter((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              (r.width < 24 || r.height < (width === 390 && node.tagName === 'BUTTON' ? 44 : 24))
            );
          })
          .map((node) => node.outerHTML),
      width,
    ),
  ).toEqual([]);
}

for (const width of [1360, 1054, 390]) {
  test(`C15-6 C15-7 explicit empty lists save as arrays and read back empty at ${String(width)}`, async ({
    page,
  }) => {
    await open(page, width, 'empty');
    await clearLists(page);
    await tournament(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(tournament(page).getByText('Saved', { exact: true })).toBeVisible();
    const request: unknown = JSON.parse((await posts(page))[0]?.body ?? '');
    expect(own(request, 'values')).toEqual({ drop: [], add: [] });
    await page.getByRole('button', { name: 'Read tournament settings', exact: true }).click();
    await expect(tournament(page).getByRole('textbox')).toHaveCount(0);
    await accessibility(page, width);
    await screenshot(page, width, 'lists-empty');
  });
  test(`C15-6 C15-7 tournament lists save and read back in order at ${String(width)}`, async ({
    page,
  }) => {
    await open(page, width, 'lists');
    await expect(page.getByText('Account:', { exact: true })).toBeVisible();
    await lists(page);
    const button = tournament(page).getByRole('button', { name: 'Save', exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(tournament(page).getByText('Saved', { exact: true })).toBeVisible();
    expect(JSON.parse((await posts(page))[0]?.body ?? '')).toEqual(
      ownPath(cases, 'settings_modules', 'saved_tournament_cards', 'request', 'body'),
    );
    await page.getByRole('button', { name: 'Read tournament settings', exact: true }).click();
    await expect(
      tournament(page).getByRole('textbox', { name: `${fieldLabel('drop')} Entry 2`, exact: true }),
    ).toHaveValue('extra_orb');
    expect(await posts(page)).toHaveLength(1);
    await accessibility(page, width);
    await screenshot(page, width, 'lists-saved');
  });
  test(`C15-6 C15-7 invalid list refusal keeps raw entries and server error at ${String(width)}`, async ({
    page,
  }) => {
    await open(page, width, 'invalid');
    await lists(page);
    await tournament(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      tournament(page).getByText(
        String(own(body('settings_modules', 'invalid_string_list_tournament_cards'), 'error')),
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      tournament(page).getByRole('textbox', { name: `${fieldLabel('add')} Entry 1`, exact: true }),
    ).toHaveValue('golden_orb');
    expect(await posts(page)).toHaveLength(1);
    await accessibility(page, width);
    await screenshot(page, width, 'lists-invalid');
  });
  test(`C15-6 C15-7 stale refusal retains ordered draft at ${String(width)}`, async ({ page }) => {
    await open(page, width, 'stale');
    await lists(page);
    await tournament(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      tournament(page).getByText(
        String(own(body('settings_modules', 'stale_revision_tournament_cards'), 'error')),
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      tournament(page).getByRole('textbox', { name: `${fieldLabel('drop')} Entry 1`, exact: true }),
    ).toHaveValue('cash');
    await screenshot(page, width, 'lists-stale');
  });
  test(`C15-8 restore cards save and readback at ${String(width)}`, async ({ page }) => {
    await open(page, width, 'cards');
    await page.getByRole('combobox', { name: 'Cards', exact: true }).selectOption('main_farm');
    await page
      .getByRole('combobox', { name: 'Restore cards preset', exact: true })
      .selectOption('no_card');
    await save(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Selection saved in configuration/)).toBeVisible();
    expect(JSON.parse((await posts(page))[0]?.body ?? '')).toEqual(
      ownPath(cases, 'loadout_restore', 'saved_cards_restore', 'request', 'body'),
    );
    await page.getByRole('button', { name: 'Read saved result', exact: true }).click();
    await expect(page.getByText(/saved read contains the submitted selection/)).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Restore cards preset', exact: true }),
    ).toHaveValue('no_card');
    await accessibility(page, width);
    await screenshot(page, width, 'cards-saved');
  });
  test(`C15-9 restore modules preserve manual fields and show warnings at ${String(width)}`, async ({
    page,
  }) => {
    await open(page, width, 'modules');
    await page.getByRole('button', { name: 'Add restore module', exact: true }).focus();
    await page.keyboard.press('Enter');
    const row = page.locator('.tp-equipment__restore-row');
    await row.getByRole('textbox', { name: /Module name/ }).fill('black_hole_digestor');
    await row.getByRole('textbox', { name: /Slot/ }).fill('assist');
    await save(page).click();
    await expect(page.getByText(/Selection saved in configuration/)).toBeVisible();
    expect(JSON.parse((await posts(page))[0]?.body ?? '')).toEqual(
      ownPath(cases, 'loadout_restore', 'saved_modules_restore', 'request', 'body'),
    );
    await page.getByRole('button', { name: 'Read saved result', exact: true }).click();
    await expect(page.getByText(/saved read contains the submitted selection/)).toBeVisible();
    await accessibility(page, width);
    await screenshot(page, width, 'modules-saved');
  });
  test(`C15-9 restore refused verbatim without losing the raw module at ${String(width)}`, async ({
    page,
  }) => {
    await open(page, width, 'refused');
    await page.getByRole('textbox', { name: /Module name/ }).fill('ghost_module');
    await save(page).click();
    await expect(page.getByRole('textbox', { name: /Module name/ })).toHaveValue('ghost_module');
    await expect(
      page
        .getByText(String(own(body('loadout_restore', 'refused_modules_restore'), 'error')), {
          exact: true,
        })
        .first(),
    ).toBeVisible();
    expect(JSON.parse((await posts(page))[0]?.body ?? '')).toEqual(
      ownPath(cases, 'loadout_restore', 'refused_modules_restore', 'request', 'body'),
    );
    await accessibility(page, width);
    await screenshot(page, width, 'restore-refused');
  });
  test(`C15-8 C15-9 unused loadout and clearing restore are disabled with a reason at ${String(width)}`, async ({
    page,
  }) => {
    for (const scenario of ['unused', 'clear_unused']) {
      await open(page, width, scenario, 'spare');
      await page
        .getByRole('combobox', { name: 'Restore cards preset', exact: true })
        .selectOption(scenario === 'unused' ? 'main_farm' : '');
      await expect(save(page), await page.locator('main').innerText()).toBeDisabled();
      await expect(
        page
          .getByText(
            'Restore changes cannot be saved: use this loadout in a run of the active profile first.',
            { exact: true },
          )
          .first(),
      ).toBeVisible();
      await save(page).focus();
      await page.keyboard.press('Enter');
      expect(await posts(page)).toHaveLength(0);
      await accessibility(page, width);
      await screenshot(
        page,
        width,
        scenario === 'unused' ? 'unused-disabled' : 'clear-unused-disabled',
      );
    }
  });
  test(`C15-8 no active profile keeps restore save disabled at ${String(width)}`, async ({
    page,
  }) => {
    await open(page, width, 'no_profile');
    await expect(save(page)).toBeDisabled();
    await expect(
      page.getByText(
        'Restore changes cannot be saved: activate a profile that uses this loadout first.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(await posts(page)).toHaveLength(0);
    await accessibility(page, width);
    await screenshot(page, width, 'no-profile-disabled');
  });
}
