import { test, expect } from '@playwright/test';
import { navigateToFunctionsTable } from '../../helpers';

test.describe('Edit function page', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToFunctionsTable(page);
    await page
      .getByRole('grid', { name: 'Functions' })
      .getByRole('button', { name: 'Edit' })
      .first()
      .click();
  });

  test('opens edit page and displays editor layout', async ({ page }) => {
    await expect(page).toHaveURL(/\/faas\/edit\//);
    await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible();
  });

  test('toolbar has back button and save button', async ({ page }) => {
    const backBtn = page.getByRole('button', { name: 'Back to Functions' });
    const saveBtn = page.getByRole('button', { name: 'Save & Deploy' });
    await expect(backBtn).toBeVisible();
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toBeDisabled();
  });

  test('back button navigates to list page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to Functions' }).click();
    await expect(page).toHaveURL(/\/faas$/);
  });
});
