import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { undersizedControlTargets } from './helpers/target-box.ts';

/**
 * Geometry of the item primitives on the built gallery (`#gallery`): equal chip boxes,
 * grid columns, 24 px desktop and 44 px touch targets, no horizontal overflow. Text
 * assertions only; set GALLERY_CAPTURE_DIR to also write local screenshots for review
 * (they are never committed: *.png is ignored).
 */
async function openGallery(page: Page) {
  await page.goto('/ui/app/#gallery');
  await expect(page.getByRole('heading', { level: 1, name: 'Item gallery' })).toBeVisible();
}

const SCENARIOS = [
  { name: 'desktop 1360', width: 1360, touch: false, minimum: 24, columns: 5 },
  { name: 'tablet 1054', width: 1054, touch: false, minimum: 24, columns: 3 },
  { name: 'phone 390', width: 390, touch: false, minimum: 44, columns: 1 },
  { name: 'touch desktop 1360', width: 1360, touch: true, minimum: 44, columns: 5 },
] as const;

for (const scenario of SCENARIOS) {
  test.describe(scenario.name, () => {
    test.use({ viewport: { width: scenario.width, height: 900 }, hasTouch: scenario.touch });

    test('every chip of a grid has the same box, whether on or off, within 1 px', async ({
      page,
    }) => {
      await openGallery(page);
      const boxes = await page.locator('.tp-chip-grid[data-size="toggle"]').evaluateAll((grids) =>
        grids.map((grid) =>
          [...grid.children].map((chip) => {
            const box = chip.getBoundingClientRect();
            return { width: box.width, height: box.height };
          }),
        ),
      );
      expect(boxes.length).toBeGreaterThanOrEqual(5);
      for (const grid of boxes) {
        const first = grid[0];
        expect(first).toBeDefined();
        for (const box of grid) {
          expect(Math.abs(box.width - (first?.width ?? 0))).toBeLessThanOrEqual(1);
          expect(Math.abs(box.height - (first?.height ?? 0))).toBeLessThanOrEqual(1);
        }
      }
    });

    test('the 48-item grid lays out the expected columns and renders every item', async ({
      page,
    }) => {
      await openGallery(page);
      const grid = page.getByRole('list', { name: '48 items' });
      await expect(grid.getByRole('button')).toHaveCount(48);
      const columns = await grid.evaluate((list) => {
        const tops = [...list.children].map((chip) => Math.round(chip.getBoundingClientRect().top));
        return tops.filter((top) => top === tops[0]).length;
      });
      expect(columns).toBe(scenario.columns);
      const narrow = await page
        .locator('[data-gallery="narrow"] .tp-chip-grid')
        .evaluate((list) => {
          const tops = [...list.children].map((chip) =>
            Math.round(chip.getBoundingClientRect().top),
          );
          return tops.filter((top) => top === tops[0]).length;
        });
      expect(narrow).toBe(1);
    });

    test('toggles, fields and queue buttons are operable targets', async ({ page }) => {
      await openGallery(page);
      expect(
        await undersizedControlTargets(page.locator('main'), {
          width: scenario.minimum,
          height: scenario.minimum,
        }),
      ).toEqual([]);
      const fields = await page.locator('.tp-chip-field, .tp-item-button').evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
      );
      expect(fields.length).toBeGreaterThanOrEqual(6);
      for (const box of fields) {
        expect(box.width).toBeGreaterThanOrEqual(scenario.minimum);
        expect(box.height).toBeGreaterThanOrEqual(scenario.minimum);
      }
    });

    test('nothing overflows horizontally, and a chip clips only its own long name', async ({
      page,
    }) => {
      await openGallery(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const overflowing = await page
        .locator('.tp-chip-grid, .tp-queue, .tp-toggle-chip, .tp-queue__item, .tp-mark-chip')
        .evaluateAll((elements) =>
          elements
            .filter((element) => element.scrollWidth > element.clientWidth)
            .map((element) => element.getAttribute('class') ?? ''),
        );
      expect(overflowing).toEqual([]);
    });

    test('Tab visits each chip, Space toggles it, and its fields appear beside the button', async ({
      page,
    }) => {
      await openGallery(page);
      const chip = page.getByRole('button', { name: 'Off', exact: true });
      await chip.focus();
      await expect(chip).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('Space');
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await expect(chip).toBeFocused();
      const siblings = await chip.evaluate((button) => button.parentElement?.children.length);
      expect(siblings).toBe(1);
    });

    test('Move down keeps focus on its button and the queue order changes', async ({ page }) => {
      await openGallery(page);
      const queue = page.getByRole('list', { name: 'Sample queue' });
      const first = queue.getByRole('button', { name: 'Move down Sample item 3' });
      await first.focus();
      await page.keyboard.press('Enter');
      await expect(first).toBeFocused();
      await expect(queue.locator('.tp-queue__name').first()).toHaveText('Sample item 1');
      await expect(page.getByRole('status')).toHaveText('Moved to position 2 of 3');
    });

    test('the gallery matches the reference geometry text report', async ({ page }) => {
      await openGallery(page);
      const dir = process.env['GALLERY_CAPTURE_DIR'];
      if (dir !== undefined) {
        const tag = scenario.name.replace(/ /g, '-');
        await page.screenshot({ path: path.join(dir, `gallery-${tag}.png`), fullPage: true });
        await page
          .locator('[data-region="galleryStates"]')
          .screenshot({ path: path.join(dir, `gallery-states-${tag}.png`) });
      }
      const report = await page
        .locator('[data-region="gallerySizes"] .tp-chip-grid')
        .evaluateAll((grids) =>
          grids.map((grid) => {
            const box = grid.firstElementChild?.getBoundingClientRect();
            return { items: grid.children.length, height: Math.round(box?.height ?? 0) };
          }),
        );
      expect(report.map((grid) => grid.items)).toEqual([3, 12, 48]);
      expect(new Set(report.map((grid) => grid.height)).size).toBe(1);
    });
  });
}
