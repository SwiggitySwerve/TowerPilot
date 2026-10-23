import { fillBoundsDraft, expectBoundsDraft } from './shopping-bounds.ts';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { bodiesTo, posts } from './helpers.ts';
import { dashboardPagesCase } from '../tests/support/dashboardFixture.ts';
import { bounds } from '../tests/support/shoppingBounds.ts';
import { own } from '../src/core/read.ts';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT = process.env['TP_F6_SCREENS_DIR'] ?? path.resolve('test-results', 'f6-screens');
mkdirSync(OUT, { recursive: true });
const root = (page: Page) => page.locator('[data-shopping-saved]');
const row = (page: Page, id: string) => root(page).locator(`.tp-shop__entry[data-upgrade="${id}"]`);
const sample = (name: string) => dashboardPagesCase(`shopping_queue.${name}`);
interface AxeResult {
  readonly violations: readonly { readonly id: string }[];
}
declare global {
  interface Window {
    axe: { run: (root: Document, options: unknown) => Promise<AxeResult> };
  }
}

async function open(page: Page, scenario: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/__fake/use?scenario=shopping_saved_${scenario}`);
  await page.evaluate(() => {
    window.location.hash = '#runs/saved/farm';
  });
  await expect(root(page)).toBeVisible();
}
async function check(page: Page, width: number, state: string) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    return (
      await window.axe.run(document, {
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
  expect(
    await root(page).evaluate(
      (box, mobile) =>
        [...box.querySelectorAll<HTMLElement>('button,input,select,a')]
          .filter((element) => element.getClientRects().length > 0)
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width < 24 || rect.height < (mobile && element.tagName === 'BUTTON' ? 44 : 24)
            );
          })
          .map((element) => element.outerHTML),
      width === 390,
    ),
  ).toEqual([]);
  await root(page).screenshot({ path: path.join(OUT, `shopping-saved-${state}-${width}.png`) });
}
async function fill(input: Locator, value: string) {
  await input.fill(value);
}
async function weighted(page: Page) {
  await fill(root(page).getByRole('textbox', { name: 'Cash reserve', exact: true }), '750.5');
  await root(page).getByLabel('Purchase pattern', { exact: true }).selectOption('weighted_split');
  await root(page).getByLabel('Cadence', { exact: true }).selectOption('while_affordable');
  await fill(row(page, 'damage').getByLabel('Tap attempts this battle', { exact: true }), '');
  await fill(row(page, 'health').getByLabel('Weight', { exact: true }), '3');
  await fill(row(page, 'health').getByLabel('Until wave (exclusive)', { exact: true }), '20');
  const up = row(page, 'health').getByRole('button', { name: /^Move up/u });
  await up.focus();
  await page.keyboard.press('Enter');
  await expect(up).toBeFocused();
  await expect(root(page).locator('.tp-shop__entry').first()).toHaveAttribute(
    'data-upgrade',
    'health',
  );
}
for (const width of [1360, 1054, 390]) {
  test(`SQ1 create queue at ${width}: choices, one exact Save, axe and targets`, async ({
    page,
  }) => {
    await open(page, 'create', width);
    await root(page).getByRole('button', { name: 'Create a queue', exact: true }).click();
    const save = root(page).getByRole('button', { name: 'Save queue', exact: true });
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(await posts(page)).toHaveLength(0);
    await fill(root(page).getByLabel('Cash reserve', { exact: true }), '0');
    await root(page)
      .getByLabel('Purchase pattern', { exact: true })
      .selectOption('highest_affordable');
    await root(page).getByLabel('Cadence', { exact: true }).selectOption('single_attempt');
    await save.click();
    await expect(page.locator('[data-region="runsSaved"] [data-outcome="saved"]')).toBeVisible();
    expect(await bodiesTo(page, '/api/run-controls')).toEqual([
      sample('shopping_empty_queue_saved').request.body,
    ]);
    await check(page, width, 'created');
  });
  test(`SQ2 legacy review and explicit saved conversion at ${width}`, async ({ page }) => {
    await open(page, 'conversion', width);
    const initial = sample('shopping_legacy_list_preview');
    for (const warning of own(own(initial.body, 'legacy_conversion'), 'warnings') as string[])
      await expect(root(page).getByText(warning, { exact: true })).toBeVisible();
    await expect(root(page).locator('[data-conversion-entry]')).toHaveCount(2);
    await expect(root(page).locator('[data-conversion-entry="damage"]')).toContainText('Damage');
    await expect(root(page).locator('[data-conversion-entry="health"]')).toContainText('Unlimited');
    await expect(root(page).getByText('Defense Absolute', { exact: true })).toBeVisible();
    expect(await posts(page)).toHaveLength(0);
    await check(page, width, 'conversion-review');
    // F6-12-C-02: the unset recorded reserve blocks Use reviewed queue until one is typed.
    const use = root(page).getByRole('button', { name: 'Use reviewed queue', exact: true });
    await expect(use).toHaveAttribute('aria-disabled', 'true');
    await expect(
      root(page).getByText('Enter a cash reserve first (0 allows spending all cash).', {
        exact: true,
      }),
    ).toBeVisible();
    // An aria-disabled button stays focusable; a forced click on it stages nothing.
    await use.click({ force: true });
    await expect(root(page).locator('[data-shopping-conversion]')).toBeVisible();
    await fill(root(page).getByLabel('Cash reserve', { exact: true }), '0');
    await use.click();
    expect(await posts(page)).toHaveLength(0);
    await expect(root(page).getByLabel('Cash reserve', { exact: true })).toHaveValue('0');
    await root(page).getByRole('button', { name: 'Save queue', exact: true }).click();
    await expect(page.locator('[data-region="runsSaved"] [data-outcome="saved"]')).toBeVisible();
    expect(await bodiesTo(page, '/api/run-controls')).toEqual([
      sample('shopping_reviewed_conversion_saved').request.body,
    ]);
    await check(page, width, 'converted');
  });
  test(`SQ3 SQ5 SQ6 SQ7 edit and keyboard reorder at ${width}: exact plan, private run save`, async ({
    page,
  }) => {
    await open(page, 'edit', width);
    // F6-12-C-05: the saved queue folds and unfolds from the keyboard.
    const summary = root(page).locator('details.tp-saved-shopping__details > summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(root(page).getByRole('button', { name: 'Save queue', exact: true })).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(root(page).getByRole('button', { name: 'Save queue', exact: true })).toBeVisible();
    await weighted(page);
    await check(page, width, 'edited');
    await root(page).getByRole('button', { name: 'Save queue', exact: true }).click();
    await expect(page.locator('[data-region="runsSaved"] [data-outcome="saved"]')).toBeVisible();
    expect(await bodiesTo(page, '/api/run-controls')).toEqual([
      sample('shopping_weighted_cadence_order_saved').request.body,
    ]);
    await check(page, width, 'saved');
    // A run-specific GET uses the recorded untouched other run, independent of farm's write.
    await page.evaluate(() => {
      window.location.hash = '#runs/saved/other';
    });
    await expect(root(page).getByLabel('Cash reserve', { exact: true })).toHaveValue('500');
    expect(await posts(page)).toHaveLength(1);
  });
  test(`SQ12 Unknown at ${width}: no resend, later matching read settles`, async ({ page }) => {
    await open(page, 'unknown', width);
    await weighted(page);
    await root(page).getByRole('button', { name: 'Save queue', exact: true }).click();
    await expect(
      page.locator('[data-region="runsSaved"] [data-outcome="unconfirmed_save"]'),
    ).toBeVisible();
    await expect(
      root(page).getByRole('button', { name: 'Save queue', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(await bodiesTo(page, '/api/run-controls')).toEqual([
      sample('shopping_save_reply_failed').request.body,
    ]);
    await check(page, width, 'unknown');
    await page.request.get('/__fake/set?scenario=shopping_saved_unknown_read');
    await page.getByRole('button', { name: 'Check saved values', exact: true }).click();
    await expect(page.locator('[data-region="runsSaved"] [data-outcome="applied"]')).toBeVisible();
    expect(await posts(page)).toHaveLength(1);
    await check(page, width, 'settled');
  });
  for (const name of [
    'saved_weight_above_100_refused',
    'saved_weight_zero_refused',
    'saved_wave_range_reversed_refused',
    'saved_boundary_values_accepted',
  ]) {
    test(`SQ5 ${name} at ${width}: exact body, visible server reason, retained draft or boundary readback, axe and targets`, async ({
      page,
    }) => {
      let source = bounds('read_before_the_refusals');
      const answer = bounds(name);
      await page.route('**/api/run-controls?*', (route) =>
        route.fulfill({ status: source.status, json: source.body }),
      );
      await page.route('**/api/run-controls', async (route) => {
        await route.fetch();
        await route.fulfill({ status: answer.status, json: answer.body });
      });
      await open(page, 'refused', width);
      await fillBoundsDraft(root(page), name);
      await root(page).getByRole('button', { name: 'Save queue', exact: true }).click();
      if (answer.status === 400) {
        const refusal = root(page).locator('[data-queue-refusal] [data-server-text="message"]');
        await expect(refusal).toBeVisible();
        await expect(refusal).toHaveText(String(own(answer.body, 'error')));
        await expect(page.locator('[data-outcome="saved"]')).toHaveCount(0);
        source = bounds('read_after_the_refusals_nothing_changed');
      } else source = bounds('read_after_the_boundary_values_were_saved');
      await page.getByRole('button', { name: 'Check saved values', exact: true }).click();
      if (answer.status === 400) {
        await expect(page.locator('[data-outcome="not_saved"]')).toBeVisible();
        await expectBoundsDraft(root(page), name);
      } else await expect(page.locator('[data-outcome="saved"]')).toBeVisible();
      expect(await bodiesTo(page, '/api/run-controls')).toEqual([answer.request.body]);
      await check(page, width, `bounds-${name}`);
    });
  }
}
