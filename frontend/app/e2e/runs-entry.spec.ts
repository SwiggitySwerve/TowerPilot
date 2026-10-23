import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bodiesTo, posts } from './helpers.ts';
import { own } from '../src/core/read.ts';
import { dashboardPagesCase } from '../tests/support/dashboardFixture.ts';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT = process.env['TP_F6_SCREENS_DIR'] ?? path.resolve('test-results', 'f6-screens');
mkdirSync(OUT, { recursive: true });
interface AxeResult {
  readonly violations: readonly { readonly id: string }[];
}
async function check(page: Page, width: number) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const scope = window as unknown as {
      axe: { run: (root: Document, options: unknown) => Promise<AxeResult> };
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
  expect(
    await page.locator('[data-run-entry]').evaluate(
      (root, mobile) =>
        [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,a')]
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
}
for (const width of [1360, 1054, 390]) {
  test(`RL3 RL6 saved entry at ${width}: one field, links, axe, reflow and targets`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__fake/use?scenario=runs_entry_saved');
    await page.evaluate(() => {
      window.location.hash = '#runs/saved/farm';
    });
    const editor = page.locator('[data-run-entry]');
    const row = editor.locator('[data-entry-field="label"]');
    await row.getByLabel('Run label', { exact: true }).fill('Daily coin farm');
    await row.getByRole('button', { name: 'Save field', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(row.locator('[data-outcome="saved"]')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Save field', exact: true })).toBeFocused();
    expect(await bodiesTo(page, '/api/profile-patch')).toEqual([
      dashboardPagesCase('run_entry_patch.saved_label').request.body,
    ]);
    await expect(editor.locator('[data-entry-field="policies.gather"] a')).toHaveAttribute(
      'href',
      '#collection/policy/gems_only',
    );
    await expect(editor.locator('[data-entry-field="policies.rescue"] a')).toHaveAttribute(
      'href',
      '#abilities',
    );
    await check(page, width);
    await editor.screenshot({ path: path.join(OUT, `runs-entry-saved-${width}.png`) });
    await editor.locator('[data-entry-field="policies.gather"] a').click();
    await expect(page).toHaveURL(/#collection\/policy\/gems_only$/u);
    await expect(page.getByRole('heading', { level: 1, name: 'Collection' })).toBeVisible();
    expect(await posts(page)).toHaveLength(1);
  });
  test(`RL3 refusal at ${width}: draft, server text, axe and screenshot`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__fake/use?scenario=runs_entry_refused');
    await page.evaluate(() => {
      window.location.hash = '#runs/saved/farm';
    });
    const editor = page.locator('[data-run-entry]');
    const row = editor.locator('[data-entry-field="tier"]');
    await row.getByLabel('Run tier', { exact: true }).fill('3');
    await row.getByRole('button', { name: 'Save field', exact: true }).click();
    await expect(row.locator('[data-outcome="refused"]')).toBeVisible();
    await expect(row.getByLabel('Run tier', { exact: true })).toHaveValue('3');
    await expect(row.locator('[data-refusal]')).toHaveText(
      String(own(dashboardPagesCase('run_entry_patch.unknown_profile_404').body, 'error')),
    );
    await check(page, width);
    await editor.screenshot({ path: path.join(OUT, `runs-entry-refused-${width}.png`) });
    expect(await posts(page)).toHaveLength(1);
  });
}
