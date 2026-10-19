import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const chromium = process.env.PW_CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

// Started by scripts/test-live-e2e.sh, which provides the backend and LIVE_APP_URL.
export default defineConfig({
  testDir: 'tests/e2e-live',
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: process.env.LIVE_APP_URL, launchOptions: chromium ? { executablePath: chromium } : {}, trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } },
});
