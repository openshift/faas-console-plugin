import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToCreatePage } from '../../helpers/navigation';
import { ensureNamespace } from '../../helpers/cluster';

const FUNC_NAME = 'test-func';
const NAMESPACE = 'create-test';
const BRANCH = 'main';

test.describe('Create duplicate function', () => {
  test('user sees an error when the function name already exists', async ({ page }) => {
    await test.step('ensure namespace exists', async () => {
      await ensureNamespace(page, NAMESPACE);
    });

    await test.step('override repo existence check to return 200', async () => {
      await page.route('https://api.github.com/repos/*/*', (route) => {
        if (route.request().method() === 'GET') {
          return route.fulfill({
            json: { name: FUNC_NAME, default_branch: BRANCH },
          });
        }
        return route.continue();
      });
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
      await expect(page.getByText(/exists, please choose a different name/)).toBeVisible();
    });

    await test.step('verify user stays on the create page', async () => {
      await expect(page).toHaveURL(/\/faas\/create/);
    });
  });
});
