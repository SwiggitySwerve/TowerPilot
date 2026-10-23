import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bodiesTo, posts } from './helpers.ts';
import { dashboardPagesCase } from '../tests/support/dashboardFixture.ts';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT = process.env['TP_F6_SCREENS_DIR'] ?? path.resolve('test-results/f6-screens');
mkdirSync(OUT, { recursive: true });
const sample = (name: string) => dashboardPagesCase(`profile_target.${name}`);
const editor = (page: Page) => page.locator('[data-run-entry]');
const field = (page: Page, key: string) => editor(page).locator(`[data-entry-field="${key}"]`);

async function open(page: Page, scenario: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/__fake/use?scenario=${scenario}`);
  await page.evaluate(() => {
    window.location.hash = '#profiles';
  });
  const picker = page.locator('[data-form="editing-target"]');
  await picker.getByRole('combobox').selectOption('second');
  await picker.getByRole('button', { name: 'Edit this profile', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(picker.locator('[data-editing-target="second"]')).toHaveAttribute(
    'data-target-blocked',
    '',
  );
  expect(await posts(page)).toEqual([]);
  await page.evaluate(() => {
    window.location.hash = '#runs/saved/farm';
  });
  await expect(field(page, 'label').getByLabel('Run label', { exact: true })).toHaveValue(
    'Second farm',
  );
  await expect(editor(page).locator('[data-editing-target="second"]')).toContainText(
    'Active profile:mine',
  );
}

async function proof(page: Page, state: string, width: number) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const scope = window as unknown as {
      axe: { run: (root: Document, options: unknown) => Promise<{ violations: { id: string }[] }> };
    };
    return (
      await scope.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      })
    ).violations.map((item) => item.id);
  });
  expect(violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);
  const small = await page
    .locator('main button, main input, main select, main textarea, main summary')
    .evaluateAll(
      (elements, mobile) =>
        elements
          .filter((element) => element.getClientRects().length > 0)
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width < 24 || rect.height < (mobile && element.tagName === 'BUTTON' ? 44 : 24)
            );
          })
          .map((element) => element.outerHTML.slice(0, 150)),
      width === 390,
    );
  expect(small).toEqual([]);
  await page.screenshot({
    path: path.join(OUT, `profile-target-runs-${state}-${width}.png`),
    fullPage: true,
  });
}

for (const width of [1360, 1054, 390]) {
  test(`PE6 target label/loadout exact bodies, active-only forms, return, keyboard and axe at ${width}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await open(page, 'profile_target_runs_saved', width);
    const sections = page.locator('[data-runs-active-only]');
    expect(await sections.count()).toBeGreaterThanOrEqual(3);
    for (const section of await sections.all()) {
      await expect(section).toHaveAttribute('disabled', '');
      await expect(section).toContainText('Active profile:mine');
      await expect(section).toContainText('Return editing to the active profile to change these');
      for (const button of await section.getByRole('button').all())
        await expect(button).toBeDisabled();
    }
    await proof(page, 'picked', width);
    const label = field(page, 'label');
    await label.getByLabel('Run label', { exact: true }).fill('Offline farm');
    await label.getByRole('button', { name: 'Save field', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(label.locator('[data-outcome="saved"]')).toBeVisible();
    await expect(label.getByRole('button', { name: 'Save field', exact: true })).toBeFocused();
    const loadout = field(page, 'loadout');
    await loadout.getByLabel('Run equipment', { exact: true }).selectOption('plain');
    await loadout.getByRole('button', { name: 'Save field', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(loadout.locator('[data-outcome="saved"]')).toBeVisible();
    expect(await bodiesTo(page, '/api/profile-patch')).toEqual([
      sample('inactive_run_entry_label_saved').request.body,
      sample('inactive_run_entry_loadout_saved').request.body,
    ]);
    await expect(label.getByLabel('Run label', { exact: true })).toHaveValue('Offline farm');
    await expect(loadout.getByLabel('Run equipment', { exact: true })).toHaveValue('plain');
    await proof(page, 'saved', width);
    await editor(page)
      .getByRole('link', { name: 'Change the editing profile in Profiles' })
      .click();
    await page
      .locator('[data-form="editing-target"]')
      .getByRole('button', { name: 'Return editing to the active profile', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      window.location.hash = '#runs/saved/farm';
    });
    await expect(editor(page).locator('[data-editing-target="mine"]')).toContainText(
      'Editing the active profile:mine',
    );
    await expect(field(page, 'label').getByLabel('Run label', { exact: true })).toHaveValue('');
    await expect(page.locator('[data-runs-active-only][disabled]')).toHaveCount(0);
    expect(await posts(page)).toHaveLength(2);
    await proof(page, 'returned', width);
    expect(errors).toEqual([]);
  });

  test(`PE6 changed click-time context sends nothing and keeps second draft at ${width}`, async ({
    page,
  }) => {
    await open(page, 'profile_target_runs_context_changed', width);
    await field(page, 'label')
      .getByLabel('Run label', { exact: true })
      .fill('Keep this second draft');
    // Inject only the genuinely recorded config answer after drawing, without changing
    // the app's runtime epoch first; this exercises the click-time guard itself.
    const changed = sample('read_config_after_editor_active_profile_switch');
    await page.route('**/api/config', (route) =>
      route.fulfill({ status: changed.status, json: changed.body }),
    );
    await field(page, 'label').getByRole('button', { name: 'Save field', exact: true }).click();
    await expect(editor(page).getByRole('status')).toContainText('Nothing sent');
    await expect(field(page, 'label').getByLabel('Run label', { exact: true })).toHaveValue(
      'Keep this second draft',
    );
    expect(await posts(page)).toEqual([]);
    await proof(page, 'context-changed', width);
  });
}
