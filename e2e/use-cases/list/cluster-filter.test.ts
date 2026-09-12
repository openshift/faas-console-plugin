import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { E2E_USER, PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE } from '../../helpers/constants';
import { deleteRepoOnFakeGithub, seedRepo } from '../../helpers/fakegithub';

const OTHER_CLUSTER_REPO = 'func-from-other-cluster';
const RUNTIME = 'go';
const OTHER_CLUSTER_API_URL = 'https://api.other-cluster.example.com:6443';

test.describe('Cluster filter', () => {
  test.beforeAll(async () => {
    await seedRepo(
      E2E_USER,
      OTHER_CLUSTER_REPO,
      'main',
      ['serverless-function'],
      [
        {
          path: 'func.yaml',
          mode: '100644',
          content: `name: ${OTHER_CLUSTER_REPO}\nruntime: ${RUNTIME}\nnamespace: ${PRESEEDED_FUNC_NAMESPACE}\n`,
        },
      ],
      { CLUSTER_API_URL: OTHER_CLUSTER_API_URL },
    );
  });

  test.afterAll(async () => {
    await deleteRepoOnFakeGithub(E2E_USER, OTHER_CLUSTER_REPO);
  });

  test('does not show functions whose CLUSTER_API_URL points to a different cluster', async ({
    page,
  }) => {
    await test.step('navigate to functions list', async () => {
      await navigateToFunctionsList(page);
    });

    await test.step('verify the preseeded function is visible', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });
      await expect(
        grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`),
      ).toBeVisible();
    });

    await test.step('verify the other-cluster repo is absent', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(
        grid.locator(`tbody tr:has(td:text-is("${OTHER_CLUSTER_REPO}"))`),
      ).not.toBeVisible();
    });
  });
});
