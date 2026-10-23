import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = 4230;
export default defineConfig({
  testDir: '.',
  testMatch: 'runtime-config.spec.ts',
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: 'playwright-report/runtime-config-results.json' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/runtime-config-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/runtime-config-e2e',
});
