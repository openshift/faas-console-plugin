import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';

test.describe('Functions list empty state', () => {
  test('shows empty state when no functions exist', async ({ page }) => {
    await test.step('override mock to return zero repos', async () => {
      await page.route('https://api.github.com/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === 'GET' && path === '/search/repositories') {
          return route.fulfill({ json: { total_count: 0, items: [] } });
        }
        return route.fallback();
      });
    });

    await test.step('navigate to functions list', async () => {
      await navigateToFunctionsList(page);
    });

    await test.step('verify empty state', async () => {
      await expect(page.getByRole('heading', { name: 'No functions found' })).toBeVisible({
        timeout: 15_000,
      });

      await expect(page.getByText('Create a serverless function to get started.')).toBeVisible();

      await expect(page.getByRole('link', { name: 'Create function' })).toBeVisible();
    });
  });
});
