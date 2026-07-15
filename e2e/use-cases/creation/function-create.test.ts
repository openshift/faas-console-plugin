import { test, expect } from '@playwright/test';
import {
  injectGitHubPat,
  navigateToCreatePage,
  navigateToFunctionsList,
  waitForTableOrEmpty,
} from '../../helpers';

test.describe('Create function', () => {
  test('navigates to create page from list', async ({ page }) => {
    await navigateToFunctionsList(page);
    const result = await waitForTableOrEmpty(page);

    const createBtn =
      result === 'table'
        ? page.getByRole('link', { name: 'Create new function' })
        : page.getByRole('link', { name: 'Create function' });
    await createBtn.click();

    await expect(page).toHaveURL(/\/faas\/create/);
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('form has all required fields', async ({ page }) => {
    await navigateToCreatePage(page);

    await expect(page.locator('#owner')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#repo')).toBeVisible();
    await expect(page.locator('#branch')).toBeVisible();
    await expect(page.locator('#name')).toBeVisible();
    await expect(page.locator('#runtime')).toBeVisible();
    await expect(page.locator('#registry')).toBeVisible();
    await expect(page.locator('#namespace')).toBeVisible();
  });

  test('submit button is disabled until form is valid', async ({ page }) => {
    await navigateToCreatePage(page);

    const submitBtn = page.getByRole('button', { name: 'Create', exact: true });
    await expect(submitBtn).toBeVisible({ timeout: 10_000 });
    await expect(submitBtn).toBeDisabled();

    await page.locator('#repo').fill('e2e-test-fn');
    await page.locator('#branch').fill('main');
    await page.locator('#name').fill('e2e-test-fn');
    await page.locator('#namespace').fill('e2e-test-ns');

    await expect(submitBtn).toBeEnabled();
  });

  test('cancel button navigates back to list', async ({ page }) => {
    await navigateToCreatePage(page);

    const cancelBtn = page.getByRole('button', { name: 'Cancel' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();
    await expect(page).toHaveURL(/\/faas$/);
  });

  test('creates function and navigates to list on success', async ({ page, request }) => {
    await navigateToCreatePage(page);

    await test.step('owner is auto-populated and disabled', async () => {
      const owner = page.locator('#owner');
      await expect(owner).toBeVisible({ timeout: 10_000 });
      await expect(owner).not.toHaveValue('');
      await expect(owner).toBeDisabled();
    });

    await test.step('fill form and verify registry auto-update', async () => {
      await page.locator('#repo').fill('new-fn');
      await page.locator('#branch').fill('main');
      await page.locator('#name').fill('new-fn');
      await page.locator('#namespace').fill('default');

      const registry = page.locator('#registry');
      await expect(registry).toHaveValue(/default$/);
      await expect(registry).toBeDisabled();
    });

    await test.step('submit and navigate to list', async () => {
      const pat = process.env.BRIDGE_GITHUB_PAT;
      if (pat) {
        const userRes = await request.get('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${pat}` },
        });
        const { login } = await userRes.json();
        const repoRes = await request.get(`https://api.github.com/repos/${login}/new-fn`, {
          headers: { Authorization: `Bearer ${pat}` },
        });
        test.skip(repoRes.status() === 200, 'Repo "new-fn" already exists; run cleanup first');
      }

      const createBtn = page.getByRole('button', { name: 'Create', exact: true });
      await expect(createBtn).toBeEnabled();
      await createBtn.click();

      await expect(page).toHaveURL(/\/faas$/, { timeout: 30_000 });
    });
  });

  test('shows error when repository name already exists', async ({ page }) => {
    await injectGitHubPat(page);

    await page.route('https://api.github.com/repos/*/*', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: { name: 'existing-fn', default_branch: 'main' } });
      }
      return route.continue();
    });

    await navigateToCreatePage(page);

    const owner = page.locator('#owner');
    await expect(owner).toBeVisible({ timeout: 10_000 });

    await page.locator('#repo').fill('existing-fn');
    await page.locator('#branch').fill('main');
    await page.locator('#name').fill('existing-fn');
    await page.locator('#namespace').fill('default');

    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(page.getByText('Error creating function')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/exists, please choose a different name/)).toBeVisible();
    await expect(page).toHaveURL(/\/faas\/create/);
  });

  test('namespace change updates registry field', async ({ page }) => {
    await navigateToCreatePage(page);

    const registry = page.locator('#registry');
    await expect(registry).toBeVisible({ timeout: 10_000 });
    await expect(registry).toHaveValue('image-registry.openshift-image-registry.svc:5000/');

    await page.locator('#namespace').fill('test-ns');
    await expect(registry).toHaveValue('image-registry.openshift-image-registry.svc:5000/test-ns');

    await page.locator('#namespace').fill('other-ns');
    await expect(registry).toHaveValue('image-registry.openshift-image-registry.svc:5000/other-ns');
  });
});
