import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = 4223;

export default defineConfig({
  testDir: '.',
  testMatch: 'profiles-target.spec.ts',
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/profiles-target-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  outputDir: '../playwright-report/profiles-target-e2e',
});
