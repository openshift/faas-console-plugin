import { existsSync } from 'fs';
import { defineConfig, devices } from '@playwright/test';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const baseURL = process.env.BRIDGE_BASE_ADDRESS || 'http://localhost:9000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['junit', { outputFile: '.e2e/results/junit-results.xml' }],
        ['html', { outputFolder: '.e2e/report', open: 'never' }],
      ]
    : [['html', { outputFolder: '.e2e/report', open: 'on-failure' }]],
  use: {
    baseURL,
    viewport: { width: 1920, height: 1080 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  timeout: 60_000,
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'smoke',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.e2e/auth/session.json',
      },
      dependencies: ['setup'],
    },
  ],
  outputDir: '.e2e/results/',
});
