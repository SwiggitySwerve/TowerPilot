import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { own, ownPath } from '../src/core/read.ts';
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  loadJsonWithIdentity,
} from '../scripts/contract-fixture.mjs';
import { bodiesTo, posts } from './helpers.ts';

const cases = own(loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture, 'cases');
const body = (name: string) => ownPath(cases, 'profile_target', name, 'request', 'body');
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT =
  process.env['TP_F6_SCREENS_DIR'] ??
  path.resolve('../../backend/logs/reviews/frontend-f6-screens');
mkdirSync(OUT, { recursive: true });

async function route(page: Page, hash: string) {
  await page.evaluate((hash) => {
    location.hash = hash;
  }, hash);
}
async function open(page: Page, width: number) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/__fake/use?scenario=profile_target_abilities_uw');
  await route(page, '#abilities');
  await expect(page.getByRole('textbox', { name: 'Plan label', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Plan label', exact: true }).fill('Mine retained draft');
  await route(page, '#profiles');
  const picker = page.locator('[data-form="editing-target"]');
  await picker.getByRole('combobox').selectOption('second');
  await picker.getByRole('button', { name: 'Edit this profile', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(picker).toContainText('Editing:second(not the active profile)');
  await route(page, '#abilities');
  await expect(page.locator('main [data-editing-target="second"]')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Plan label', exact: true })).toHaveValue(
    'Farm choreography',
  );
  await expect(
    page.getByRole('button', { name: 'Global Demon Mode timing', exact: true }),
  ).toBeDisabled();
  await expect(page.getByTestId('abilities-active-only')).toContainText('Active profile:mine');
  await expect(
    page.getByText('Return editing to the active profile to change these', { exact: true }),
  ).toBeVisible();
  expect(await posts(page)).toEqual([]);
  return errors;
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
    ).violations.map((violation) => violation.id);
  });
  expect(violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.locator('main button, main input, main select, main summary').evaluateAll((all) =>
      all
        .filter((element) => element.getClientRects().length > 0)
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width < 24 || box.height < 24;
        })
        .map((element) => element.outerHTML.slice(0, 120)),
    ),
  ).toEqual([]);
  if (width === 390) {
    expect(
      await page
        .locator('main button')
        .evaluateAll((all) =>
          all
            .filter(
              (element) =>
                element.getClientRects().length > 0 && element.getBoundingClientRect().height < 44,
            )
            .map((element) => element.textContent),
        ),
    ).toEqual([]);
  }
  await page.screenshot({
    path: path.join(OUT, `profile-target-abilities-${state}-${width}.png`),
    fullPage: true,
  });
}
const save = (page: Page) => page.getByRole('button', { name: 'Save plan', exact: true });
const read = (page: Page) => page.getByRole('button', { name: 'Read saved result', exact: true });

for (const width of [1360, 1054, 390]) {
  test(`PE5 pick second, save exact UW/rescue bodies, active-only Demon Mode and restore mine draft at ${width}`, async ({
    page,
  }) => {
    const errors = await open(page, width);
    await proof(page, 'picked', width);
    await page.getByRole('textbox', { name: 'New plan ID', exact: true }).fill('calm');
    await page.getByRole('button', { name: 'Create draft', exact: true }).click();
    await page.getByRole('textbox', { name: 'Plan label', exact: true }).fill('Calm');
    const value = own(body('inactive_uw_policy_saved'), 'value');
    for (const [weapon, enabled] of Object.entries(
      own(value, 'baseline') as Record<string, boolean>,
    )) {
      await page
        .getByRole('combobox', { name: weapon.replaceAll('_', ' '), exact: true })
        .selectOption(String(enabled));
    }
    await save(page).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved in the profile.' }),
    ).toContainText('second');
    expect(await bodiesTo(page, '/api/profile-patch')).toEqual([body('inactive_uw_policy_saved')]);
    await proof(page, 'uw-saved', width);
    await page.request.get('/__fake/set?scenario=profile_target_abilities_rescue');
    await read(page).click();
    await expect(read(page)).toBeEnabled();
    await page
      .getByRole('combobox', { name: 'Saved plans', exact: true })
      .selectOption('rescue_policies');
    await page.getByRole('button', { name: 'any_falling', exact: true }).click();
    await page.getByRole('textbox', { name: 'New plan ID', exact: true }).fill('extra');
    await page.getByRole('button', { name: 'Copy selected to draft', exact: true }).click();
    await save(page).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved in the profile.' }),
    ).toContainText('second');
    expect(await bodiesTo(page, '/api/profile-patch')).toEqual([
      body('inactive_uw_policy_saved'),
      body('inactive_rescue_policy_saved'),
    ]);
    await proof(page, 'rescue-saved', width);
    await route(page, '#profiles');
    await page
      .locator('[data-form="editing-target"]')
      .getByRole('button', { name: 'Return editing to the active profile', exact: true })
      .click();
    await route(page, '#abilities');
    await expect(page.getByRole('textbox', { name: 'Plan label', exact: true })).toHaveValue(
      'Mine retained draft',
    );
    await expect(page.locator('main [data-editing-target="mine"]')).toBeVisible();
    await proof(page, 'returned', width);
    expect(await posts(page)).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test(`PE5 changed runtime after drawing sends nothing and keeps second draft at ${width}`, async ({
    page,
  }) => {
    const errors = await open(page, width);
    await page
      .getByRole('textbox', { name: 'Plan label', exact: true })
      .fill('Second draft retained');
    await page.request.get('/__fake/set?scenario=profile_target_abilities_context_changed');
    await save(page).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText(
        'The runtime context or editing target changed. Nothing was sent; the draft is kept.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(await posts(page)).toEqual([]);
    await expect(page.getByRole('textbox', { name: 'Plan label', exact: true })).toHaveValue(
      'Second draft retained',
    );
    await proof(page, 'context-changed', width);
    expect(errors).toEqual([]);
  });
}
