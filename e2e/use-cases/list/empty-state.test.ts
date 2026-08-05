import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { BACKEND_ROUTE } from '../../mocks/backend-api';

test.describe('Functions list empty state', () => {
  test('shows empty state when no functions exist', async ({ page }) => {
    await test.step('override mock to return zero functions', async () => {
      await page.route(BACKEND_ROUTE, async (route) => {
        const apiPath = new URL(route.request().url()).pathname;
        if (route.request().method() === 'GET' && apiPath.endsWith('/func/list')) {
          return route.fulfill({ json: [] });
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
