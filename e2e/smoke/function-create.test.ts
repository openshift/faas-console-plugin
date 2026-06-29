import { test, expect } from '@playwright/test';
import {
  dismissDialogs,
  injectRealGitHubPat,
  loadFunctionsList,
  waitForTableOrEmpty,
} from '../helpers';

const pat = process.env.BRIDGE_GITHUB_PAT ?? '';

test.describe('Create function page', () => {
  test.skip(!pat, 'BRIDGE_GITHUB_PAT not set');

  test('navigates to create page and renders the form', async ({ page }) => {
    await loadFunctionsList(page);
    const result = await waitForTableOrEmpty(page);

    const createBtn =
      result === 'table'
        ? page.getByRole('link', { name: 'Create new function' })
        : page.getByRole('link', { name: 'Create function' });
    await createBtn.click();

    await expect(page).toHaveURL(/\/faas\/create/);
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
  });

  test('form has all required fields', async ({ page }) => {
    await page.goto('/faas/create');
    await injectRealGitHubPat(page, pat);
    await page.reload();
    await dismissDialogs(page);

    await expect(page.locator('#owner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#repo')).toBeVisible();
    await expect(page.locator('#branch')).toBeVisible();
    await expect(page.locator('#name')).toBeVisible();
    await expect(page.locator('#runtime')).toBeVisible();
    await expect(page.locator('#registry')).toBeVisible();
    await expect(page.locator('#namespace')).toBeVisible();
  });

  test('submit button is disabled until form is valid', async ({ page }) => {
    await page.goto('/faas/create');
    await injectRealGitHubPat(page, pat);
    await page.reload();
    await dismissDialogs(page);

    const submitBtn = page.getByRole('button', { name: 'Create', exact: true });
    await expect(submitBtn).toBeVisible({ timeout: 10_000 });
    await expect(submitBtn).toBeDisabled();

    await page.locator('#repo').fill('e2e-test-fn');
    await page.locator('#branch').fill('main');
    await page.locator('#name').fill('e2e-test-fn');
    await page.locator('#namespace').fill('e2e-test-ns');

    await expect(submitBtn).toBeEnabled();
  });

  test('cancel button navigates back to list', async ({ page }) => {
    await page.goto('/faas/create');
    await injectRealGitHubPat(page, pat);
    await page.reload();
    await dismissDialogs(page);

    const cancelBtn = page.getByRole('button', { name: 'Cancel' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();
    await expect(page).toHaveURL(/\/faas$/);
  });
});
