import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { PRESEEDED_FUNC_NAME } from '../../mocks/github';
import {
  deploymentApiPath,
  ensureNamespace,
  k8sHeaders,
  ksvcApiPath,
  simulateGitHubActionsDeploy,
} from '../../helpers/cluster';

const NAMESPACE = 'delete-test';
test.describe('Delete function', () => {
  test.describe.configure({ mode: 'serial' });

  test('delete button is disabled for not deployed functions', async ({ page }) => {
    await navigateToFunctionsList(page);

    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    const row = grid.locator('tbody tr').filter({ hasText: PRESEEDED_FUNC_NAME });
    await expect(row.getByText('NotDeployed')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  test('delete button removes function from cluster', async ({ page }) => {
    test.setTimeout(600_000);

    await test.step('make sure deletion target function is deployed in cluster', async () => {
      await ensureNamespace(page, NAMESPACE);
      await simulateGitHubActionsDeploy(page, PRESEEDED_FUNC_NAME, NAMESPACE);
    });

    await test.step('navigate to list page', async () => {
      await navigateToFunctionsList(page);

      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });
    });

    await test.step('undeploy function', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`);
      const deleteBtn = row.getByRole('button', { name: 'Delete' });
      await expect(deleteBtn).toBeEnabled({ timeout: 30_000 });
      await deleteBtn.click();

      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible({ timeout: 5_000 });
      await modal.getByRole('button', { name: /undeploy/i }).click();
      await expect(modal).not.toBeVisible({ timeout: 10_000 });
    });

    await test.step('verify function is removed from cluster', async () => {
      const headers = await k8sHeaders(page);

      const ksvcRes = await page.request.get(`${ksvcApiPath(NAMESPACE)}/${PRESEEDED_FUNC_NAME}`, {
        headers,
      });
      expect(ksvcRes.status()).toBe(404);

      const depRes = await page.request.get(
        `${deploymentApiPath(NAMESPACE)}?labelSelector=function.knative.dev/name=${PRESEEDED_FUNC_NAME}`,
        { headers },
      );
      const body = await depRes.json();
      expect(body.items?.length ?? 0).toBe(0);
    });

    await test.step('verify function shows as not deployed in the UI', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`);
      await expect(row.getByText('NotDeployed')).toBeVisible({ timeout: 30_000 });
    });
  });
});
