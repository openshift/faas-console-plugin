import { consoleFetch, consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { AUTH_EXPIRED_EVENT } from '../types';
import { customFetch, customFetchJSON } from './httpClient';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: vi.fn(),
  consoleFetchJSON: vi.fn(),
}));

const consoleFetchDouble = vi.mocked(consoleFetch);
const consoleFetchJSONDouble = vi.mocked(consoleFetchJSON);

// Both wrappers share the auth-expiry announcing logic, so every failure
// case runs through each of them. Each wrapper carries the SDK double it
// delegates to, so only that double is armed per test.
const wrappers = [
  ['customFetch', (url: string) => customFetch(url), consoleFetchDouble],
  ['customFetchJSON', (url: string) => customFetchJSON(url), consoleFetchJSONDouble],
] as const;

function listenForAuthExpired(): { events: Event[]; stop: () => void } {
  const events: Event[] = [];
  const listener = (e: Event) => events.push(e);
  window.addEventListener(AUTH_EXPIRED_EVENT, listener);
  return { events, stop: () => window.removeEventListener(AUTH_EXPIRED_EVENT, listener) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('customFetch', () => {
  it('returns the response from consoleFetch', async () => {
    const response = new Response(null);
    consoleFetchDouble.mockResolvedValueOnce(response);

    await expect(customFetch('/api/v1/func/list')).resolves.toBe(response);
  });

  it('converts Headers to a plain record before delegating', async () => {
    consoleFetchDouble.mockResolvedValueOnce(new Response(null));

    await customFetch('/api/v1/func/create', {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });

    expect(consoleFetchDouble).toHaveBeenCalledWith(
      '/api/v1/func/create',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      undefined,
    );
  });
});

describe('customFetchJSON', () => {
  it('returns the parsed data from consoleFetchJSON', async () => {
    const account = { login: 'twoGiants', avatarUrl: 'https://valid.url' };
    consoleFetchJSONDouble.mockResolvedValueOnce(account);

    await expect(customFetchJSON('/api/v1/scm/github/credential')).resolves.toEqual(account);
  });
});

describe.each(wrappers)('%s', (_name, request, double) => {
  it.each([401, 403])(
    'announces auth expiry and rejects with the original error on %i (top-level status)',
    async (status) => {
      const error = Object.assign(new Error('token expired'), { status });
      double.mockRejectedValueOnce(error as never);
      const listener = listenForAuthExpired();

      try {
        await expect(request('/api/v1/func/list')).rejects.toBe(error);
        expect(listener.events).toHaveLength(1);
      } finally {
        listener.stop();
      }
    },
  );

  it.each([401, 403])(
    'announces auth expiry and rejects with the original error on %i (response.status)',
    async (status) => {
      const error = Object.assign(new Error('token expired'), { response: { status } });
      double.mockRejectedValueOnce(error as never);
      const listener = listenForAuthExpired();

      try {
        await expect(request('/api/v1/func/list')).rejects.toBe(error);
        expect(listener.events).toHaveLength(1);
      } finally {
        listener.stop();
      }
    },
  );

  it('rejects without announcing auth expiry on other failures', async () => {
    const error = Object.assign(new Error('server error'), { status: 500 });
    double.mockRejectedValueOnce(error as never);
    const listener = listenForAuthExpired();

    try {
      await expect(request('/api/v1/func/list')).rejects.toBe(error);
      expect(listener.events).toHaveLength(0);
    } finally {
      listener.stop();
    }
  });
});
