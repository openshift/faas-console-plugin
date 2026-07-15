import { test, expect } from '@playwright/test';
import { navigateToEditPage } from '../../helpers';

test.describe('Edit function', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToEditPage(page);
  });

  test('opens edit page with correct layout', async ({ page }) => {
    await expect(page).toHaveURL(/\/faas\/edit\//);
    await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible();

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

  test('loads file tree with handler auto-selected', async ({ page }) => {
    await test.step('file tree shows files', async () => {
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree).toBeVisible({ timeout: 30_000 });
      const items = tree.getByRole('treeitem');
      expect(await items.count()).toBeGreaterThan(0);
    });

    await test.step('a handler file is auto-selected', async () => {
      const selectedItem = page.getByRole('treeitem', { selected: true });
      await expect(selectedItem).toBeVisible();
    });
  });

  test('switching files updates editor content', async ({ page }) => {
    const tree = page.getByRole('tree', { name: 'File tree' });
    await expect(tree).toBeVisible({ timeout: 30_000 });

    await tree.getByRole('treeitem', { selected: true }).waitFor({ timeout: 30_000 });

    const fileItems = tree.locator('[role="treeitem"]:not(:has([role="group"]))');
    const fileCount = await fileItems.count();
    test.skip(fileCount < 2, `repo has only ${fileCount} file(s), switching requires at least 2`);

    const editor = page.locator('.monaco-editor');
    await expect(editor).toBeVisible({ timeout: 10_000 });

    const autoSelectedContent = await page.locator('.monaco-editor .view-lines').textContent();

    const otherFile = tree
      .locator('[role="treeitem"]:not(:has([role="group"])):not([aria-selected="true"])')
      .first();

    await test.step('click a different file and verify content changes', async () => {
      await otherFile.click();
      await page.waitForFunction(
        (prev: string | null) => {
          const el = document.querySelector('.monaco-editor .view-lines');
          return el && el.textContent !== prev;
        },
        autoSelectedContent,
        { timeout: 10_000 },
      );
    });
  });

  test('editing shows dirty indicator and enables save', async ({ page }) => {
    const tree = page.getByRole('tree', { name: 'File tree' });
    await expect(tree).toBeVisible({ timeout: 30_000 });

    const saveBtn = page.getByRole('button', { name: 'Save & Deploy' });
    await expect(saveBtn).toBeDisabled();

    await test.step('type into the editor', async () => {
      const editor = page.locator('.monaco-editor');
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await editor.click();
      await page.keyboard.type('// edited');
    });

    await test.step('dirty indicator appears on the modified file', async () => {
      await expect(tree.getByRole('treeitem', { name: /●/ })).toBeVisible({
        timeout: 5_000,
      });
    });

    await test.step('save button becomes enabled', async () => {
      await expect(saveBtn).toBeEnabled();
    });
  });

  test('save and deploy pushes changes and shows success alert', async ({ page }) => {
    const tree = page.getByRole('tree', { name: 'File tree' });
    await expect(tree).toBeVisible({ timeout: 30_000 });

    const editor = page.locator('.monaco-editor');
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await editor.click();
    await page.keyboard.type('// save test');

    const saveBtn = page.getByRole('button', { name: 'Save & Deploy' });
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();

    await expect(page.getByText('Pushed to GitHub. Deployment running...')).toBeVisible({
      timeout: 10_000,
    });

    await expect(page.getByText('Pushed to GitHub. Deployment running...')).toBeHidden({
      timeout: 5_000,
    });

    await expect(saveBtn).toBeDisabled();
  });

  test('unsaved changes modal blocks navigation', async ({ page }) => {
    const tree = page.getByRole('tree', { name: 'File tree' });
    await expect(tree).toBeVisible({ timeout: 30_000 });

    const editor = page.locator('.monaco-editor');
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await editor.click();
    await page.keyboard.type('// unsaved');

    await test.step('clicking back opens the leave modal', async () => {
      await page.getByRole('button', { name: 'Back to Functions' }).click();
      await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByText('You have unsaved changes. Leave anyway?')).toBeVisible();
    });

    await test.step('stay keeps you on the edit page', async () => {
      await page.getByRole('button', { name: 'Stay' }).click();
      await expect(page.getByText('Unsaved changes', { exact: true })).toBeHidden();
      await expect(page).toHaveURL(/\/faas\/edit\//);
    });

    await test.step('leave navigates to the list page', async () => {
      await page.getByRole('button', { name: 'Back to Functions' }).click();
      await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole('button', { name: 'Leave' }).click();
      await expect(page).toHaveURL(/\/faas$/, { timeout: 10_000 });
    });
  });
});
