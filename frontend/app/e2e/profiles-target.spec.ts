import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bodiesTo, posts } from './helpers.ts';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const OUT = process.env['TP_F6_SCREENS_DIR'] ?? path.resolve('test-results/f6-screens');
mkdirSync(OUT, { recursive: true });

async function open(page: Page, scenario: string, width: number) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/__fake/use?scenario=${scenario}`);
  await page.evaluate(() => {
    window.location.hash = '#profiles';
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Profiles' })).toBeVisible();
  await expect(page.locator('[data-form="unbind"]')).toContainText('mine');
  return errors;
}

async function proof(page: Page, state: string, width: number) {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const scope = window as unknown as {
      axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> };
    };
    return (await scope.axe.run(document)).violations.map((violation) => violation.id);
  });
  expect(violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  const small = await page
    .locator('main button, main input, main select, main summary, dialog[open] button')
    .evaluateAll((all) =>
      all
        .filter((element) => element.getClientRects().length > 0)
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width < 24 || box.height < 24;
        })
        .map((element) => element.outerHTML.slice(0, 120)),
    );
  expect(small).toEqual([]);
  if (width === 390) {
    expect(
      await page
        .locator('main button, dialog[open] button')
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
    path: path.join(OUT, `profile-target-foundation-${state}-${width}.png`),
    fullPage: true,
  });
}

for (const width of [1360, 1054, 390]) {
  test(`PE1 confirm/cancel, identity, keyboard focus return and config after unbind at ${width}`, async ({
    page,
  }) => {
    const errors = await open(page, 'profile_target_unbind', width);
    const trigger = page
      .locator('[data-form="unbind"]')
      .getByRole('button', { name: 'Use no profile' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Account:alpha');
    await expect(dialog).toContainText('Emulator:main');
    await expect(dialog).toContainText('Current profile:mine');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Use no profile' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await proof(page, 'confirm', width);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    expect(await posts(page)).toEqual([]);
    await page.keyboard.press('Enter');
    // Keep the genuine recorded config read in flight after the recorded receipt.
    let verifying = false;
    let releaseConfig: () => void = () => undefined;
    const configGate = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    await page.route('**/api/profile-activate', async (route) => {
      verifying = true;
      await route.continue();
    });
    await page.route('**/api/config', async (route) => {
      if (verifying) await configGate;
      await route.continue();
    });
    await dialog.getByRole('button', { name: 'Use no profile' }).click();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-disabled', 'true');
    const unbind = page.locator('[data-form="unbind"]');
    await expect(unbind).toContainText('Accepted, waiting for the configuration to confirm');
    await expect(unbind).not.toContainText('No profile is active -');
    await expect(trigger).toHaveAccessibleDescription(
      'The previous unbind is unresolved; waiting for the configuration to confirm',
    );
    await proof(page, 'accepted', width);
    releaseConfig();
    await expect(unbind).toContainText('No profile is active -');
    await expect(page.locator('[data-form="unbind"]')).toContainText('No profile is active');
    expect(await bodiesTo(page, '/api/profile-activate')).toEqual([
      {
        name: null,
        expected_context: { instance: 'main', account: 'alpha', profile: 'mine', serial: 'fake:1' },
      },
    ]);
    await proof(page, 'unbound', width);
    expect(errors).toEqual([]);
  });

  test(`PE1 written_then_answer_failed settles by config; runner refusal leaves mine; never resent at ${width}`, async ({
    page,
  }) => {
    for (const scenario of ['profile_target_unbind_lost', 'profile_target_runner_refusal']) {
      const errors = await open(page, scenario, width);
      await page
        .locator('[data-form="unbind"]')
        .getByRole('button', { name: 'Use no profile' })
        .click();
      await page.getByRole('dialog').getByRole('button', { name: 'Use no profile' }).click();
      const lost = scenario === 'profile_target_unbind_lost';
      await expect(page.locator('[data-form="unbind"]')).toContainText(
        lost ? 'No profile is active -' : 'runners alive - stop them first',
      );
      if (!lost)
        await expect(page.locator('[data-form="unbind"]')).toContainText('Active profile:mine');
      await proof(page, lost ? 'settled' : 'refused', width);
      expect(await bodiesTo(page, '/api/profile-activate')).toHaveLength(1);
      expect(errors).toEqual([]);
    }
  });

  test(`PE2 pick second, restore after reload and return with zero POSTs at ${width}`, async ({
    page,
  }) => {
    const errors = await open(page, 'profile_target_pick', width);
    const box = page.locator('[data-form="editing-target"]');
    await box.getByRole('combobox').selectOption('second');
    await box.getByRole('button', { name: 'Edit this profile' }).focus();
    await page.keyboard.press('Enter');
    await expect(box).toContainText('Editing:second(not the active profile)');
    await expect(page.locator('[data-form="unbind"]')).toContainText('Active profile:mine');
    await proof(page, 'picked', width);
    await page.reload();
    await expect(box.locator('[data-editing-target="second"]')).toHaveAttribute(
      'data-target-blocked',
      '',
    );
    await box.getByRole('button', { name: 'Return editing to the active profile' }).focus();
    await page.keyboard.press('Enter');
    await expect(box).toContainText('Editing the active profile:mine');
    await proof(page, 'returned', width);
    expect(await posts(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
