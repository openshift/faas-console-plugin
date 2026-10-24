import { consoleFetch, consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { AUTH_EXPIRED_EVENT } from '../types';

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

async function announcingAuthExpired<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (statusOf(err) === 401) window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    throw err;
  }
}

function plain(headers?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers || {}).entries());
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}
