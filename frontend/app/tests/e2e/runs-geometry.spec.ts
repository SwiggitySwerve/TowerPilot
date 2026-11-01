import { expect, test, type Page } from '@playwright/test';
import { own } from '../../src/core/read.ts';
import { shopCatalog } from '../../src/core/shoppingPlan.ts';
import { dashboardBody, dashboardPagesCase } from '../support/dashboardFixture.ts';

/**
 * Geometry of the Runs page on the built app and the fake backend: the shopping editor as a
 * queue column beside coloured chip grids with every upgrade of the catalogue visible, and the
 * list of every run. Text and box assertions only; the page is opened as a person would.
 */
const CATALOG = shopCatalog(
  own(dashboardPagesCase('shopping_queue.shopping_read_before_any_save').body, 'catalog'),
);
const SECTIONS = ['attack', 'defense', 'utility'] as const;

const SCENARIOS = [
  { name: 'desktop 1360', width: 1360, minColumns: 3, beside: true },
  { name: 'tablet 1054', width: 1054, minColumns: 2, beside: true },
  { name: 'phone 390', width: 390, minColumns: 1, beside: false },
] as const;

async function openSaved(page: Page, width: number, routes: (page: Page) => Promise<void>) {
  await page.setViewportSize({ width, height: 900 });
  await routes(page);
  await page.goto('/__fake/use?scenario=shopping_saved_edit');
  await page.evaluate(() => {
    window.location.hash = '#runs/saved/farm';
  });
  await expect(page.locator('[data-shopping-saved] .tp-shop__page .tp-chip-grid')).toHaveCount(3);
}

async function nothing() {
  // The default fake backend serves the shopping scenario's own runs.
}

