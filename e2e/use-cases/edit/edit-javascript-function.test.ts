import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToEditPage } from '../../helpers/navigation';
import { PRESEEDED_FUNC_NAME } from '../../mocks/backend-api';

test.describe('Edit JavaScript function', () => {
  test('regression SRVOCF-1007: editor loads JS files without Monaco worker errors', async ({
    page,
  }) => {
    const pageErrorMessages: string[] = [];
    const consoleLogErrorMessages: string[] = [];
    page.on('pageerror', (err) => pageErrorMessages.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleLogErrorMessages.push(msg.text());
    });

    await test.step('navigate to edit page', async () => {
      await navigateToEditPage(page, PRESEEDED_FUNC_NAME);
      await expect(page.getByRole('heading', { name: 'Edit function' })).toBeVisible({
        timeout: 10_000,
      });
    });

    await test.step('verify editor loads with JavaScript syntax highlighting', async () => {
      const editor = page.locator('.monaco-editor');
      await expect(editor.first()).toBeVisible({ timeout: 10_000 });
      await expect(editor.first()).toContainText('module.exports');

      // Language label shows JAVASCRIPT
      await expect(page.getByText('JAVASCRIPT')).toBeVisible();
    });

    await test.step('verify no webpack error overlay appeared', async () => {
      const overlay = page.locator('#webpack-dev-server-client-overlay');
      await expect(overlay).toHaveCount(0);
    });

    await test.step('verify no "Unexpected usage" errors in console', async () => {
      const unexpectedUsageWorkerErrors = pageErrorMessages.filter((msg) =>
        msg.includes('Unexpected usage'),
      );
      const unexpectedUsageConsoleLogsErrors = consoleLogErrorMessages.filter((msg) =>
        msg.includes('Unexpected usage'),
      );

      expect(unexpectedUsageWorkerErrors).toHaveLength(0);
      expect(unexpectedUsageConsoleLogsErrors).toHaveLength(0);
    });

    await test.step('verify file tree loaded', async () => {
      const tree = page.getByRole('tree', { name: 'File tree' });
      await expect(tree.getByText('func.yaml')).toBeVisible();
      await expect(tree.getByText('index.js')).toBeVisible();
    });

    await test.step('verify switching files works without errors', async () => {
      const tree = page.getByRole('tree', { name: 'File tree' });
      await tree.getByText('func.yaml', { exact: true }).click();

      const editor = page.locator('.monaco-editor');
      await expect(editor.first()).toContainText('runtime: node');

      // Switch back to JS file
      await tree.getByText('index.js', { exact: true }).click();
      await expect(editor.first()).toContainText('module.exports');

      // Still no worker errors after switching
      const unexpectedUsageWorkerErrors = pageErrorMessages.filter((msg) =>
        msg.includes('Unexpected usage'),
      );
      const unexpectedUsageConsoleLogsErrors = consoleLogErrorMessages.filter((msg) =>
        msg.includes('Unexpected usage'),
      );
      expect(unexpectedUsageWorkerErrors).toHaveLength(0);
      expect(unexpectedUsageConsoleLogsErrors).toHaveLength(0);
    });
  });
});
