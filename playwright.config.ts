import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 40_000,
  use: { baseURL: 'http://localhost:4173', browserName: 'chromium', channel: 'chrome', headless: true, viewport: { width: 1360, height: 900 }, acceptDownloads: true },
  webServer: { command: 'pnpm --filter @secure-notes/web preview --port 4173', url: 'http://localhost:4173', reuseExistingServer: true },
});
