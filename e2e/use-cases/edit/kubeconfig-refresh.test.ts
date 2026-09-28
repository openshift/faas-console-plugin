import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToEditPage } from '../../helpers/navigation';
import { E2E_USER } from '../../helpers/constants';
import { ensureNamespace, ensureServiceAccount, deleteFunction } from '../../helpers/cluster';
import {
  deleteRepoOnFakeGithub,
  getRepoVariable,
  nodeFunctionFiles,
  seedRepo,
} from '../../helpers/fakegithub';
import type { Page } from '@playwright/test';

// Dedicated repo/namespace so the near-expiry credential does not affect other
// edit tests, which rely on the default (non-expiring) KUBECONFIG_EXPIRE_AT to
// skip the refresh path.
const FUNC_NAME = 'refresh-test-func';
const NAMESPACE = 'refresh-test';
const BRANCH = 'main';
const DEPLOY_SA = 'func-scm';
const EXPIRE_VAR = 'KUBECONFIG_EXPIRE_AT';

// editAndSave appends a marker to the open file and saves, verifying the push
// succeeds and the button returns to its clean (disabled) state.
async function editAndSave(page: Page, marker: string): Promise<void> {
  const editor = page.locator('.monaco-editor');
  await editor.first().click();
  await page.keyboard.type(marker);

  const saveButton = page.getByRole('button', { name: 'Save & Deploy' });
  await expect(saveButton).toBeEnabled({ timeout: 5_000 });
  await saveButton.click();
  await expect(
    page.getByText('Pushed to GitHub. Build and deploy workflow run initiated.'),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(saveButton).toBeDisabled({ timeout: 5_000 });
}

test.describe('Kubeconfig refresh', () => {
  test.afterEach(async ({ page }) => {
    await deleteFunction(page, FUNC_NAME, NAMESPACE);
    await deleteRepoOnFakeGithub(E2E_USER, FUNC_NAME);
  });

  test('refreshes a near-expiry credential, then skips refresh on the next save', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // One hour out is inside the refresh window, so the first save must issue a fresh token.
    const nearExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let refreshed = '';

    await test.step('set up cluster SA and a near-expiry seeded repo', async () => {
      await ensureNamespace(page, NAMESPACE);
      await ensureServiceAccount(page, NAMESPACE, DEPLOY_SA);
      await seedRepo(
        E2E_USER,
        FUNC_NAME,
        BRANCH,
        ['serverless-function'],
        nodeFunctionFiles(FUNC_NAME, NAMESPACE),
        {
          [EXPIRE_VAR]: nearExpiry,
        },
      );
    });

    await test.step('open the edit page', async () => {
      await navigateToEditPage(page, FUNC_NAME);
      await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible({
        timeout: 10_000,
      });
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('index.js')).toBeVisible({ timeout: 15_000 });
    });

    await test.step('save and verify the credential was refreshed to a future timestamp', async () => {
      await editAndSave(page, '// trigger credential refresh');

      refreshed = await getRepoVariable(E2E_USER, FUNC_NAME, EXPIRE_VAR);
      expect(Date.parse(refreshed)).toBeGreaterThan(Date.parse(nearExpiry));
      // A freshly issued token lasts well beyond the refresh window.
      expect(Date.parse(refreshed) - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
    });

    await test.step('save again and verify the credential is not refreshed a second time', async () => {
      await editAndSave(page, '// second save, no refresh expected');

      const afterSecondSave = await getRepoVariable(E2E_USER, FUNC_NAME, EXPIRE_VAR);
      // The credential is now far from expiry, so the second save is a plain
      // commit that must leave the stored expiration untouched.
      expect(afterSecondSave).toBe(refreshed);
    });
  });
});
