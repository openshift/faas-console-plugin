import { Locator, Page, expect } from '@playwright/test';
import { mockGitHubApi } from './mocks/github';

const PAT_KEY = 'func-console-pat';
const USER_KEY = 'func-console-user';

const LOADING_SELECTORS = [
  '[aria-label="Loading"]',
  '.pf-v6-c-spinner',
  '.pf-c-spinner',
  '.co-m-loader',
];

export async function waitForLoadingComplete(page: Page, timeoutMs = 30_000): Promise<void> {
  const combined = page.locator(LOADING_SELECTORS.join(', '));
  await combined
    .first()
    .waitFor({ state: 'hidden', timeout: timeoutMs })
    .catch(() => {});
}

export async function dismissDialogs(page: Page): Promise<void> {
  await page
    .evaluate(() => document.getElementById('webpack-dev-server-client-overlay')?.remove())
    .catch(() => {});
  await page
    .addLocatorHandler(page.locator('#webpack-dev-server-client-overlay'), async () => {
      await page
        .evaluate(() => document.getElementById('webpack-dev-server-client-overlay')?.remove())
        .catch(() => {});
    })
    .catch(() => {});

  const anyDialog = page
    .locator('.pf-v6-c-modal-box')
    .or(page.locator('[data-test="tour-step-footer-secondary"]'));
  await anyDialog
    .first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {});

  const patDialog = page.locator('.pf-v6-c-modal-box').filter({ hasText: 'Connect to GitHub' });
  if (await patDialog.isVisible()) {
    const cancelBtn = patDialog.locator('button').filter({ hasText: 'Cancel' });
    await cancelBtn.evaluate((el: HTMLElement) => el.click());
    await patDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  const skipTour = page.locator('[data-test="tour-step-footer-secondary"]');
  await skipTour.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await skipTour.isVisible()) {
    await skipTour.evaluate((el: HTMLElement) => el.click());
    await skipTour.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}

const injectedPages = new WeakSet<Page>();

export async function injectGitHubPat(page: Page): Promise<void> {
  if (injectedPages.has(page)) return;
  injectedPages.add(page);

  const pat = process.env.BRIDGE_GITHUB_PAT;
  if (pat) {
    const response = await page.request.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${pat}` },
    });
    const user = await response.json();
    await page.addInitScript(
      ({ patKey, userKey, patValue, userValue }) => {
        sessionStorage.setItem(patKey, patValue);
        sessionStorage.setItem(userKey, JSON.stringify(userValue));
      },
      { patKey: PAT_KEY, userKey: USER_KEY, patValue: pat, userValue: { name: user.login } },
    );
  } else {
    await mockGitHubApi(page);
    await page.addInitScript(
      ({ patKey, userKey }) => {
        sessionStorage.setItem(patKey, 'placeholder-pat');
        sessionStorage.setItem(userKey, JSON.stringify({ name: 'e2e-user' }));
      },
      { patKey: PAT_KEY, userKey: USER_KEY },
    );
  }
}

async function navigateTo(page: Page, path: string): Promise<void> {
  await injectGitHubPat(page);
  await page.goto(path);
  await dismissDialogs(page);
  await waitForLoadingComplete(page);
}

export async function navigateToFunctionsList(page: Page): Promise<void> {
  await navigateTo(page, '/faas');
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

export async function navigateToFunctionsTable(page: Page): Promise<void> {
  await navigateToFunctionsList(page);
  await page.getByRole('heading', { name: 'Functions', exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole('grid', { name: 'Functions' }).waitFor({ timeout: 10_000 });
}

export async function waitForTableOrEmpty(page: Page): Promise<'table' | 'empty'> {
  const table = page.getByRole('grid', { name: 'Functions' });
  const emptyHeading = page.getByRole('heading', { name: 'No functions found' });

  await expect(table.or(emptyHeading)).toBeVisible({ timeout: 30_000 });

  if (await table.isVisible()) return 'table';
  return 'empty';
}

const ROBUST_CLICK_RETRIES = 3;
const ROBUST_CLICK_BASE_DELAY = 500;

export async function robustClick(locator: Locator): Promise<void> {
  for (let attempt = 0; attempt < ROBUST_CLICK_RETRIES; attempt++) {
    try {
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ force: attempt > 0, timeout: 10_000 });
      return;
    } catch {
      if (attempt === ROBUST_CLICK_RETRIES - 1)
        throw new Error(`robustClick failed after ${ROBUST_CLICK_RETRIES} attempts`);
      await locator.page().waitForTimeout(ROBUST_CLICK_BASE_DELAY * 2 ** attempt);
    }
  }
}

export function createButtonLocator(page: Page): Locator {
  return page
    .getByRole('link', { name: 'Create new function' })
    .or(page.getByRole('link', { name: 'Create function' }))
    .or(page.getByRole('button', { name: 'Create function' }));
}
