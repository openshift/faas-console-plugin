import { test, expect } from '@playwright/test';
import { loadFunctionsList } from '../helpers';

const pat = process.env.BRIDGE_GITHUB_PAT ?? '';

test.describe('Delete function', () => {
  test.skip(!pat, 'BRIDGE_GITHUB_PAT not set');
  test('delete button is present in the function table', async ({ page }) => {
    await loadFunctionsList(page);

    const table = page.getByRole('grid', { name: 'Functions' });
    await expect(table).toBeVisible({ timeout: 30_000 });

    const deleteBtn = table.getByRole('button', { name: 'Delete' }).first();
    await expect(deleteBtn).toBeVisible();
  });

  test('clicking enabled delete button opens confirmation modal', async ({ page }) => {
    await loadFunctionsList(page);

    const table = page.getByRole('grid', { name: 'Functions' });
    await expect(table).toBeVisible({ timeout: 30_000 });

    const deleteBtn = table.getByRole('button', { name: 'Delete' }).first();
    const isEnabled = await deleteBtn.isEnabled().catch(() => false);

    if (isEnabled) {
      await deleteBtn.click();

      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible();

      const cancelBtn = modal.getByRole('button', { name: /cancel/i });
      await cancelBtn.click();
      await expect(modal).not.toBeVisible();
    }
  });
});
