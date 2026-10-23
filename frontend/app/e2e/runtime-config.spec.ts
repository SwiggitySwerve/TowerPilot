import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openScenario, posts } from './helpers.ts';
import { RUNTIME_CONFIG_SAVES } from './runtime-config-fixtures.mjs';
import {
  loadJsonWithIdentity,
  DASHBOARD_PAGES_FIXTURE_PATH,
} from '../scripts/contract-fixture.mjs';
import { record } from '../scripts/generate-contract.mjs';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const SCREENS = path.resolve(
  process.env['TP_F6_SCREENS_DIR'] ?? '../../backend/logs/reviews/frontend-f6-screens',
);
mkdirSync(SCREENS, { recursive: true });
const CASES = record(record(loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture)['cases']);
const recorded = (name: string) => record(record(CASES['settings_modules'])[name]);
type Module = keyof typeof RUNTIME_CONFIG_SAVES;
const rows: readonly { title: string; module: Module }[] = [
  { title: 'C15-5', module: 'run-defaults' },
  { title: 'C15-10 C15-11', module: 'loop-defaults' },
  { title: 'C15-12', module: 'missions-defaults' },
  { title: 'C15-13 C15-14', module: 'fleet-defaults' },
];
const form = (page: Page, module: string) => page.locator(`[data-module="${module}"]`);
const save = (page: Page, module: string) =>
  form(page, module).getByRole('button', { name: 'Save', exact: true });
const input = (page: Page, module: string, key: string) =>
  form(page, module).locator(`[data-part="${key}"]`);
const shot = (page: Page, width: number, module: string, state: string) =>
  page.screenshot({
    path: path.join(
      SCREENS,
      `config-fields-${module === 'run-defaults' ? 'runs' : 'runtime'}-${width}-${module}-${state}.png`,
    ),
    fullPage: true,
  });
