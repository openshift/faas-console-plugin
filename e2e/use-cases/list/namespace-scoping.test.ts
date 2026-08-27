import { test, expect } from '../../fixtures/authenticated-page';
import { ensureNamespace } from '../../helpers/cluster';
import { deleteRepoOnFakeGithub, seedRepo } from '../../helpers/fakegithub';
import {
  selectAllNamespaces,
  selectNamespace,
  navigateToFunctionsList,
} from '../../helpers/navigation';
import { E2E_USER, PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE } from '../../helpers/constants';

const ALT_FUNC_NAME = 'ns-scoping-alt-func';
const ALT_NS = 'alt-test-namespace';

test.describe('Namespace scoping', () => {
  test.beforeAll(async () => {
    await seedRepo(
      E2E_USER,
      ALT_FUNC_NAME,
      'main',
      ['serverless-function'],
      [
        {
          path: 'func.yaml',
          mode: '100644',
          content: `name: ${ALT_FUNC_NAME}\nruntime: node\nnamespace: ${ALT_NS}\n`,
        },
        {
          path: 'index.js',
          mode: '100644',
          content: 'module.exports = async (context) => context;',
        },
      ],
    );
  });

  test.afterAll(async () => {
    await deleteRepoOnFakeGithub(E2E_USER, ALT_FUNC_NAME);
  });

  test('namespace scoping filters functions correctly', async ({ page }) => {
    await test.step('set up namespaces and navigate to functions list', async () => {
      await ensureNamespace(page, PRESEEDED_FUNC_NAMESPACE);
      await ensureNamespace(page, ALT_NS);
      await navigateToFunctionsList(page);
      await page.getByRole('grid', { name: 'Functions' }).waitFor({ timeout: 30_000 });
    });

    await test.step('all-namespaces view shows functions from all namespaces', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });

      await expect(
        grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`),
      ).toBeVisible();
      await expect(grid.locator(`tbody tr:has(td:text-is("${ALT_FUNC_NAME}"))`)).toBeVisible();
    });

    await test.step(`switch to "${PRESEEDED_FUNC_NAMESPACE}" namespace and verify only its function is shown`, async () => {
      await selectNamespace(page, PRESEEDED_FUNC_NAMESPACE);

      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });

      await expect(
        grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`),
      ).toBeVisible();
      await expect(grid.locator(`tbody tr:has(td:text-is("${ALT_FUNC_NAME}"))`)).not.toBeVisible();
    });

    await test.step(`switch to "${ALT_NS}" namespace and verify only its function is shown`, async () => {
      await selectNamespace(page, ALT_NS);

      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });

      await expect(grid.locator(`tbody tr:has(td:text-is("${ALT_FUNC_NAME}"))`)).toBeVisible();
      await expect(
        grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`),
      ).not.toBeVisible();
    });

    await test.step('switching back to all-namespaces restores both functions', async () => {
      await selectAllNamespaces(page);

      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });

      await expect(
        grid.locator(`tbody tr:has(td:text-is("${PRESEEDED_FUNC_NAME}"))`),
      ).toBeVisible();
      await expect(grid.locator(`tbody tr:has(td:text-is("${ALT_FUNC_NAME}"))`)).toBeVisible();
    });
  });
});
