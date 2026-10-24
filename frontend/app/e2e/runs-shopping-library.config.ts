import { APP } from '../tests/support/paths.ts';
import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = 4222;
export default defineConfig({
  testDir: '.',
  testMatch: 'runs-shopping-library.spec.ts',
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'playwright-report/shopping-library-browser.json' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: APP.split('\\').join('/') + '/',
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/runs-shopping-library-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/runs-shopping-library-e2e',
});