async function open(page: Page, width: number, module: Module, mode = 'saved') {
  const errors = await openScenario(
    page,
    `config_fields_runtime_${RUNTIME_CONFIG_SAVES[module].suffix}_${mode}`,
    { width },
  );
  await page.getByText('Pages', { exact: true }).click();
  await page
    .getByRole('link', { name: module === 'run-defaults' ? 'Runs' : 'Runtime', exact: true })
    .click();
  if (module === 'run-defaults') {
    const disclosure = page.locator('[data-run-defaults] > summary');
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toBeFocused();
  }
  await expect(save(page, module)).toBeVisible();
  return errors;
}
async function fill(page: Page, module: Module) {
  const saved = recorded(`saved_${RUNTIME_CONFIG_SAVES[module].suffix}`);
  const body = record(record(saved['request'])['body']);
  const values = record(body['values']);
  const snapshot = record(recorded(RUNTIME_CONFIG_SAVES[module].before)['body']);
  const modules = snapshot['modules'] as {
    id: string;
    fields: { path: string; label: string }[];
  }[];
  const fields = modules.find((entry) => entry.id === module)?.fields;
  if (fields === undefined) throw new Error('Missing recorded fields');
  for (const [key, value] of Object.entries(values)) {
    const label = fields.find((field) => field.path === key)?.label;
    if (label === undefined) throw new Error('Missing recorded label');
    if (typeof value === 'boolean')
      await form(page, module)
        .getByRole('checkbox', { name: label, exact: true })
        .setChecked(value);
    else if (module === 'run-defaults')
      await form(page, module)
        .getByRole('combobox', { name: label, exact: true })
        .selectOption(String(value));
    else if (Array.isArray(value)) {
      for (const [index, part] of value.entries())
        await input(page, module, `${key}#${index}`).fill(String(part));
    } else await input(page, module, key).fill(String(value));
  }
  return body;
}
async function layout(page: Page, width: number, module: Module) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const scope =
    module === 'run-defaults' ? page.locator('[data-run-defaults]') : page.locator('.tp-runtime');
  const small = await scope.locator('button, input, select, summary').evaluateAll(
    (nodes, width) =>
      nodes
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const floor = width === 390 && node.tagName === 'BUTTON' ? 44 : 24;
          return rect.width < floor - 1 || rect.height < floor - 1;
        })
        .map((node) => ({
          tag: node.tagName,
          text: node.textContent,
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        })),
    width,
  );
  expect(small).toEqual([]);
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const axe = Reflect.get(window, 'axe') as {
      run: (context: unknown, options: unknown) => Promise<{ violations: unknown[] }>;
    };
    return (
      await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      })
    ).violations;
  });
  expect(violations).toEqual([]);
}
for (const width of [1360, 1054, 390]) {
  for (const { title, module } of rows) {
    test(`${title} ${module} lost reply stays Unknown until positive readback at ${width}`, async ({
      page,
    }) => {
      const errors = await open(page, width, module, 'unknown');
      await fill(page, module);
      await save(page, module).click();
      await expect(form(page, module).locator('[data-outcome="unknown"]')).toBeVisible();
      await expect(save(page, module)).toHaveAttribute('aria-disabled', 'true');
      await shot(page, width, module, 'unknown');
      const found = recorded(`read_after_saved_${RUNTIME_CONFIG_SAVES[module].suffix}`);
      await page.route('**/api/settings', (route) =>
        route.fulfill({ status: Number(found['status']), json: found['body'] }),
      );
      await page.getByRole('button', { name: 'Read settings again' }).click();
      await expect(form(page, module).locator('[data-outcome="applied"]')).toBeVisible();
      expect(await posts(page)).toHaveLength(1);
      await shot(page, width, module, 'readback');
      expect(errors).toEqual([]);
    });
    test(`${title} ${module} save, scope, keyboard and axe at ${width}`, async ({ page }) => {
      const errors = await open(
        page,
        width,
        module,
        module === 'run-defaults' ? 'saved' : 'override',
      );
      const picker = page.locator('[data-focus-key="runs:run"]');
      const pickerBefore = module === 'run-defaults' ? await picker.inputValue() : null;
      const override = module.replace('-defaults', '');
      const overrideKey =
        module === 'loop-defaults'
          ? 'fps'
          : module === 'missions-defaults'
            ? 'visit_delay_sec#0'
            : 'hold_window';
      const overrideBefore =
        module === 'run-defaults' ? null : await input(page, override, overrideKey).inputValue();
      if (module !== 'run-defaults') {
        await expect(page.locator('[data-runtime-group]')).toHaveCount(3);
      }
      const body = await fill(page, module);
      const button = save(page, module);
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(form(page, module).locator('[data-outcome="saved"]')).toBeVisible();
      if (module !== 'run-defaults')
        await expect(input(page, override, overrideKey)).toHaveValue(overrideBefore ?? '');
      else await expect(picker).toHaveValue(pickerBefore ?? '');
      expect(
        (await posts(page)).map((entry) => ({
          path: entry.path,
          body: JSON.parse(entry.body) as unknown,
        })),
      ).toEqual([{ path: '/api/settings', body }]);
      await expect(page.locator(`[data-settings-outcome-scope="${module}"]`)).toContainText(
        /Machine/,
      );
      await shot(page, width, module, 'saved');
      await layout(page, width, module);
      expect(errors).toEqual([]);
    });
    test(`${title} ${module} invalid kept and stale refused at ${width}`, async ({ page }) => {
      const errors = await open(page, width, module, 'stale');
      if (module !== 'run-defaults') {
        const key =
          module === 'loop-defaults'
            ? 'fps'
            : module === 'missions-defaults'
              ? 'visit_delay_sec#0'
              : 'hold_window';
        const value =
          module === 'missions-defaults' ? '' : module === 'fleet-defaults' ? '1.5' : 'NaN';
        await input(page, module, key).fill(value);
        await expect(input(page, module, key)).toHaveValue(value);
        await expect(input(page, module, key)).toHaveAttribute('aria-invalid', 'true');
        await expect(save(page, module)).toHaveAttribute('aria-disabled', 'true');
        expect(await posts(page)).toEqual([]);
        await shot(page, width, module, 'invalid');
      }
      await fill(page, module);
      await save(page, module).click();
      const refused = record(
        recorded(`stale_revision_${RUNTIME_CONFIG_SAVES[module].suffix}`)['body'],
      );
      await expect(form(page, module)).toContainText(String(refused['error']));
      await expect(form(page, module).locator('[data-outcome]')).toBeVisible();
      expect(await posts(page)).toHaveLength(1);
      await shot(page, width, module, 'stale');
      expect(errors).toEqual([]);
    });
  }
}
