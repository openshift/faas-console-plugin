import { consoleFetch, consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import {
  AuthUser,
  PROXY_BASE,
  SESSION_EXPIRED_EVENT,
  SESSION_HEADER,
  SESSION_TOKEN_KEY,
  USER_KEY,
} from '../types';

interface LoginResponse {
  token: string;
  login: string;
  avatarUrl: string;
}

export async function login(pat: string): Promise<AuthUser> {
  const {
    token,
    login: name,
    avatarUrl,
  }: LoginResponse = await consoleFetchJSON.post(`${PROXY_BASE}/api/v1/auth/login`, { pat });
  const user: AuthUser = { name, avatarUrl };
  storeSession(token, user);
  return user;
}

export async function resumeSession(): Promise<AuthUser | null> {
  try {
    const {
      token,
      login: name,
      avatarUrl,
    }: LoginResponse = await consoleFetchJSON.post(`${PROXY_BASE}/api/v1/auth/session`, {});
    const user: AuthUser = { name, avatarUrl };
    storeSession(token, user);
    return user;
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
    // The credential really is gone, so whatever this tab still holds names
    // nothing.
    clearSession();
    return null;
  }
}

export async function logout(): Promise<void> {
  const token = getSessionToken();
  try {
    await consoleFetch(`${PROXY_BASE}/api/v1/auth/logout`, {
      method: 'POST',
      headers: token ? { [SESSION_HEADER]: token } : {},
    });
  } catch {
    // Best effort: the stored credential expires on its own, and leaving the
    // caller connected because revocation failed is the worse outcome.
  } finally {
    clearSession();
  }
}

export function storeSession(token: string, user: AuthUser): void {
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

export function isSessionActive(): boolean {
  return getSessionToken() !== null;
}

export function getSessionToken(): string | null {
  return sessionStorage.getItem(SESSION_TOKEN_KEY);
}

function withSessionHeader(headers?: HeadersInit): Record<string, string> {
  const merged = new Headers(headers || {});
  const token = getSessionToken();
  if (token) {
    // Not Authorization: the console proxy uses that header for the OCP user token.
    merged.set(SESSION_HEADER, token);
  }
  return Object.fromEntries(merged.entries());
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}

const resumeSessionOnce: () => Promise<AuthUser | null> = (() => {
  let pending: Promise<AuthUser | null> | null = null;
  return () => {
    pending ??= resumeSession().finally(() => {
      pending = null;
    });
    return pending;
  };
})();

async function withSessionRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (statusOf(err) !== 401) throw err;

    let resumed: AuthUser | null;
    try {
      resumed = await resumeSessionOnce();
    } catch {
      throw err;
    }

    if (!resumed) {
      endSession();
      throw err;
    }

    try {
      return await attempt();
    } catch (retryErr) {
      if (statusOf(retryErr) === 401) endSession();
      throw retryErr;
    }
  }
}

function endSession(): void {
  clearSession();
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

export function sessionFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return withSessionRetry(() =>
    consoleFetch(url, { ...options, headers: withSessionHeader(options.headers) }),
  );
}

export function sessionFetchJSON<T>(url: string, method = 'GET', options: RequestInit = {}) {
  return withSessionRetry(
    () =>
      consoleFetchJSON(url, method, {
        ...options,
        headers: withSessionHeader(options.headers),
      }) as Promise<T>,
  );
}
