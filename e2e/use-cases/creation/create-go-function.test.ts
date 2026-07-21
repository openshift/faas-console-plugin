import { test, expect } from '../../fixtures/authenticated-page';
import { Request } from '@playwright/test';
import { navigateToCreatePage } from '../../helpers/navigation';
import { ensureNamespace, simulateGitHubActionsDeploy } from '../../helpers/cluster';

const FUNC_NAME = 'test-func';
const NAMESPACE = 'create-test';
const BRANCH = 'main';
const REGISTRY_PREFIX = 'image-registry.openshift-image-registry.svc:5000/';

test.describe('Create go function', () => {
  test('user creates a go function and is redirected to the overview', async ({ page }) => {
    test.setTimeout(600_000);

    // Track GitHub API calls so we can assert the repo creation POST was made
    const githubRequests: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('api.github.com')) {
        githubRequests.push(req);
      }
    });

    await test.step('ensure namespace exists', async () => {
      await ensureNamespace(page, NAMESPACE);
    });

    await test.step('navigate to the create page', async () => {
      await navigateToCreatePage(page);
      await expect(page).toHaveURL(/\/faas\/create/);
    });

    await test.step('verify all form fields are present', async () => {
      await expect(page.locator('#owner')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#repo')).toBeVisible();
      await expect(page.locator('#branch')).toBeVisible();
      await expect(page.locator('#name')).toBeVisible();
      await expect(page.locator('#runtime')).toBeVisible();
      await expect(page.locator('#registry')).toBeVisible();
      await expect(page.locator('#namespace')).toBeVisible();
    });

    await test.step('verify submit button is disabled with empty form', async () => {
      const submitBtn = page.getByRole('button', { name: 'Create', exact: true });
      await expect(submitBtn).toBeVisible();
      await expect(submitBtn).toBeDisabled();
    });

    await test.step('verify owner is auto-populated and disabled', async () => {
      const owner = page.locator('#owner');
      await expect(owner).not.toHaveValue('');
      await expect(owner).toBeDisabled();
    });

    await test.step('fill in function details', async () => {
      await page.locator('#repo').fill(FUNC_NAME);
      await page.locator('#branch').fill(BRANCH);
      await page.locator('#name').fill(FUNC_NAME);
      await page.locator('#runtime').selectOption('go');
      await page.locator('#namespace').fill(NAMESPACE);
    });

    await test.step('verify namespace updates the registry field', async () => {
      const registry = page.locator('#registry');
      await expect(registry).toHaveValue(`${REGISTRY_PREFIX}${NAMESPACE}`);
      await expect(registry).toBeDisabled();
    });

    await test.step('verify submit button is enabled after filling all fields', async () => {
      const submitBtn = page.getByRole('button', { name: 'Create', exact: true });
      await expect(submitBtn).toBeEnabled();
    });

    await test.step('submit and verify redirect to overview', async () => {
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page).toHaveURL(/\/faas$/, { timeout: 30_000 });
    });

    await test.step('verify GitHub repo creation route was hit', async () => {
      const repoCreated = githubRequests.some(
        (r) => r.url().includes('/user/repos') && r.method() === 'POST',
      );
      expect(repoCreated).toBe(true);
    });

    await test.step('simulate GitHub Actions deployment', async () => {
      await simulateGitHubActionsDeploy(page, FUNC_NAME, NAMESPACE);
    });

    await test.step('verify function shows as deployed in the UI', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });

      const row = grid.locator(`tbody tr:has(td:text-is("${FUNC_NAME}"))`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByText(/Running|ScaledToZero/)).toBeVisible({ timeout: 30_000 });
    });
  });
});
