import { existsSync, readFileSync } from 'fs';
import { defineConfig, devices } from '@playwright/test';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

function resolveBaseURL(): string {
  if (process.env.BRIDGE_BASE_ADDRESS) return process.env.BRIDGE_BASE_ADDRESS;
  if (existsSync('.dev-env.json')) {
    const devEnv = JSON.parse(readFileSync('.dev-env.json', 'utf-8'));
    if (devEnv.consolePort) return `http://localhost:${devEnv.consolePort}`;
  }
  return 'http://localhost:9000';
}

const baseURL = resolveBaseURL();

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
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
    ignoreHTTPSErrors: true,
  },
  timeout: 60_000,
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'e2e',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.e2e/auth/session.json',
      },
      dependencies: ['setup'],
    },
  ],
  outputDir: '.e2e/results/',
});
