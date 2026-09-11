import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { E2E_USER, PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE } from '../../helpers/constants';
import {
  deleteFunction,
  ensureNamespace,
  simulateGitHubActionsDeploy,
} from '../../helpers/cluster';
import { getDispatches } from '../../helpers/fakegithub';

const RUNTIME = 'node';

test.describe('Deploy function', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await deleteFunction(page, PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE);
  });

  test('deploy button dispatches the workflow for a not-deployed function', async ({ page }) => {
    test.setTimeout(600_000);

    const grid = page.getByRole('grid', { name: 'Functions' });
    const row = grid.locator('tbody tr').filter({ hasText: PRESEEDED_FUNC_NAME });

    await test.step('dispatch the deploy workflow from the list', async () => {
      await navigateToFunctionsList(page);
      await expect(grid).toBeVisible({ timeout: 30_000 });
      await expect(row.getByText('NotDeployed')).toBeVisible();

      const deployButton = row.getByRole('button', { name: 'Deploy' });
      await expect(deployButton).toBeEnabled();
      await deployButton.click();

      await expect(page.getByText(/Deploy started/i)).toBeVisible({ timeout: 10_000 });

      await expect
        .poll(async () => (await getDispatches()).length, { timeout: 10_000, intervals: [500] })
        .toBeGreaterThan(0);

      const dispatches = await getDispatches();
      const match = dispatches.find((d) => d.owner === E2E_USER && d.repo === PRESEEDED_FUNC_NAME);
      expect(match).toBeTruthy();
      expect(match?.workflow).toBe('func-deploy.yaml');
      expect(match?.ref).toBe('main');
    });

    await test.step('button flips to Undeploy once the function is deployed', async () => {
      // Simulate what the dispatched GitHub Actions workflow would do.
      await ensureNamespace(page, PRESEEDED_FUNC_NAMESPACE);
      await simulateGitHubActionsDeploy(
        page,
        PRESEEDED_FUNC_NAME,
        PRESEEDED_FUNC_NAMESPACE,
        RUNTIME,
      );

      await expect(row.getByRole('button', { name: 'Undeploy' })).toBeEnabled({ timeout: 30_000 });
      // Exact match: the default substring match would treat the "Undeploy"
      // button as a "Deploy" match, since "Undeploy" contains "deploy".
      await expect(row.getByRole('button', { name: 'Deploy', exact: true })).toHaveCount(0);
    });
  });
});
