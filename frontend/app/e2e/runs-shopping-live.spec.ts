import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { entries, own, ownPath } from '../src/core/read.ts';
import { dashboardPagesCase } from '../tests/support/dashboardFixture.ts';
import { bodiesTo, posts } from './helpers.ts';
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT = process.env['TP_F6_SCREENS_DIR'] ?? path.resolve('test-results', 'f6-screens');
mkdirSync(OUT, { recursive: true });
const sample = (name: string) => dashboardPagesCase(`shopping_queue.${name}`);
const record = (value: unknown) => Object.fromEntries(entries(value));
/** Undo admission for a pre-click read. Write receipts have no read envelope: reuse the recorded catalogue and runtime time, keeping their own battle identity. */
function before(name: string) {
  const body = sample(name).body;
  return {
    ...record(sample('shopping_upgrade_requested').body),
    ...record(body),
    server_time: ownPath(body, 'battle', 'runtime', 'server_time'),
    battle: {
      ...record(own(body, 'battle')),
      control_revision: 0,
      applied_revision: 0,
      overrides: {},
      applied_overrides: {},
      commands: [],
    },
  };
}
async function open(page: Page, scenario: string, width: number, runs = true) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/__fake/use?scenario=${scenario}`);
  if (runs)
    await page.evaluate(() => {
      location.hash = '#runs/live';
    });
  await expect(
    page.getByRole('heading', { level: 1, name: runs ? 'Runs' : 'Dashboard' }),
  ).toBeVisible();
}
async function check(page: Page, width: number, state: string) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const scope = window as unknown as {
      axe: { run: (root: Document, options: unknown) => Promise<{ violations: { id: string }[] }> };
    };
    return (
      await scope.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
      })
    ).violations.map((v) => v.id);
  });
  expect(violations).toEqual([]);
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    small: [
      ...document.querySelectorAll<HTMLElement>(
        'main button, main input, main select, main summary, main a',
      ),
    ]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.height < 24 || box.width < 24;
      })
      .map((el) => el.outerHTML.slice(0, 150)),
  }));
  expect(layout).toEqual({ overflow: 0, small: [] });
  if (width === 390)
    for (const button of await page
      .locator(
        '.tp-shopping-live button:visible, .tp-shopping-try button:visible, .tp-battle__queue-entry button:visible',
      )
      .all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
  await page.screenshot({
    path: path.join(OUT, `shopping-live-${state}-${String(width)}.png`),
    fullPage: true,
  });
}
async function edit(page: Page) {
  const editor = page.locator('.tp-shopping-live');
  await editor.getByRole('textbox', { name: 'Cash reserve', exact: true }).fill('750.5');
  await editor.getByLabel('Purchase pattern', { exact: true }).selectOption('weighted_split');
  await editor.getByLabel('Cadence', { exact: true }).selectOption('while_affordable');
  const health = editor.locator('.tp-shop__entry[data-upgrade="health"]');
  await health.getByRole('button', { name: /Move up/ }).click();
  await health.getByRole('textbox', { name: 'Weight', exact: true }).fill('3');
  await health.getByRole('textbox', { name: 'Until wave (exclusive)', exact: true }).fill('20');
  await editor
    .locator('.tp-shop__entry[data-upgrade="damage"]')
    .getByRole('textbox', { name: 'Tap attempts this battle', exact: true })
    .fill('');
}
for (const width of [1360, 1054, 390]) {
  test(`SQ7 SQ12 live save requested then applied at ${String(width)}`, async ({ page }) => {
    let source: unknown = before('shopping_plan_read_requested');
    await page.route('**/api/battles/active', (route) =>
      route.fulfill({ status: 200, json: source }),
    );
    await open(page, 'shopping_live_save', width);
    await edit(page);
    await page
      .locator('.tp-shopping-live')
      .getByRole('button', { name: 'Save queue for this battle' })
      .click();
    await expect(page.locator('[data-outcome="live_recorded"]')).toBeVisible();
    const path = sample('shopping_plan_accepted').request.path;
    expect(await bodiesTo(page, path)).toEqual([
      expect.objectContaining({
        ...record(sample('shopping_plan_accepted').request.body),
        idempotency_key: expect.any(String),
      }),
    ]);
    source = sample('shopping_plan_read_requested').body;
    await page.getByRole('button', { name: 'Check this battle', exact: true }).click();
    await expect(page.locator('[data-outcome="live_recorded"]')).toBeVisible();
    await check(page, width, 'requested');
    source = sample('shopping_plan_read_applied').body;
    await page.getByRole('button', { name: 'Check this battle', exact: true }).click();
    await expect(page.locator('[data-outcome="live_applied"]')).toBeVisible();
    await expect(
      page.locator('.tp-shopping-live').getByRole('button', { name: 'Discard queue edits' }),
    ).toHaveCount(0);
    expect(await bodiesTo(page, path)).toHaveLength(1);
    await check(page, width, 'applied');
  });
  test(`SQ12 Unknown then identical explicit resend at ${String(width)}`, async ({ page }) => {
    let source: unknown = before('shopping_plan_unknown_read');
    await page.route('**/api/battles/active', (route) =>
      route.fulfill({ status: 200, json: source }),
    );
    await open(page, 'shopping_live_unknown', width);
    await edit(page);
    await page
      .locator('.tp-shopping-live')
      .getByRole('button', { name: 'Save queue for this battle' })
      .click();
    await expect(page.locator('[data-outcome="live_unconfirmed"]')).toBeVisible();
    const path = sample('shopping_plan_reply_unknown').request.path;
    const first = await bodiesTo(page, path);
    await check(page, width, 'unknown');
    await page.request.get('/__fake/set?scenario=shopping_live_replay');
    await page.getByRole('button', { name: 'Send same request again', exact: true }).click();
    await expect(page.locator('[data-outcome="live_recorded"]')).toBeVisible();
    expect(await bodiesTo(page, path)).toEqual([first[0], first[0]]);
    source = sample('shopping_plan_unknown_read').body;
    await check(page, width, 'replayed');
  });
  for (const [kind, name, action] of [
    ['whole', 'Shopping', 'shopping'],
    ['attack', 'Attack', 'shopping:attack'],
    ['defense', 'Defense', 'shopping:defense'],
    ['utility', 'Utility', 'shopping:utility'],
    ['upgrade', 'Damage', 'shopping:attack:damage'],
  ]) {
    test(`SQ8 Try once ${kind ?? ''} sends one exact action with outcome at ${String(width)}`, async ({
      page,
    }) => {
      const caseName =
        kind === 'upgrade' ? 'shopping_upgrade_requested' : `shopping_${kind ?? ''}_accepted`;
      let source: unknown = before(caseName);
      await page.route('**/api/battles/active', (route) =>
        route.fulfill({ status: 200, json: source }),
      );
      await open(page, `shopping_live_${kind ?? ''}`, width, false);
      if (kind === 'upgrade') {
        await page.getByText('Queue for this battle', { exact: true }).click();
        const row = page.locator('.tp-battle__queue ol > li').filter({
          has: page.getByRole('button', { name: `Try once ${name ?? ''}`, exact: true }),
        });
        await expect(row).toHaveCount(1);
        await expect(row.getByText(name ?? '', { exact: true })).toBeVisible();
        await expect(row).toContainText(/Tap cap:|No tap cap/);
      }
      await page.getByRole('button', { name: `Try once ${name ?? ''}`, exact: true }).click();
      const accepted = sample(`shopping_${kind ?? ''}_accepted`);
      await expect(
        page.locator('.tp-battle__command').filter({ hasText: action ?? '' }),
      ).toBeVisible();
      expect(await bodiesTo(page, accepted.request.path)).toEqual([
        expect.objectContaining({
          ...record(accepted.request.body),
          idempotency_key: expect.any(String),
        }),
      ]);
      if (kind === 'upgrade') {
        source = sample('shopping_upgrade_started').body;
        await page.evaluate(() => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect(
          page.locator('.tp-battle__command').filter({ hasText: 'Started' }),
        ).toBeVisible();
        source = sample('shopping_upgrade_completed_without_purchase').body;
        await page.evaluate(() => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect(
          page.getByText('Completed; no purchase is implied', { exact: true }),
        ).toBeVisible();
        await expect(
          page.locator('.tp-battle__command').filter({ hasText: 'unknown_wave' }),
        ).toBeVisible();
      }
      expect(await bodiesTo(page, accepted.request.path)).toHaveLength(1);
      await check(page, width, `try-${kind ?? ''}`);
    });
  }
  test(`SQ7 SQ8 gates send nothing at ${String(width)}`, async ({ page }) => {
    await open(page, 'shopping_live_gated', width);
    const save = page
      .locator('.tp-shopping-live')
      .getByRole('button', { name: 'Save queue for this battle' });
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await save.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('link', { name: 'Try once in Dashboard This battle' }).click();
    const action = page.getByRole('button', { name: 'Try once Shopping', exact: true });
    await expect(action).toHaveAttribute('aria-disabled', 'true');
    await action.focus();
    await page.keyboard.press('Enter');
    expect(await posts(page)).toEqual([]);
    await check(page, width, 'gated');
  });
}
