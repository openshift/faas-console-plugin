import { test, expect } from '@playwright/test';
import { loadFunctionsList, navigateToFunctionsList, waitForTableOrEmpty } from '../helpers';

test.describe('Functions list page', () => {
  test('loads and displays the page heading', async ({ page }) => {
    await navigateToFunctionsList(page);
    await expect(page.getByRole('heading', { name: 'Functions', exact: true })).toBeVisible();
  });

  test('shows empty state or function table', async ({ page }) => {
    await loadFunctionsList(page);
    await waitForTableOrEmpty(page);
  });

  test('create button is visible', async ({ page }) => {
    await loadFunctionsList(page);
    await waitForTableOrEmpty(page);

    const createLink = page.getByRole('link', { name: 'Create new function' });
    const createLinkAlt = page.getByRole('link', { name: 'Create function' });
    const createBtnDisabled = page.getByRole('button', { name: 'Create function' });
    await expect(createLink.or(createLinkAlt).or(createBtnDisabled)).toBeVisible();
  });
});
