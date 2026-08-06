import { test as setup, expect } from '@playwright/test';
import * as path from 'path';

const authFile = path.join(__dirname, '../.e2e/auth/session.json');

setup('authenticate', async ({ page }) => {
  const username = process.env.BRIDGE_KUBEADMIN_USERNAME || 'kubeadmin';
  const password = process.env.BRIDGE_KUBEADMIN_PASSWORD;

  await page.goto('/');

  await page
    .locator('[data-test-id="login"], [data-test="username"]')
    .first()
    .waitFor({ timeout: 30_000 });

  const authDisabled = await page.evaluate(() => window.SERVER_FLAGS?.authDisabled);

  if (!authDisabled) {
    if (!password) {
      throw new Error('BRIDGE_KUBEADMIN_PASSWORD is required when auth is enabled');
    }

    const loginForm = page.locator('[data-test-id="login"]');
    const kubeAdminIDP = page.locator('a:has-text("kube:admin")');
    await loginForm.or(kubeAdminIDP).first().waitFor({ state: 'visible' });
    if (await kubeAdminIDP.isVisible()) {
      await kubeAdminIDP.click();
    }

    await loginForm.waitFor({ state: 'visible' });
    await page.fill('#inputUsername', username);
    await page.fill('#inputPassword', password);
    await page.click('button[type=submit]');
    await expect(page.locator('[data-test="username"]')).toBeVisible();
  }

  const skipTour = page.locator('[data-test="tour-step-footer-secondary"]');
  if (await skipTour.isVisible().catch(() => false)) {
    await skipTour.evaluate((el: HTMLElement) => el.click());
  }

  await page.context().storageState({ path: authFile });
});
