import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToCreatePage } from '../../helpers/navigation';

const NAMESPACE = 'create-test';
const BRANCH = 'main';

test.describe('Env var validation on create form', () => {
  test('user sees validation errors for invalid env var entries', async ({ page }) => {
    await test.step('navigate to the create page and fill required fields', async () => {
      await navigateToCreatePage(page);
      await expect(page.locator('#owner')).toBeVisible({ timeout: 10_000 });

      await page.locator('#repo').fill('env-test-func');
      await page.locator('#branch').fill(BRANCH);
      await page.locator('#name').fill('env-test-func');
      await page.locator('#namespace').fill(NAMESPACE);
    });

    await test.step('verify submit is enabled before adding env vars', async () => {
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    });

    await test.step('expand the env var section', async () => {
      await page.getByRole('button', { name: 'Add environment variable' }).click();
      await expect(page.locator('#env-name-0')).toBeVisible();
    });

    await test.step('type a value without a name and see "Name is required"', async () => {
      await page.locator('#env-value-0').fill('some-value');

      await expect(page.getByText('Name is required')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    });

    await test.step('clear value so the row is empty again and submit re-enables', async () => {
      await page.locator('#env-value-0').fill('');

      await expect(page.getByText('Name is required')).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    });

    await test.step('type an invalid name starting with a digit', async () => {
      await page.locator('#env-name-0').fill('1BAD_NAME');
      await page.locator('#env-value-0').fill('val');

      await expect(
        page.getByText('Must start with a letter, dot, dash, or underscore'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    });

    await test.step('fix the name and verify submit re-enables', async () => {
      await page.locator('#env-name-0').fill('GOOD_NAME');

      await expect(
        page.getByText('Must start with a letter, dot, dash, or underscore'),
      ).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    });

    await test.step('add a second row and enter a duplicate name', async () => {
      await page.getByRole('button', { name: 'Add key/value' }).first().click();
      await expect(page.locator('#env-name-1')).toBeVisible();

      await page.locator('#env-name-1').fill('GOOD_NAME');
      await page.locator('#env-value-1').fill('other-val');

      const duplicateErrors = page.getByText('Duplicate name');
      await expect(duplicateErrors).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    });

    await test.step('fix the duplicate and verify submit re-enables', async () => {
      await page.locator('#env-name-1').fill('UNIQUE_NAME');

      await expect(page.getByText('Duplicate name')).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    });

    await test.step('introduce an error, remove that row, and verify submit re-enables', async () => {
      await page.locator('#env-name-1').fill('1INVALID');
      await expect(
        page.getByText('Must start with a letter, dot, dash, or underscore'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();

      await page.getByRole('button', { name: 'Remove', exact: true }).first().click();

      await expect(
        page.getByText('Must start with a letter, dot, dash, or underscore'),
      ).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    });

    await test.step('remove all env vars collapses section and re-enables submit', async () => {
      await page.locator('#env-name-0').fill('');
      await page.locator('#env-value-0').fill('orphan-value');
      await expect(page.getByText('Name is required')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();

      await page.getByRole('button', { name: 'Remove environment variables' }).click();

      await expect(page.locator('#env-name-0')).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Add environment variable' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    });
  });
});
