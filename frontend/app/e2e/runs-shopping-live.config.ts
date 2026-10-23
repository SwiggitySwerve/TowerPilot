import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = Number(process.env['TP_SHOPPING_LIVE_E2E_PORT'] ?? '4221');

/**
 * The F6-12 live shopping browser checks on their own port and build, so they can run beside
 * other authors' Playwright runs (the default config runs them too).
 * Build first: npx vite build --outDir playwright-report/runs-shopping-live-build --emptyOutDir
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'runs-shopping-live.spec.ts',
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'playwright-report/shopping-live-browser.json' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/runs-shopping-live-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/runs-shopping-live-e2e',
});
