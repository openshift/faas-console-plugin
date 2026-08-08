import { test as base, Page } from '@playwright/test';

const PAT_KEY = 'func-console-pat';
const USER_KEY = 'func-console-user';

async function injectGitHubPat(page: Page): Promise<void> {
  await page.addInitScript(
    ({ patKey, userKey }) => {
      sessionStorage.setItem(patKey, 'placeholder-pat');
      sessionStorage.setItem(userKey, JSON.stringify({ name: 'e2e-user' }));
    },
    { patKey: PAT_KEY, userKey: USER_KEY },
  );
}

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await injectGitHubPat(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
