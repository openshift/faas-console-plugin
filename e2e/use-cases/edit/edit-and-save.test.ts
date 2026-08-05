import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToEditPage } from '../../helpers/navigation';
import { PRESEEDED_FUNC_NAME } from '../../mocks/backend-api';

test.describe('Edit function', () => {
  test('user views files, edits code, and saves changes', async ({ page }) => {
    await test.step('navigate to edit page', async () => {
      await navigateToEditPage(page, PRESEEDED_FUNC_NAME);
      await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('verify repo metadata', async () => {
      await expect(page.getByText(`e2e-user/${PRESEEDED_FUNC_NAME}`)).toBeVisible();
      await expect(page.getByRole('term').filter({ hasText: 'Branch' })).toBeVisible();
      await expect(page.getByRole('definition').filter({ hasText: 'main' })).toBeVisible();
    });

    await test.step('verify file tree loads with expected files', async () => {
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('func.yaml')).toBeVisible({ timeout: 15_000 });
      await expect(tree.getByText('index.js')).toBeVisible();
    });

    await test.step('verify handler file is auto-selected in editor', async () => {
      const editor = page.locator('.monaco-editor');
      await expect(editor.first()).toBeVisible({ timeout: 10_000 });
      await expect(editor.first()).toContainText('module.exports');
    });

    await test.step('verify save button is disabled before edits', async () => {
      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeDisabled();
    });

    await test.step('select func.yaml and verify editor updates', async () => {
      const tree = page.getByRole('tree', { name: 'File tree' });
      await tree.getByText('func.yaml', { exact: true }).click();

      const editor = page.locator('.monaco-editor');
      await expect(editor.first()).toContainText('runtime: node');
    });

    await test.step('edit file content', async () => {
      const editor = page.locator('.monaco-editor');
      await editor.first().click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('# edited by e2e test');
    });

    await test.step('verify save button enables after edit', async () => {
      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeEnabled({
        timeout: 5_000,
      });
    });

    await test.step('save changes and verify success', async () => {
      await page.getByRole('button', { name: 'Save & Deploy' }).click();

      await expect(page.getByText('Pushed to GitHub. Deployment running...')).toBeVisible({
        timeout: 10_000,
      });

      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeDisabled({
        timeout: 5_000,
      });
    });
  });
});
