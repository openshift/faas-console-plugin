import { test, expect } from '@playwright/test';
import { navigateToFunctionsTable } from '../helpers';

const pat = process.env.BRIDGE_GITHUB_PAT ?? '';

test.describe('Delete function', () => {
  test.skip(!pat, 'BRIDGE_GITHUB_PAT not set');

  test.beforeEach(async ({ page }) => {
    await navigateToFunctionsTable(page);
  });

  test('delete button is present in the function table', async ({ page }) => {
    const table = page.getByRole('grid', { name: 'Functions' });
    const deleteBtn = table.getByRole('button', { name: 'Delete' }).first();
    await expect(deleteBtn).toBeVisible();
  });

  test('clicking enabled delete button opens confirmation modal', async ({ page }) => {
    const table = page.getByRole('grid', { name: 'Functions' });
    const deleteBtn = table.getByRole('button', { name: 'Delete' }).first();
    const isEnabled = await deleteBtn.isEnabled().catch(() => false);

    if (!isEnabled) return;

    await deleteBtn.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    const cancelBtn = modal.getByRole('button', { name: /cancel/i });
    await cancelBtn.click();
    await expect(modal).not.toBeVisible();
  });
});
