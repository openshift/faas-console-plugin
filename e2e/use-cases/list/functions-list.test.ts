import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { PRESEEDED_FUNC_NAME } from '../../helpers/constants';

test.describe('Functions list', () => {
  test('user browses functions, refreshes, and navigates to edit and create', async ({ page }) => {
    await test.step('navigate to functions list', async () => {
      await navigateToFunctionsList(page);
      await expect(page.getByRole('heading', { name: 'Functions', exact: true })).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('verify page description and toolbar', async () => {
      await expect(page.getByText('Serverless functions in your repository')).toBeVisible();

      await expect(page.getByRole('link', { name: 'Create new function' })).toBeVisible();

      await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    });

    await test.step('verify table columns', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });

      for (const col of ['Name', 'Namespace', 'Runtime', 'Status', 'URL', 'Replicas', 'Actions']) {
        await expect(grid.getByRole('columnheader', { name: col, exact: true })).toBeVisible();
      }
    });

    await test.step('verify preseeded function row', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`);
      await expect(row).toBeVisible();
      await expect(row.getByText('NotDeployed')).toBeVisible();
      await expect(row.getByRole('button', { name: 'Edit' })).toBeEnabled();
      await expect(row.getByRole('button', { name: 'Delete' })).toBeDisabled();
    });

    await test.step('refresh re-fetches the list', async () => {
      const refreshBtn = page.getByRole('button', { name: 'Refresh' });
      await refreshBtn.click();

      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`);
      await expect(row).toBeVisible({ timeout: 15_000 });
    });

    await test.step('click Edit navigates to edit page', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`);
      await row.getByRole('button', { name: 'Edit' }).click();

      await expect(page).toHaveURL(/\/faas\/edit\//, { timeout: 10_000 });
      await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('click Create new function navigates to create page', async () => {
      await navigateToFunctionsList(page);
      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });

      await page.getByRole('link', { name: 'Create new function' }).click();
      await expect(page).toHaveURL(/\/faas\/create/, { timeout: 10_000 });
    });
  });
});
