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
