import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = 4228;
export default defineConfig({
  testDir: '.',
  testMatch: 'equipment-config.spec.ts',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/equipment-config-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/equipment-config-e2e',
});
