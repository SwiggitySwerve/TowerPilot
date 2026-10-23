import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bodiesTo, posts } from './helpers.ts';
import { dashboardPagesCase as recorded } from '../tests/support/dashboardFixture.ts';
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT =
  process.env['TP_F6_SCREENS_DIR'] ?? path.resolve('playwright-report/f6-schedule-target-screens');
mkdirSync(OUT, { recursive: true });
const fixture = (name: string) => recorded(`profile_target.${name}`);
const count = (page: Page) =>
  page.getByRole('textbox', { name: 'Runs/day (blank = unlimited)' }).first();
const save = (page: Page) => page.getByRole('button', { name: 'Save schedule', exact: true });
async function open(page: Page, scenario: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/__fake/use?scenario=profile_target_schedule_${scenario}`);
  await page.evaluate(() => {
    window.location.hash = '#schedule';
  });
  await expect(count(page)).toHaveValue('100');
  await count(page).fill('77');
  await page.getByRole('link', { name: 'Change the editing profile in Profiles' }).click();
  const picker = page.locator('[data-form="editing-target"]');
  await picker.getByRole('combobox').selectOption('second');
  await picker.getByRole('button', { name: 'Edit this profile' }).focus();
  await page.keyboard.press('Enter');
  await expect(picker).toContainText('Editing:second(not the active profile)');
  let attempted = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/profile-patch'))
      attempted = true;
  });
  await page.route('**/api/profile-src/second', async (route) => {
    if (attempted) {
      await route.continue();
      return;
    }
    const answer = fixture('same_account_inactive_target_source');
    // Modified recorded source: Schedule has no day-name creation/rename control. Use the
    // recorded sent plan's spare_day with count=1 to exercise a real field edit to the exact
    // recorded whole-plan request, retaining second's original revision and other fields.
    const body = answer.body as {
      profile: {
        plan: unknown;
      };
    };
    body.profile.plan = {
      days: { spare_day: [{ block: 'coin', blueprint: 'farm', count: 1 }] },
      week: { default: 'spare_day' },
    };
    await route.fulfill({ status: answer.status, json: body });
  });
  await page.evaluate(() => {
    window.location.hash = '#schedule';
  });
  await expect(count(page)).toHaveValue('1');
  await expect(page.locator('[data-editing-target="second"]')).toContainText('Active profile:mine');
  await expect(page.locator('.tp-schedule__observed')).toContainText(
    'Observed active profile: mine',
  );
  expect(await posts(page)).toEqual([]);
}
async function proof(page: Page, state: string, width: number) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const scope = window as unknown as {
      axe: {
        run: (
          root: Document,
          options: unknown,
        ) => Promise<{
          violations: {
            id: string;
          }[];
        }>;
      };
    };
    return (
      await scope.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      })
    ).violations.map((v) => v.id);
  });
  expect(violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  const small = await page
    .locator('main button, main input, main select, main summary, main a')
    .evaluateAll((all) =>
      all
        .filter((el) => el.getClientRects().length > 0)
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width < 24 || box.height < 24;
        })
        .map((el) => el.outerHTML),
    );
  expect(small).toEqual([]);
  if (width === 390) {
    expect(
      await page
        .locator('main button')
        .evaluateAll((all) =>
          all
            .filter(
              (el) => el.getClientRects().length > 0 && el.getBoundingClientRect().height < 44,
            )
            .map((el) => el.textContent),
        ),
    ).toEqual([]);
  }
  await page.screenshot({
    path: path.join(OUT, `profile-target-schedule-${state}-${width}.png`),
    fullPage: true,
  });
}
for (const width of [1360, 1054, 390]) {
  test(`PE3 pick second, exact fenced plan save with runner listed, return restores mine at ${width}`, async ({
    page,
  }) => {
    await open(page, 'saved', width);
    await proof(page, 'editing', width);
    await count(page).fill('');
    await save(page).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('Saved schedule. This is not confirmation of scheduler reload.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(await bodiesTo(page, '/api/profile-patch')).toEqual([
      fixture('inactive_plan_saved_while_runner_listed').request.body,
    ]);
    await proof(page, 'saved', width);
    await page.getByRole('link', { name: 'Change the editing profile in Profiles' }).click();
    await page.getByRole('button', { name: 'Return editing to the active profile' }).click();
    await page.evaluate(() => {
      window.location.hash = '#schedule';
    });
    await expect(count(page)).toHaveValue('77');
    await expect(page.locator('[data-editing-target="mine"]')).toContainText(
      'Editing the active profile:mine',
    );
    expect(await bodiesTo(page, '/api/profile-patch')).toHaveLength(1);
    await proof(page, 'returned', width);
  });
  test(`PE3 context changes after click send nothing and retain second draft at ${width}`, async ({
    page,
  }) => {
    await open(page, 'saved', width);
    await count(page).fill('');
    await page.route('**/api/config', (route) =>
      route.fulfill({
        status: 200,
        json: fixture('read_config_after_editor_active_profile_switch').body,
      }),
    );
    await save(page).click();
    await expect(
      page.getByText(/^Not sent: the emulator, account or profile changed/),
    ).toBeVisible();
    expect(await bodiesTo(page, '/api/profile-patch')).toEqual([]);
    await expect(count(page)).toHaveValue('');
    await proof(page, 'not-sent', width);
  });
  for (const [scenario, result] of [
    ['lost', 'Readback confirms the submitted plan is saved.'],
    ['failed', 'Schedule save outcome unknown. Read the saved profile; do not resend the request.'],
    ['stale', 'Schedule save refused. Your draft is kept.'],
    ['deleted', 'Schedule save refused. Your draft is kept.'],
  ]) {
    test(`PE3 ${scenario} preserves target and never resends at ${width}`, async ({ page }) => {
      await open(page, must(scenario), width);
      await count(page).fill('');
      await save(page).click();
      await expect(
        page.getByText(
          scenario === 'lost' || scenario === 'failed'
            ? 'Schedule save outcome unknown. Read the saved profile; do not resend the request.'
            : must(result),
          { exact: true },
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Read saved plan and status' }).click();
      await expect(page.getByText(must(result), { exact: true })).toBeVisible();
      expect(await bodiesTo(page, '/api/profile-patch')).toHaveLength(1);
      await expect(count(page)).toHaveValue('');
      if (scenario === 'deleted') {
        await expect(save(page)).toHaveAttribute('aria-disabled', 'true');
        await expect(page.locator('[data-editing-target="second"]')).toBeVisible();
      }
      await proof(page, must(scenario), width);
    });
  }
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required fixture value');
  return value;
}
