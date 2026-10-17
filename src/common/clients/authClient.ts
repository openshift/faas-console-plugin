import { consoleFetch, consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { AUTH_EXPIRED_EVENT, AuthUser, PROXY_BASE } from '../types';

const GITHUB_TOKEN_URL = `${PROXY_BASE}/api/v1/auth/github-token`;

interface AccountResponse {
  login: string;
  avatarUrl: string;
}

export async function connect(pat: string): Promise<AuthUser> {
  const account: AccountResponse = await consoleFetchJSON.post(GITHUB_TOKEN_URL, { pat });
  return toUser(account);
}

// Resolves null only when the backend says it holds nothing, which is the
// signal to ask for a PAT.
export async function fetchConnection(): Promise<AuthUser | null> {
  try {
    const account: AccountResponse = await consoleFetchJSON(GITHUB_TOKEN_URL);
    return toUser(account);
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
    return null;
  }
}

export async function disconnect(): Promise<void> {
  try {
    await consoleFetch(GITHUB_TOKEN_URL, { method: 'DELETE' });
  } catch {
    // Best effort: the stored credential expires on its own, and leaving the
    // caller looking connected because revocation failed is the worse outcome.
  }
}

export function customFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return announcingAuthExpired(() =>
    consoleFetch(url, { ...options, headers: plain(options.headers) }),
  );
}

export function customFetchJSON<T>(url: string, method = 'GET', options: RequestInit = {}) {
  return announcingAuthExpired(
    () =>
      consoleFetchJSON(url, method, { ...options, headers: plain(options.headers) }) as Promise<T>,
  );
}

// 401 has one meaning on the request path: the backend has no credential it
// can use for this caller. There is no handle to refresh, so the request is
// not retried; the UI is told to ask for a PAT instead.
async function announcingAuthExpired<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (statusOf(err) === 401) window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    throw err;
  }
}

function toUser({ login, avatarUrl }: AccountResponse): AuthUser {
  return { name: login, avatarUrl };
}

function plain(headers?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers || {}).entries());
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}
