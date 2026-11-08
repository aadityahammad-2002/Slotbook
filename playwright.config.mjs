import { defineConfig, devices } from '@playwright/test';

const port = process.env.SLOTBOOK_E2E_PORT || '3101';
if (!/^\d{2,5}$/.test(port) || Number(port) > 65535) {
  throw new Error('SLOTBOOK_E2E_PORT must be a valid TCP port');
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'node --env-file=.env scripts/start-e2e.mjs',
    url: `${baseURL}/api/public/hosts`,
    timeout: 90_000,
    reuseExistingServer: false,
  },
});
