import { APP } from '../tests/support/paths.ts';
import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = Number(process.env['TP_HISTORY_E2E_PORT'] ?? '4186');

/** An isolated port/build keeps this author away from live services and concurrent authors. */
export default defineConfig({
  testDir: '.',
  testMatch: 'history*.spec.ts',
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: APP.split('\\').join('/') + '/',
    command: `${E2E_NODE} node_modules/vite/bin/vite.js build --outDir node_modules/.cache/history-build && ${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir node_modules/.cache/history-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  // Keep the build outside test-results: another author's default Playwright run clears it.
  outputDir: '../test-results/history-e2e',
});
