import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { deleteRepoOnFakeGithub, seedRepo, setWorkflowRun } from '../../helpers/fakegithub';
import { E2E_USER } from '../../helpers/constants';

const FUNC_NAME = 'build-status-func';
const BRANCH = 'main';
const FAILURE_REASON = 'build / go test';

test.describe('Build status', () => {
  test.beforeEach(async () => {
    await seedRepo(
      E2E_USER,
      FUNC_NAME,
      BRANCH,
      ['serverless-function'],
      [
        {
          path: 'func.yaml',
          mode: '100644',
          content: `name: ${FUNC_NAME}\nruntime: node\nnamespace: default\n`,
        },
      ],
    );
  });

  test.afterEach(async () => {
    await deleteRepoOnFakeGithub(E2E_USER, FUNC_NAME);
  });

  test('reflects an in-progress run then a failure over SSE', async ({ page }) => {
    await test.step('script an in-progress run', async () => {
      await setWorkflowRun(E2E_USER, FUNC_NAME, BRANCH, {
        headSha: 'sha-building',
        status: 'in_progress',
      });
    });

    await test.step('navigate to functions list and verify Building', async () => {
      await navigateToFunctionsList(page);
      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });

      const row = grid.locator(`tbody tr:has(td:text-is("${FUNC_NAME}"))`);
      await expect(row).toBeVisible();
      await expect(row.getByText('Building')).toBeVisible({ timeout: 20_000 });
    });

    await test.step('script a failing run and verify BuildFailed updates over SSE', async () => {
      // The list streams over SSE (~3s poll cadence), so the status should update
      // without a manual refresh.
      await setWorkflowRun(E2E_USER, FUNC_NAME, BRANCH, {
        headSha: 'sha-failed',
        status: 'completed',
        conclusion: 'failure',
        jobs: [
          {
            id: 1,
            name: 'build',
            status: 'completed',
            conclusion: 'failure',
            steps: [
              { name: 'checkout', status: 'completed', conclusion: 'success', number: 1 },
              { name: 'go test', status: 'completed', conclusion: 'failure', number: 2 },
            ],
          },
        ],
      });

      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${FUNC_NAME}"))`);
      await expect(row.getByText('BuildFailed')).toBeVisible({ timeout: 20_000 });
    });

    await test.step('verify a link to the run and the failure reason', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${FUNC_NAME}"))`);

      const runLink = row.locator('a[href*="/actions/runs/"]');
      await expect(runLink).toBeVisible();

      // The failure reason is surfaced via a tooltip on the status badge.
      await runLink.hover();
      await expect(page.getByRole('tooltip')).toContainText(FAILURE_REASON, { timeout: 20_000 });
    });
  });
});
