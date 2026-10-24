import { APP } from '../tests/support/paths.ts';
import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = Number(process.env['TP_COLLECTION_E2E_PORT'] ?? '4199');

/**
 * The Collection page's browser checks on their own port and build, so they can
 * run beside other authors' Playwright runs (the default config runs them too).
 */
export default defineConfig({
  testDir: '.',
  testMatch: process.env['TP_PROFILES_FULL_E2E'] === '1' ? '*.spec.ts' : 'collection.spec.ts',
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: APP.split('\\').join('/') + '/',
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/collection-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/collection-e2e',
});
