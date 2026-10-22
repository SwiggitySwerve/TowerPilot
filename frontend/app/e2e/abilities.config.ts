import { defineConfig, devices } from '@playwright/test';
import { E2E_NODE } from './runtime.ts';
const PORT = Number(process.env['TP_ABILITIES_E2E_PORT'] ?? '4197');
export default defineConfig({
  testDir: '.',
  testMatch: process.env['TP_ABILITIES_FULL_E2E'] === '1' ? '*.spec.ts' : 'abilities.spec.ts',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    command: `${E2E_NODE} e2e/fake-backend.mjs --port ${PORT} --build-dir playwright-report/abilities-build`,
    url: `http://127.0.0.1:${PORT}/ui/app/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  outputDir: '../playwright-report/abilities-e2e',
});
