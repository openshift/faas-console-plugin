import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToEditPage } from '../../helpers/navigation';
import { E2E_USER, PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE } from '../../helpers/constants';
import { deleteRepoOnFakeGithub, seedRepo } from '../../helpers/fakegithub';

test.describe('Save failure', () => {
  test.afterEach(async () => {
    await seedRepo(
      E2E_USER,
      PRESEEDED_FUNC_NAME,
      'main',
      ['serverless-function'],
      [
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
      ],
    );
  });

  test('error alert appears when save fails', async ({ page }) => {
    await test.step('navigate to edit page', async () => {
      await navigateToEditPage(page, PRESEEDED_FUNC_NAME);
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('index.js')).toBeVisible({ timeout: 15_000 });
    });

    await test.step('delete repo on fake GitHub to cause save failure', async () => {
      await deleteRepoOnFakeGithub(E2E_USER, PRESEEDED_FUNC_NAME);
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
