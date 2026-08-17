import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToCreatePage } from '../../helpers/navigation';
import { ensureNamespace } from '../../helpers/cluster';
import { E2E_USER } from '../../helpers/constants';
import { deleteRepoOnFakeGithub, seedRepo } from '../../helpers/fakegithub';

const FUNC_NAME = 'duplicate-test-func';
const NAMESPACE = 'create-test';
const BRANCH = 'main';

test.describe('Create duplicate function', () => {
  test.beforeEach(async () => {
    await seedRepo(
      E2E_USER,
      FUNC_NAME,
      'main',
      [],
      [{ path: 'README.md', mode: '100644', content: '# duplicate-test-func\n' }],
    );
  });

  test.afterEach(async () => {
    await deleteRepoOnFakeGithub(E2E_USER, FUNC_NAME);
  });

  test('user sees an error when the function name already exists', async ({ page }) => {
    await test.step('ensure namespace exists', async () => {
      await ensureNamespace(page, NAMESPACE);
    });

    await test.step('navigate to the create page and fill the form', async () => {
      await navigateToCreatePage(page);
      await expect(page.locator('#owner')).toBeVisible({ timeout: 10_000 });

      await page.locator('#repo').fill(FUNC_NAME);
      await page.locator('#branch').fill(BRANCH);
      await page.locator('#name').fill(FUNC_NAME);

      await page.locator('#runtime').selectOption('go');

      await page.locator('#namespace').fill(NAMESPACE);
    });

    await test.step('submit and verify error is displayed', async () => {
      await page.getByRole('button', { name: 'Create', exact: true }).click();

      await expect(page.getByText('Error creating function')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/repository already exists/)).toBeVisible();
    });

    await test.step('verify user stays on the create page', async () => {
      await expect(page).toHaveURL(/\/faas\/create/);
    });
  });
});
