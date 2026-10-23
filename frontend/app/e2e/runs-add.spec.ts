import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { bodiesTo, posts } from './helpers.ts';
import { dashboardPagesCase } from '../tests/support/dashboardFixture.ts';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT =
  process.env['TP_F6_SCREENS_DIR'] ??
  path.resolve('../../backend/logs/reviews/frontend-f6-screens');
mkdirSync(OUT, { recursive: true });

for (const width of [1360, 1054, 390]) {
  for (const state of ['coin', 'refused']) {
    test(`RL4 ${state} at ${String(width)}: one guarded add, axe, reflow, targets and screenshot`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        errors.push(error.message);
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/__fake/use?scenario=runs_add_${state}`);
      await page.evaluate(() => {
        window.location.hash = '#runs';
      });
      const form = page.locator('[data-run-add]');
      const disclosure = form.locator('summary[data-focus-key="run-add:open"]');
      await disclosure.focus();
      await page.keyboard.press('Enter');
      await expect(form.getByLabel('Recipe')).toHaveValue('farm');
      await form.getByLabel('Run identifier').fill('fenced_one');
      await form.getByLabel('New run label').fill('Fenced one');
      await form.getByRole('button', { name: 'Save new run' }).focus();
      await expect(form.getByRole('button', { name: 'Save new run' })).toBeFocused();
      await form.getByRole('button', { name: 'Save new run' }).dblclick();
      await expect(
        form.getByText(
          state === 'coin' ? 'New run saved.' : 'Run was not added. Your draft is kept.',
        ),
      ).toBeVisible();
      expect(await bodiesTo(page, '/api/run-templates/add')).toEqual([
        dashboardPagesCase('run_templates_add_fenced.added_with_the_matching_revision_and_context')
          .request.body,
      ]);
      if (state === 'refused') {
        await expect(form.getByLabel('Run identifier')).toHaveValue('fenced_one');
        await expect(
          form.locator('[data-run-add-outcome] [data-server-text="message"]'),
        ).toHaveText(
          'Saved profile changed. Reload and reconcile the pending edit before saving again.',
        );
      }
      await page.addScriptTag({ path: AXE });
      const violations = await page.evaluate(async () => {
        const scope = window as unknown as {
          axe: {
            run: (
              root: Document,
              options: unknown,
            ) => Promise<{ violations: readonly { id: string }[] }>;
          };
        };
        return (
          await scope.axe.run(document, {
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
            },
          })
        ).violations.map((item) => item.id);
      });
      expect(violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      const small = await form.locator('button, input, select, textarea, summary, a').evaluateAll(
        (elements, viewport) =>
          elements
            .filter((element) => element.getClientRects().length > 0)
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return (
                box.width < 24 ||
                box.height < (viewport === 390 && element.tagName === 'BUTTON' ? 44 : 24)
              );
            })
            .map((element) => element.outerHTML),
        width,
      );
      expect(small).toEqual([]);
      await form.screenshot({ path: path.join(OUT, `runs-add-${state}-${String(width)}.png`) });
      expect(
        (await posts(page)).filter((posted) => posted.path !== '/api/run-templates/add'),
      ).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
