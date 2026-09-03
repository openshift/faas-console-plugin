import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE } from '../../helpers/constants';
import {
  deleteFunction,
  deploymentApiPath,
  ensureNamespace,
  k8sHeaders,
  ksvcApiPath,
  simulateGitHubActionsDeploy,
} from '../../helpers/cluster';

const RUNTIME = 'node';
test.describe('Delete function', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await deleteFunction(page, PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE);
  });

  test('undeploy button is disabled for not deployed functions', async ({ page }) => {
    await navigateToFunctionsList(page);

    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    const row = grid.locator('tbody tr').filter({ hasText: PRESEEDED_FUNC_NAME });
    await expect(row.getByText('NotDeployed')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Undeploy' })).toBeDisabled();
  });

  test('undeploy button removes function from cluster', async ({ page }) => {
    test.setTimeout(600_000);

    await test.step('make sure deletion target function is deployed in cluster', async () => {
      await ensureNamespace(page, PRESEEDED_FUNC_NAMESPACE);
      await simulateGitHubActionsDeploy(
        page,
        PRESEEDED_FUNC_NAME,
        PRESEEDED_FUNC_NAMESPACE,
        RUNTIME,
      );
    });

    await test.step('navigate to list page', async () => {
      await navigateToFunctionsList(page);

      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });
    });

    await test.step('undeploy function', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`);
      const undeployBtn = row.getByRole('button', { name: 'Undeploy' });
      await expect(undeployBtn).toBeEnabled({ timeout: 30_000 });
      await undeployBtn.click();

      const modal = page.getByRole('dialog');
      await expect(modal).toBeVisible({ timeout: 5_000 });
      await modal.getByRole('button', { name: /undeploy/i }).click();
      await expect(modal).not.toBeVisible({ timeout: 10_000 });
    });

    await test.step('verify function is removed from cluster', async () => {
      const headers = await k8sHeaders(page);

      await expect
        .poll(
          async () =>
            (
              await page.request.get(
                `${ksvcApiPath(PRESEEDED_FUNC_NAMESPACE)}/${PRESEEDED_FUNC_NAME}`,
                {
                  headers,
                },
              )
            ).status(),
          { timeout: 30_000, intervals: [2_000] },
        )
        .toBe(404);

      await expect
        .poll(
          async () => {
            const depRes = await page.request.get(
              `${deploymentApiPath(PRESEEDED_FUNC_NAMESPACE)}?labelSelector=function.knative.dev/name=${PRESEEDED_FUNC_NAME}`,
              { headers },
            );
            const body = await depRes.json();
            return body.items?.length ?? 0;
          },
          { timeout: 30_000, intervals: [2_000] },
        )
        .toBe(0);
    });

    await test.step('verify function shows as not deployed in the UI', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`);
      await expect(row.getByText('NotDeployed')).toBeVisible({ timeout: 30_000 });
    });
  });
});
