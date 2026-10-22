import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

/** Build first: npx vite build --outDir playwright-report/emulators-bs-build --emptyOutDir */
export default defineConfig({
  testDir: '.',
  testMatch: [
    'emulators.spec.ts',
    'emulators.confirmations.spec.ts',
    'emulators.bluestacks.spec.ts',
  ],
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4213', trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    command: `${E2E_NODE} e2e/fake-backend.mjs --port 4213 --build-dir playwright-report/emulators-bs-build`,
    url: 'http://127.0.0.1:4213/ui/app/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: 'test-results/emulators-bs-e2e',
});
