import { HttpError } from '@openshift-console/dynamic-plugin-sdk';
import { fetchGithubUserStub } from '../testing/authClientStub';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { AUTH_EXPIRED_EVENT } from '../types';
import { customFetch, customFetchJSON } from './httpClient';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the sdkTestDoubles available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  HttpError: sdkTestDoubles.HttpError,
  consoleFetch: sdkTestDoubles.consoleFetchStub,
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONStub,
}));

// The wrappers do not care which backend route they call, so the tests reuse
// the credential endpoint and its existing test double.
const URL = `${BACKEND_API}/api/v1/scm/github/credential`;
const ACCOUNT = { login: 'twoGiants', avatarUrl: 'https://valid.url' };

// Both wrappers share the auth-expiry announcing logic, so every failure
// case runs through each of them.
const wrappers = [
  { name: 'customFetch', request: () => customFetch(URL) },
  { name: 'customFetchJSON', request: () => customFetchJSON(URL) },
] as const;

function failWith(status: number) {
  fetchGithubUserStub({ errorResponse: { message: 'token expired', status } });
}

function listenForAuthExpired(): Event[] & Disposable {
  const events: Event[] = [];
  const listener = (e: Event) => events.push(e);
  window.addEventListener(AUTH_EXPIRED_EVENT, listener);
  return Object.assign(events, {
    [Symbol.dispose]() {
      window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
    },
  });
}

describe('httpClient', () => {
  afterEach(() => {
    server.resetHandlers();
  });

  describe('customFetch', () => {
    it('returns the response from the backend', async () => {
      fetchGithubUserStub({ response: ACCOUNT });

      const res = await customFetch(URL);

      expect(res.ok).toBe(true);
      await expect(res.json()).resolves.toEqual(ACCOUNT);
    });
  });

  describe('customFetchJSON', () => {
    it('returns the parsed data from the backend', async () => {
      fetchGithubUserStub({ response: ACCOUNT });

      await expect(customFetchJSON(URL)).resolves.toEqual(ACCOUNT);
    });
  });

  describe.each(wrappers)('$name', ({ request }) => {
    it('announces auth expiry and rejects on 401', async () => {
      failWith(401);
      using events = listenForAuthExpired();

      const error = await request().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe(401);
      expect(events).toHaveLength(1);
    });

    // Only a 401 means "reconnect GitHub"; a 403 is about permissions.
    it.each([403, 500])('rejects without announcing auth expiry on %i', async (status) => {
      failWith(status);
      using events = listenForAuthExpired();

      const error = await request().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe(status);
      expect(events).toHaveLength(0);
    });

    it('rejects without announcing auth expiry on network failure', async () => {
      fetchGithubUserStub({ networkError: true });
      using events = listenForAuthExpired();

      await expect(request()).rejects.toBeInstanceOf(Error);
      expect(events).toHaveLength(0);
    });
  });
});
