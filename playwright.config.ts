import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Use an explicit/preinstalled Chromium when available (e.g. sandboxed CI images); otherwise Playwright's own.
const chromium = process.env.PW_CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /responsive/ },
  ],
  webServer: { command: 'npx vite build && npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: true, timeout: 120_000 },
});
