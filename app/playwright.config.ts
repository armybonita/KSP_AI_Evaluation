import { defineConfig } from '@playwright/test';

const PORT = process.env.PORT || '3041';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    headless: true,
    extraHTTPHeaders: { 'x-auth-request-user': 'evaluator' },
  },
});
