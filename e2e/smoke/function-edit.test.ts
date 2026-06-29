import { test, expect } from '@playwright/test';
import { loadFunctionsList } from '../helpers';

const pat = process.env.BRIDGE_GITHUB_PAT ?? '';

test.describe('Edit function page', () => {
  test.skip(!pat, 'BRIDGE_GITHUB_PAT not set');
  test('opens edit page from table and displays editor layout', async ({ page }) => {
    await loadFunctionsList(page);

    const table = page.getByRole('grid', { name: 'Functions' });
    await expect(table).toBeVisible({ timeout: 30_000 });

    const editBtn = table.getByRole('button', { name: 'Edit' }).first();
    await editBtn.click();

    await expect(page).toHaveURL(/\/faas\/edit\//);
    await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible();
  });

  test('toolbar has back button and save button', async ({ page }) => {
    await loadFunctionsList(page);

    const table = page.getByRole('grid', { name: 'Functions' });
    await expect(table).toBeVisible({ timeout: 30_000 });

    const editBtn = table.getByRole('button', { name: 'Edit' }).first();
    await editBtn.click();

    const backBtn = page.getByRole('button', { name: 'Back to Functions' });
    const saveBtn = page.getByRole('button', { name: 'Save & Deploy' });
    await expect(backBtn).toBeVisible();
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toBeDisabled();
  });

  test('back button navigates to list page', async ({ page }) => {
    await loadFunctionsList(page);

    const table = page.getByRole('grid', { name: 'Functions' });
    await expect(table).toBeVisible({ timeout: 30_000 });

    const editBtn = table.getByRole('button', { name: 'Edit' }).first();
    await editBtn.click();

    await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to Functions' }).click();
    await expect(page).toHaveURL(/\/faas$/);
  });
});
