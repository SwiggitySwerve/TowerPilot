import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = Number(process.env['TP_ACTIONS_E2E_PORT'] ?? '4188');

/**
 * A2-7 AC1/AC3/AC5: This battle from the action projection, plus the Dashboard a11y checks, on an
 * isolated port and build (`vite build --outDir node_modules/.cache/actions-build`) so concurrent
 * authors' builds and Playwright runs never replace the page under test.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['dashboard-actions.spec.ts', 'dashboard-a11y.spec.ts'],
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir node_modules/.cache/actions-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../test-results/actions-e2e',
});
