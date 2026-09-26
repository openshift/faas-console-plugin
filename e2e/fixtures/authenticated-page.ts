import { test as base, Page } from '@playwright/test';
import { FAKE_GH_PAT } from '../helpers/constants';
import { getCSRFToken } from '../helpers/cluster';
import { AuthUser, PROXY_BASE, SESSION_TOKEN_KEY, USER_KEY } from '../../src/common/types';

interface Session {
  token: string;
  user: AuthUser;
}

async function login(page: Page): Promise<Session> {
  const res = await page.request.post(`${PROXY_BASE}/api/v1/auth/login`, {
    headers: { 'X-CSRFToken': await csrfToken(page) },
    data: { pat: FAKE_GH_PAT },
  });
  if (!res.ok()) {
    throw new Error(`fixture login failed: ${res.status()} ${await res.text()}`);
  }

  const { token, login: name, avatarUrl } = await res.json();
  return { token, user: { name, avatarUrl } };
}

async function csrfToken(page: Page): Promise<string> {
  const fromState = await getCSRFToken(page);
  if (fromState) return fromState;

  await page.goto('/');
  return getCSRFToken(page);
}

// Seeded on every navigation, so a test that reloads stays connected.
async function seedSession(page: Page, session: Session): Promise<void> {
  await page.addInitScript(
    ({ tokenKey, userKey, token, user }) => {
      sessionStorage.setItem(tokenKey, token);
      sessionStorage.setItem(userKey, JSON.stringify(user));
    },
    { tokenKey: SESSION_TOKEN_KEY, userKey: USER_KEY, ...session },
  );
}

async function logout(page: Page): Promise<void> {
  try {
    await page.request.post(`${PROXY_BASE}/api/v1/auth/logout`, {
      headers: { 'X-CSRFToken': await getCSRFToken(page) },
    });
  } catch (err) {
    console.warn(`fixture logout failed, session secret left behind: ${err}`);
  }
}

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const session = await login(page);
    await seedSession(page, session);
    await use(page);
    await logout(page);
  },
});

export { expect } from '@playwright/test';
