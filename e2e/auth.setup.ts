import { test as setup, expect } from '@playwright/test';
import * as path from 'path';

const authFile = path.join(__dirname, '.auth/session.json');

setup('authenticate', async ({ page }) => {
  const username = process.env.BRIDGE_KUBEADMIN_USERNAME || 'kubeadmin';
  const password = process.env.BRIDGE_KUBEADMIN_PASSWORD;

  await page.goto('/');

  const authDisabled = await page.evaluate(() => window.SERVER_FLAGS?.authDisabled);

  if (!authDisabled) {
    if (!password) {
      throw new Error('BRIDGE_KUBEADMIN_PASSWORD is required when auth is enabled');
    }

    await page.locator('[data-test-id="login"]').waitFor({ state: 'visible' });
    await page.fill('#inputUsername', username);
    await page.fill('#inputPassword', password);
    await page.click('button[type=submit]');
    await expect(page.locator('[data-test="username"]')).toBeVisible();
  }

  const skipTour = page.locator('[data-test="tour-step-footer-secondary"]');
  if (await skipTour.isVisible().catch(() => false)) {
    await skipTour.click();
  }

  await page.context().storageState({ path: authFile });
});
