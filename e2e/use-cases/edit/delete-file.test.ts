import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToEditPage } from '../../helpers/navigation';
import { E2E_USER, PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE } from '../../helpers/constants';
import { seedRepo } from '../../helpers/fakegithub';

const BASE_FILES = [
  {
    path: 'func.yaml',
    mode: '100644',
    content: `name: ${PRESEEDED_FUNC_NAME}\nruntime: node\nnamespace: ${PRESEEDED_FUNC_NAMESPACE}\n`,
  },
  {
    path: 'index.js',
    mode: '100644',
    content: 'module.exports = async (context) => context;',
  },
];

test.beforeEach(async () => {
  await seedRepo(
    E2E_USER,
    PRESEEDED_FUNC_NAME,
    'main',
    ['serverless-function'],
    [
      ...BASE_FILES,
      { path: 'delete-me.txt', mode: '100644', content: 'temporary file for deletion tests' },
    ],
  );
});

test.afterEach(async () => {
  await seedRepo(E2E_USER, PRESEEDED_FUNC_NAME, 'main', ['serverless-function'], BASE_FILES);
});

test.describe('Delete file', () => {
  test('user deletes a file and saves the changes', async ({ page }) => {
    await test.step('navigate to edit page', async () => {
      await navigateToEditPage(page, PRESEEDED_FUNC_NAME);
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('delete-me.txt')).toBeVisible({ timeout: 15_000 });
    });

    await test.step('verify save button is disabled before changes', async () => {
      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeDisabled();
    });

    await test.step('hover to reveal action button and delete the file', async () => {
      const tree = page.getByRole('tree', { name: 'File tree' });
      await tree.getByText('delete-me.txt', { exact: true }).hover();
      await page.getByRole('button', { name: 'delete-me.txt actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete File' }).click();
    });

    await test.step('verify delete-me.txt is removed from the tree', async () => {
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('delete-me.txt')).not.toBeVisible();
    });

    await test.step('verify save button is enabled after deletion', async () => {
      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeEnabled();
    });

    await test.step('save and verify success', async () => {
      await page.getByRole('button', { name: 'Save & Deploy' }).click();

      await expect(page.getByText('Pushed to GitHub. Deployment running...')).toBeVisible({
        timeout: 10_000,
      });

      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeDisabled({
        timeout: 5_000,
      });
    });
  });

  test('deleting the selected file clears the editor', async ({ page }) => {
    await test.step('navigate to edit page and select delete-me.txt', async () => {
      await navigateToEditPage(page, PRESEEDED_FUNC_NAME);
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('delete-me.txt')).toBeVisible({ timeout: 15_000 });
      await tree.getByText('delete-me.txt', { exact: true }).click();
      await expect(page.locator('.monaco-editor').first()).toContainText('temporary file', {
        timeout: 5_000,
      });
    });

    await test.step('delete the selected file', async () => {
      const tree = page.getByRole('tree', { name: 'File tree' });
      await tree.getByText('delete-me.txt', { exact: true }).hover();
      await page.getByRole('button', { name: 'delete-me.txt actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete File' }).click();
    });

    await test.step('verify the editor empty state is shown', async () => {
      await expect(page.getByRole('heading', { name: 'Start editing' })).toBeVisible({
        timeout: 5_000,
      });
    });
  });
});
