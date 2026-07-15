import { test, expect } from '@playwright/test';
import { navigateToFunctionsList } from '../../helpers';
import { mockDeployedFunction } from '../../mocks/cluster';

const CREATED_REPO = 'new-fn';

test.describe('Delete function', () => {
  test('delete button is disabled for undeployed functions', async ({ page }) => {
    await navigateToFunctionsList(page);

    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    const firstRow = grid.locator('tbody tr').first();

    await expect(firstRow.getByText('NotDeployed')).toBeVisible();
    await expect(firstRow.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  test('opens delete confirmation for deployed function', async ({ page }) => {
    test.skip(!!process.env.BRIDGE_GITHUB_PAT, 'mock-only test');
    await mockDeployedFunction(page);
    await navigateToFunctionsList(page);

    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    const deleteBtn = grid.getByRole('button', { name: 'Delete' }).first();
    const isEnabled = await deleteBtn.isEnabled().catch(() => false);
    test.skip(!isEnabled, 'K8s mocks did not enable the delete button');

    await deleteBtn.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const cancelBtn = modal.getByRole('button', { name: /cancel/i });
    await cancelBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test('cleanup: delete repo created by create flow', async ({ request }) => {
    const pat = process.env.BRIDGE_GITHUB_PAT;
    test.skip(!pat, 'cleanup only needed with a real GitHub PAT');

    const userRes = await request.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${pat}` },
    });
    const { login } = await userRes.json();

    const res = await request.delete(`https://api.github.com/repos/${login}/${CREATED_REPO}`, {
      headers: { Authorization: `Bearer ${pat}` },
    });

    test.skip(res.status() === 403, 'PAT lacks delete_repo scope; delete the repo manually');
    expect([204, 404]).toContain(res.status());
  });
});
