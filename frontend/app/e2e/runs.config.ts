import { APP } from '../tests/support/paths.ts';
import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = Number(process.env['TP_RUNS_E2E_PORT'] ?? '4215');

/**
 * The Runs page's browser checks on their own port and build, so they can run beside
 * other authors' Playwright runs (the default config runs them too).
 * Build first: npx vite build --outDir playwright-report/runs-build --emptyOutDir
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'runs.spec.ts',
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: APP.split('\\').join('/') + '/',
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/runs-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/runs-e2e',
});
