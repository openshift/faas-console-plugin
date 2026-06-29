import { test, expect } from '@playwright/test';
import {
  createButtonLocator,
  loadFunctionsListWithRealPat,
  robustClick,
  waitForTableOrEmpty,
} from '../helpers';

const pat = process.env.BRIDGE_GITHUB_PAT ?? '';

test.describe('GitHub integration (real PAT)', () => {
  test.skip(!pat, 'BRIDGE_GITHUB_PAT not set');

  test('authenticates and lists functions from GitHub', async ({ page }) => {
    await test.step('load list page with real PAT', async () => {
      await loadFunctionsListWithRealPat(page, pat);
    });

    await test.step('verify page renders with data', async () => {
      await expect(page.getByRole('heading', { name: 'Functions' })).toBeVisible();
      await waitForTableOrEmpty(page);
    });
  });

  test('navigates create form and returns to list', async ({ page }) => {
    await test.step('load list page with real PAT', async () => {
      await loadFunctionsListWithRealPat(page, pat);
      await waitForTableOrEmpty(page);
    });

    await test.step('click create and verify form loads', async () => {
      await robustClick(createButtonLocator(page));
      await expect(page).toHaveURL(/\/faas\/create/);
    });

    await test.step('verify owner field is populated from GitHub user', async () => {
      const ownerField = page.locator('#owner');
      await expect(ownerField).toBeVisible({ timeout: 10_000 });
      await expect(ownerField).not.toHaveValue('');
    });

    await test.step('verify form fields are present', async () => {
      await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible();
    });

    await test.step('cancel returns to list', async () => {
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page).toHaveURL(/\/faas$/);
    });
  });
});
