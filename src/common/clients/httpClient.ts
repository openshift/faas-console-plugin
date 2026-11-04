import { consoleFetch, consoleFetchJSON, HttpError } from '@openshift-console/dynamic-plugin-sdk';
import { AUTH_EXPIRED_EVENT } from '../types';

export function customFetch(
  url: string,
  options: RequestInit = {},
  timeout?: number,
): Promise<Response> {
  return announcingAuthExpired(() =>
    consoleFetch(url, { ...options, headers: plain(options.headers) }, timeout),
  );
}

export function customFetchJSON<T>(url: string, method = 'GET', options: RequestInit = {}) {
  return announcingAuthExpired(
    () =>
      consoleFetchJSON(url, method, { ...options, headers: plain(options.headers) }) as Promise<T>,
  );
}

export function resolveErrorStatus(err: unknown): number | undefined {
  return err instanceof HttpError ? err.code : undefined;
}

async function announcingAuthExpired<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (resolveErrorStatus(err) === 401) window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    throw err;
  }
}

function plain(headers?: HeadersInit): Record<string, string> {
  return Object.fromEntries(new Headers(headers || {}).entries());
}
