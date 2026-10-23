import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';

// Build: npx vite build --outDir playwright-report/emulators-config-build --emptyOutDir
const PORT = 4229;
export default defineConfig({
  testDir: '.',
  testMatch: 'emulators-config.spec.ts',
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/emulators-config-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/emulators-config-e2e',
});
