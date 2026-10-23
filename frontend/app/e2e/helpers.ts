import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';

/** Shared steps of the Dashboard browser checks against the fake backend (e2e/fake-backend.mjs). */

export interface Posted {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

/**
 * Open the Dashboard on a fake-backend scenario at `width`. `faults` names
 * parts made to fail while drawing (the session key app/ reads, X4 to X6).
 * Waits for the first answered status read unless `waitForRead` is false.
 */
export async function openScenario(
  page: Page,
  scenario: string,
  options: {
    readonly width?: number;
    readonly faults?: readonly string[];
    readonly waitForRead?: boolean;
  } = {},
): Promise<string[]> {
  const problems: string[] = [];
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  if (options.faults !== undefined && options.faults.length > 0) {
    await page.addInitScript((faults) => {
      window.sessionStorage.setItem('tp.faults', faults);
    }, options.faults.join(','));
  }
  await page.setViewportSize({ width: options.width ?? 1360, height: 900 });
  await page.goto(`/__fake/use?scenario=${scenario}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Control' })).toBeVisible();
  if (options.waitForRead !== false) {
    await expect(page.locator('[data-region="control"] time')).toBeVisible();
  }
  return problems;
}

/** The writes the fake backend recorded for this browser's session (diagnostics excluded). */
export async function posts(page: Page): Promise<Posted[]> {
  const answer = await page.request.get('/__fake/posts');
  const body = (await answer.json()) as { readonly posts: Posted[] };
  return body.posts;
}

/** The parsed bodies of the recorded writes to `path`. */
export async function bodiesTo(page: Page, path: string): Promise<unknown[]> {
  return (await posts(page))
    .filter((entry) => entry.path === path)
    .map((entry) => JSON.parse(entry.body) as unknown);
}

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** The WCAG 2.2 A and AA rule tags most page checks run axe with. */
export const WCAG_AA_TAGS: readonly string[] = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
];

/**
 * Fail unless the built app stylesheet applies to the page. On an unstyled page axe and the
 * geometry checks report contrast, target-size and overflow faults the app does not have, so
 * every such check runs this first. Each linked stylesheet must have loaded with rules.
 */
export async function expectAppStyles(page: Page): Promise<void> {
  const sheets = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')].map((link) => {
      let rules: number;
      try {
        rules = link.sheet?.cssRules.length ?? 0;
      } catch {
        rules = 0;
      }
      return { href: link.href, rules };
    }),
  );
  const app = sheets.filter((sheet) => /\/ui\/app\/assets\/[^/]+\.css$/u.test(sheet.href));
  if (app.length > 0 && sheets.every((sheet) => sheet.rules > 0)) return;
  // Name the browser's own reason (for example net::ERR_NO_BUFFER_SPACE) when it still holds the
  // request; page.requests() keeps only the most recent ones.
  const hrefs = new Set(sheets.map((sheet) => sheet.href));
  const reasons = (await page.requests())
    .filter((request) => hrefs.has(request.url()))
    .map((request) => `${request.url()}: ${request.failure()?.errorText ?? 'no load failure'}`);
  throw new Error(
    `app stylesheet not loaded: ${JSON.stringify(sheets)}; ` +
      (reasons.length > 0 ? reasons.join('; ') : 'the stylesheet request is no longer retained'),
  );
}

/** One axe violation as the page returns it (other fields pass through untyped). */
export interface AxeViolation {
  readonly id: string;
  readonly nodes: readonly { readonly target: readonly unknown[] }[];
}

/**
 * Run axe on the whole document once the app stylesheet is proven loaded. `tags` limits the
 * rules to those tags (runOnly); without it axe runs its default rules.
 */
export async function axeViolations(page: Page, tags?: readonly string[]): Promise<AxeViolation[]> {
  await expectAppStyles(page);
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async (values) => {
    const axe = Reflect.get(window, 'axe') as {
      run: (root: Document, options?: unknown) => Promise<{ violations: AxeViolation[] }>;
    };
    const result =
      values === null
        ? await axe.run(document)
        : await axe.run(document, { runOnly: { type: 'tag', values } });
    return result.violations;
  }, tags ?? null);
}

/** The ids of the axe violations. */
export async function axeIds(page: Page, tags?: readonly string[]): Promise<string[]> {
  return (await axeViolations(page, tags)).map((violation) => violation.id);
}

/** Each axe violation as `id (node count)`. */
export async function axeCounts(page: Page, tags?: readonly string[]): Promise<string[]> {
  return (await axeViolations(page, tags)).map(
    (violation) => `${violation.id} (${String(violation.nodes.length)})`,
  );
}
