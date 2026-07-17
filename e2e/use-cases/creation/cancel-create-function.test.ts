import { test, expect } from '../../fixtures/authenticated-page';
import { Request } from '@playwright/test';
import { navigateToCreatePage } from '../../helpers/navigation';

const FUNC_NAME = 'test-func';
const NAMESPACE = 'create-test';

test.describe('Cancel create function', () => {
  test('user cancels creation and no resources are created', async ({ page }) => {
    const githubRequests: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('api.github.com') && req.method() === 'POST') {
        githubRequests.push(req);
      }
    });

    await test.step('navigate to the create page', async () => {
      await navigateToCreatePage(page);
      await expect(page.locator('#owner')).toBeVisible({ timeout: 10_000 });
    });

    await test.step('partially fill the form', async () => {
      await page.locator('#repo').fill(FUNC_NAME);
      await page.locator('#name').fill(FUNC_NAME);
      await page.locator('#namespace').fill(NAMESPACE);
    });

    await test.step('click cancel and verify redirect to overview', async () => {
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page).toHaveURL(/\/faas$/);
    });

    await test.step('verify no GitHub repo creation request was made', async () => {
      const repoCreated = githubRequests.some((r) => r.url().includes('/user/repos'));
      expect(repoCreated).toBe(false);
    });
  });
});