for (const scenario of SCENARIOS) {
  test.describe(scenario.name, () => {
    test('the shopping editor has three coloured pages and every catalogue item is a visible chip', async ({
      page,
    }) => {
      await openSaved(page, scenario.width, nothing);
      expect(CATALOG).toHaveLength(48);
      const pages = page.locator('[data-shopping-saved] .tp-shop__page .tp-chip-grid');
      for (const [index, section] of SECTIONS.entries()) {
        const grid = pages.nth(index);
        const expected = CATALOG.filter((item) => item.section === section).map(
          (item) => item.label,
        );
        const shown = await grid.evaluate((list) =>
          [...list.querySelectorAll('.tp-toggle-chip')].map((chip) => ({
            name: chip.querySelector('.tp-toggle-chip__name')?.textContent ?? '',
            tone: chip.getAttribute('data-tone'),
            visible: chip.getClientRects().length > 0,
            right: chip.getBoundingClientRect().right,
          })),
        );
        expect(shown.map((chip) => chip.name)).toEqual(expected);
        for (const chip of shown) {
          expect(chip.tone, `${chip.name} tone`).toBe(section);
          expect(chip.visible, `${chip.name} is rendered`).toBe(true);
          expect(chip.right, `${chip.name} stays inside the page`).toBeLessThanOrEqual(
            scenario.width,
          );
        }
      }
      await expect(
        page.locator('[data-shopping-saved] .tp-shop__page .tp-toggle-chip'),
      ).toHaveCount(48);
    });

    test('chips share one box, on or off, and the grid lays out as many columns as fit', async ({
      page,
    }) => {
      await openSaved(page, scenario.width, nothing);
      const grids = await page
        .locator('[data-shopping-saved] .tp-shop__page .tp-chip-grid')
        .evaluateAll((lists) =>
          lists.map((list) => {
            const boxes = [...list.children].map((chip) => chip.getBoundingClientRect());
            const on = [...list.children].filter(
              (chip) => chip.getAttribute('data-on') === 'true',
            ).length;
            return {
              boxes: boxes.map((box) => ({ width: box.width, height: box.height, top: box.top })),
              on,
            };
          }),
        );
      // Damage and Health are in the saved queue: the check covers selected and plain chips.
      expect(grids.reduce((sum, grid) => sum + grid.on, 0)).toBe(2);
      for (const grid of grids) {
        const first = grid.boxes[0];
        expect(first).toBeDefined();
        for (const box of grid.boxes) {
          expect(Math.abs(box.width - (first?.width ?? 0))).toBeLessThanOrEqual(1);
          expect(Math.abs(box.height - (first?.height ?? 0))).toBeLessThanOrEqual(1);
        }
        const columns = grid.boxes.filter(
          (box) => Math.abs(box.top - (first?.top ?? 0)) < 1,
        ).length;
        if (scenario.minColumns === 1) expect(columns).toBe(1);
        else expect(columns).toBeGreaterThanOrEqual(scenario.minColumns);
      }
    });

    test('the queue sits left of the chip grids, or above them when narrow, with rows of one height', async ({
      page,
    }) => {
      await openSaved(page, scenario.width, nothing);
      const root = page.locator('[data-shopping-saved]');
      const queue = await root.locator('.tp-queue').boundingBox();
      const firstPage = await root.locator('.tp-shop__page .tp-chip-grid').first().boundingBox();
      expect(queue).not.toBeNull();
      expect(firstPage).not.toBeNull();
      if (scenario.beside) {
        expect((queue?.x ?? 0) + (queue?.width ?? 0)).toBeLessThanOrEqual(firstPage?.x ?? 0);
        // Side by side: the queue starts where the pages start, not below them.
        expect(Math.abs((queue?.y ?? 0) - (firstPage?.y ?? 0))).toBeLessThan(200);
      } else {
        expect((queue?.y ?? 0) + (queue?.height ?? 0)).toBeLessThanOrEqual(firstPage?.y ?? 0);
        expect(queue?.width ?? 0).toBeGreaterThan(scenario.width * 0.7);
      }
      const rows = await root
        .locator('.tp-queue__item')
        .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
      expect(rows).toHaveLength(2);
      expect(Math.abs((rows[0] ?? 0) - (rows[1] ?? 0))).toBeLessThanOrEqual(1);
      await expect(root.locator('.tp-queue__end')).toBeVisible();
    });

    test('nothing in the editor scrolls or folds: every chip is on the page', async ({ page }) => {
      await openSaved(page, scenario.width, nothing);
      const scrollers = await page.locator('[data-shopping-saved] .tp-shop').evaluate((editor) =>
        [...editor.querySelectorAll<HTMLElement>('*')]
          .filter((element) => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))
          .filter((element) => element.scrollHeight > element.clientHeight + 1)
          .map((element) => element.className),
      );
      expect(scrollers).toEqual([]);
      // The three pages are open on load; only the never-buy list and wave ranges fold.
      const folded = await page.locator('[data-shopping-saved] .tp-shop__page details').count();
      expect(folded).toBe(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
    });

    test('the runs list shows every run, never folded, with its kind, readiness and actions', async ({
      page,
    }) => {
      const body = dashboardBody('runs.ready') as {
        runs: Record<string, Record<string, unknown>>;
        readiness: Record<string, unknown>;
      };
      const base = body.runs['bp_farm'];
      const ready = body.readiness['bp_farm'];
      const runs: Record<string, unknown> = {};
      const readiness: Record<string, unknown> = {};
      for (let n = 1; n <= 12; n += 1) {
        runs[`bp_run_${String(n)}`] = { ...base, label: `Run ${String(n)}` };
        readiness[`bp_run_${String(n)}`] = ready;
      }
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await page.route('**/api/runs', (route) =>
        route.fulfill({ status: 200, json: { ...body, runs, readiness } }),
      );
      await page.goto('/__fake/use?scenario=shopping_saved_edit');
      await page.evaluate(() => {
        window.location.hash = '#runs';
      });
      const list = page.locator('[data-region="runsSaved"] [data-runs-list]');
      await expect(list.locator('.tp-record-row')).toHaveCount(12);
      await expect(list.locator('details')).toHaveCount(0);
      for (let n = 1; n <= 12; n += 1)
        await expect(
          list.getByRole('button', { name: `Edit Run ${String(n)}`, exact: true }),
        ).toBeVisible();
      await expect(list.getByText('Coin run').first()).toBeVisible();
      await expect(list.getByText('Ready').first()).toBeVisible();
      await list.getByRole('button', { name: 'Edit Run 7', exact: true }).click();
      await expect(list.locator('li', { hasText: 'Editing' })).toContainText('Run 7');
    });
  });
}
