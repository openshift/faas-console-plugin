import { test, expect } from '@playwright/test';
import { injectGitHubPat, navigateToFunctionsList, waitForTableOrEmpty } from '../../helpers';

test.describe('Function list', () => {
  test('loads and displays the page heading', async ({ page }) => {
    await navigateToFunctionsList(page);
    await expect(page.getByRole('heading', { name: 'Functions', exact: true })).toBeVisible();
  });

  test('table displays function data from GitHub repos', async ({ page }) => {
    await navigateToFunctionsList(page);

    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    const rows = grid.locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);

    const firstRow = rows.first();
    await expect(firstRow.getByRole('button', { name: 'Edit' })).toBeVisible();
  });

  test('create button is visible', async ({ page }) => {
    await navigateToFunctionsList(page);
    await waitForTableOrEmpty(page);

    const createLink = page.getByRole('link', { name: 'Create new function' });
    const createLinkAlt = page.getByRole('link', { name: 'Create function' });
    const createBtnDisabled = page.getByRole('button', { name: 'Create function' });
    await expect(createLink.or(createLinkAlt).or(createBtnDisabled)).toBeVisible();
  });

  test('shows empty state when no repos exist', async ({ page }) => {
    await injectGitHubPat(page);

    await page.route('https://api.github.com/search/repositories*', (route) =>
      route.fulfill({ json: { total_count: 0, items: [] } }),
    );

    await navigateToFunctionsList(page);

    await expect(page.getByRole('heading', { name: 'No functions found' })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('shows error alert when GitHub API fails', async ({ page }) => {
    await injectGitHubPat(page);

    await page.route('https://api.github.com/search/repositories*', (route) =>
      route.fulfill({ status: 500, json: { message: 'Internal Server Error' } }),
    );

    await navigateToFunctionsList(page);

    await expect(page.getByText('Error listing functions')).toBeVisible({ timeout: 30_000 });
  });
});
