import { APP } from '../tests/support/paths.ts';
import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

const PORT = Number(process.env['TP_PROFILE_PATCH_FENCED_E2E_PORT'] ?? '4277');
export default defineConfig({
  testDir: '.',
  testMatch: 'profile-patch-fenced.spec.ts',
  fullyParallel: true,
  workers: 4,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: APP.split('\\').join('/') + '/',
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/profile-patch-fenced-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/profile-patch-fenced-e2e',
});
