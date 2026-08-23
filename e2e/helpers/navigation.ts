import { Page } from '@playwright/test';
import { dismissDialogs, waitForLoadingComplete } from './ui';

async function navigateTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await dismissDialogs(page);
  await waitForLoadingComplete(page);
}

export async function navigateToFunctionsList(page: Page): Promise<void> {
  await navigateTo(page, '/faas');
}

export async function navigateToFunctionsTable(page: Page): Promise<void> {
  await navigateToFunctionsList(page);
  await page.getByRole('heading', { name: 'Functions', exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole('grid', { name: 'Functions' }).waitFor({ timeout: 10_000 });
}

export async function navigateToCreatePage(page: Page): Promise<void> {
  await navigateTo(page, '/faas/create');
}

export async function navigateToEditPage(page: Page, repoName?: string): Promise<void> {
  if (repoName) {
    await navigateTo(page, `/faas/edit/${repoName}`);
  } else {
    await navigateToFunctionsTable(page);
    await page
      .getByRole('grid', { name: 'Functions' })
      .getByRole('button', { name: 'Edit' })
      .first()
      .click();
    await page.getByRole('heading', { name: 'Edit function' }).waitFor({ timeout: 10_000 });
  }
}

export async function selectNamespace(page: Page, namespace: string): Promise<void> {
  await page.locator('[data-test="namespace-bar-dropdown"] button').click();
  await page.getByRole('searchbox', { name: 'Select project...' }).fill(namespace);
  await page.getByRole('menuitem', { name: namespace, exact: true }).click();
  await waitForLoadingComplete(page);
}

export async function selectAllNamespaces(page: Page): Promise<void> {
  await page.locator('[data-test="namespace-bar-dropdown"] button').click();
  await page.getByRole('menuitem', { name: 'All Projects', exact: true }).click();
  await waitForLoadingComplete(page);
}
