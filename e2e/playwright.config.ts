// e2e рутин (docs/routines/SPEC.md §6): настоящий сервер на временном порту, фейковые claude, Slack и Telegram.
// Каждый тест поднимает своё окружение (e2e/support/env.ts), поэтому тесты независимы и идут параллельно.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  outputDir: './.output',
  globalSetup: './support/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
