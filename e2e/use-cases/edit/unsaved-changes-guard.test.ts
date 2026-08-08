import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToEditPage } from '../../helpers/navigation';
import { PRESEEDED_FUNC_NAME } from '../../mocks/backend-api';

test.describe('Unsaved changes guard', () => {
  test('modal prevents accidental navigation loss', async ({ page }) => {
    await test.step('navigate to edit page', async () => {
      await navigateToEditPage(page, PRESEEDED_FUNC_NAME);
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('index.js')).toBeVisible({ timeout: 15_000 });
    });

    await test.step('back without changes navigates directly', async () => {
      await page.getByRole('button', { name: 'Back to Functions' }).click();
      await expect(page).toHaveURL(/\/faas$/, { timeout: 10_000 });
    });

    await test.step('return to edit page and make changes', async () => {
      await navigateToEditPage(page, PRESEEDED_FUNC_NAME);
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('index.js')).toBeVisible({ timeout: 15_000 });

      const editor = page.locator('.monaco-editor');
      await editor.first().click();
      await page.keyboard.type('// edited');

      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeEnabled({
        timeout: 5_000,
      });
    });

    await test.step('back with changes shows modal, Stay keeps editing', async () => {
      await page.getByRole('button', { name: 'Back to Functions' }).click();

      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible({ timeout: 5_000 });
      await expect(modal).toContainText('Unsaved changes');
      await expect(modal).toContainText('You have unsaved changes. Leave anyway?');

      await modal.getByRole('button', { name: 'Stay' }).click();
      await expect(modal).not.toBeVisible({ timeout: 5_000 });
      await expect(page).toHaveURL(/\/faas\/edit\//);
    });

    await test.step('back with changes shows modal, Leave navigates away', async () => {
      await page.getByRole('button', { name: 'Back to Functions' }).click();

      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible({ timeout: 5_000 });

      await modal.getByRole('button', { name: 'Leave' }).click();
      await expect(page).toHaveURL(/\/faas$/, { timeout: 10_000 });
    });
  });
});
