import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToEditPage } from '../../helpers/navigation';
import { PRESEEDED_FUNC_NAME } from '../../mocks/github';

test.describe('Save failure', () => {
  test('error alert appears when save fails', async ({ page }) => {
    await test.step('override GitHub mock to fail on commit creation', async () => {
      await page.route('https://api.github.com/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === 'POST' && /\/git\/commits$/.test(path)) {
          return route.fulfill({
            status: 500,
            json: { message: 'Internal Server Error' },
          });
        }
        return route.fallback();
      });
    });

    await test.step('navigate to edit page', async () => {
      await navigateToEditPage(page, PRESEEDED_FUNC_NAME);
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('index.js')).toBeVisible({ timeout: 15_000 });
    });

    await test.step('edit file content', async () => {
      const editor = page.locator('.monaco-editor');
      await editor.first().click();
      await page.keyboard.type('// trigger save');

      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeEnabled({
        timeout: 5_000,
      });
    });

    await test.step('save and verify error alert', async () => {
      await page.getByRole('button', { name: 'Save & Deploy' }).click();

      await expect(page.getByRole('heading', { name: /Danger alert:/ })).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('save button remains enabled for retry', async () => {
      await expect(page.getByRole('button', { name: 'Save & Deploy' })).toBeEnabled();
    });
  });
});
