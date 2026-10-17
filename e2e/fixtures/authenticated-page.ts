import { test as base, Page } from '@playwright/test';
import { FAKE_GH_PAT } from '../helpers/constants';
import { getCSRFToken } from '../helpers/cluster';
import { PROXY_BASE } from '../../src/common/types';

const TOKEN_URL = `${PROXY_BASE}/api/v1/auth/github-token`;

// Handing the backend the PAT is the whole setup. The credential is keyed by
// the OpenShift identity the console forwards, so the browser needs nothing
// seeded into it: every page load, including a reload, reconnects on its own.
async function connect(page: Page): Promise<void> {
  const res = await page.request.post(TOKEN_URL, {
    headers: { 'X-CSRFToken': await csrfToken(page) },
    data: { pat: FAKE_GH_PAT },
  });
  if (!res.ok()) {
    throw new Error(`fixture connect failed: ${res.status()} ${await res.text()}`);
  }
}

async function csrfToken(page: Page): Promise<string> {
  const fromState = await getCSRFToken(page);
  if (fromState) return fromState;

  await page.goto('/');
  return getCSRFToken(page);
}

async function disconnect(page: Page): Promise<void> {
  try {
    await page.request.delete(TOKEN_URL, {
      headers: { 'X-CSRFToken': await getCSRFToken(page) },
    });
  } catch (err) {
    console.warn(`fixture disconnect failed, credential secret left behind: ${err}`);
  }
}

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await connect(page);
    await use(page);
    await disconnect(page);
  },
});

export { expect } from '@playwright/test';
