import { test as base, Page } from '@playwright/test';
import { E2E_USER, FAKE_GH_PAT } from '../helpers/constants';

const PAT_KEY = 'func-console-pat';
const USER_KEY = 'func-console-user';

async function injectGitHubPat(page: Page): Promise<void> {
  await page.addInitScript(
    ({ patKey, userKey, pat, user }) => {
      sessionStorage.setItem(patKey, pat);
      sessionStorage.setItem(userKey, JSON.stringify({ name: user }));
    },
    { patKey: PAT_KEY, userKey: USER_KEY, pat: FAKE_GH_PAT, user: E2E_USER },
  );
}

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await injectGitHubPat(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
