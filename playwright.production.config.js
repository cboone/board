import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests/browser/production',
  use: {
    baseURL: 'http://127.0.0.1:4174',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run build:production && node scripts/serve-fixture.js',
    env: {
      CONTEXT: 'production',
      BOARD_DEV_PORT: '4174',
      NPM_CONFIG_CACHE: resolve(import.meta.dirname, '.cache/npm'),
    },
    port: 4174,
    reuseExistingServer: false,
  },
});
