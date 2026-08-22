import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { E2E_USER } from '../../helpers/constants';
import { seedRepo, deleteRepoOnFakeGithub } from '../../helpers/fakegithub';

const BROKEN_REPO = 'broken-func-yaml-repo';

test.describe('Broken func.yaml', () => {
  test.beforeEach(async () => {
    await seedRepo(
      E2E_USER,
      BROKEN_REPO,
      'main',
      ['serverless-function'],
      [
        {
          path: 'func.yaml',
          mode: '100644',
          content: '}{not yaml',
        },
      ],
    );
  });

  test.afterEach(async () => {
    await deleteRepoOnFakeGithub(E2E_USER, BROKEN_REPO);
  });

  test('shows Error status for a repo with invalid func.yaml', async ({ page }) => {
    await test.step('navigate to functions list', async () => {
      await navigateToFunctionsList(page);
    });

    await test.step('verify the broken repo row shows Error status', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });

      const row = grid.locator(`tbody tr:has(td:text-is("${BROKEN_REPO}"))`);
      await expect(row).toBeVisible();
      await expect(row.getByText('Error')).toBeVisible();
    });

    await test.step('verify name falls back to repo name', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${BROKEN_REPO}"))`);
      await expect(row.locator('td').first()).toHaveText(BROKEN_REPO);
    });

    await test.step('verify namespace and runtime show placeholder values', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      const row = grid.locator(`tbody tr:has(td:text-is("${BROKEN_REPO}"))`);
      // Namespace and runtime both show an em dash via TextOrDash when empty
      await expect(row.locator('td[data-label="Namespace"]')).toHaveText('\u2014');
      await expect(row.locator('td[data-label="Runtime"]')).toHaveText('\u2014');
    });
  });
});
