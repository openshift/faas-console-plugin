import { Page } from '@playwright/test';

const LOADING_SELECTORS = [
  '[aria-label="Loading"]',
  '.pf-v6-c-spinner',
  '.pf-c-spinner',
  '.co-m-loader',
];

export async function waitForLoadingComplete(page: Page, timeoutMs = 30_000): Promise<void> {
  const combined = page.locator(LOADING_SELECTORS.join(', '));
  // Two-phase wait: first give the spinner a moment to appear (prevents the
  // hidden check from resolving instantly when no spinner is in the DOM yet),
  // then wait for it to disappear, meaning loading is complete.
  await combined
    .first()
    .waitFor({ state: 'visible', timeout: 1_000 })
    .catch(() => {});
  await combined
    .first()
    .waitFor({ state: 'hidden', timeout: timeoutMs })
    .catch(() => {});
}

export async function dismissDialogs(page: Page): Promise<void> {
  await page
    .evaluate(() => document.getElementById('webpack-dev-server-client-overlay')?.remove())
    .catch(() => {});
  await page
    .addLocatorHandler(page.locator('#webpack-dev-server-client-overlay'), async () => {
      await page
        .evaluate(() => document.getElementById('webpack-dev-server-client-overlay')?.remove())
        .catch(() => {});
    })
    .catch(() => {});

  const anyDialog = page
    .locator('.pf-v6-c-modal-box')
    .or(page.locator('[data-test="tour-step-footer-secondary"]'));
  await anyDialog
    .first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {});

  const patDialog = page.locator('.pf-v6-c-modal-box').filter({ hasText: 'Connect to GitHub' });
  if (await patDialog.isVisible()) {
    const cancelBtn = patDialog.locator('button').filter({ hasText: 'Cancel' });
    await cancelBtn.evaluate((el: HTMLElement) => el.click());
    await patDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  const skipTour = page.locator('[data-test="tour-step-footer-secondary"]');
  await skipTour.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await skipTour.isVisible()) {
    await skipTour.evaluate((el: HTMLElement) => el.click());
    await skipTour.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}
