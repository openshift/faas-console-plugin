import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { resetFakeGithub, seedRepo } from '../../helpers/fakegithub';
import { E2E_USER, PRESEEDED_FUNC_NAME } from '../../helpers/constants';

test.describe('Functions list empty state', () => {
  test.beforeEach(async () => {
    await resetFakeGithub();
  });

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
          content: `name: ${PRESEEDED_FUNC_NAME}\nruntime: node\nnamespace: default\n`,
        },
        {
          path: 'index.js',
          mode: '100644',
          content: 'module.exports = async (context) => context;',
        },
      ],
    );
  });

  test('shows empty state when no functions exist', async ({ page }) => {
    await test.step('navigate to functions list', async () => {
      await navigateToFunctionsList(page);
    });

    await test.step('verify empty state', async () => {
      await expect(page.getByRole('heading', { name: 'No functions found' })).toBeVisible({
        timeout: 15_000,
      });

      await expect(page.getByText('Create a serverless function to get started.')).toBeVisible();

      await expect(page.getByRole('link', { name: 'Create function' })).toBeVisible();
    });
  });
});
