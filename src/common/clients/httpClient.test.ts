import { HttpError } from '@openshift-console/dynamic-plugin-sdk';
import { http, HttpResponse } from 'msw';
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

const LIST_URL = `${BACKEND_API}/api/v1/func/list`;

// Both wrappers share the auth-expiry announcing logic, so every failure
// case runs through each of them. Each wrapper carries the MSW handler that
// makes its next request fail, so only that path is armed per test.
const wrappers = [
  {
    name: 'customFetch',
    request: (url: string) => customFetch(url),
    failWith: (status: number) =>
      server.use(http.get(LIST_URL, () => new HttpResponse(null, { status }))),
  },
  {
    name: 'customFetchJSON',
    request: (url: string) => customFetchJSON(url),
    failWith: (status: number) =>
      server.use(
        http.get(LIST_URL, () => HttpResponse.json({ message: 'token expired' }, { status })),
      ),
  },
] as const;

function listenForAuthExpired(): { events: Event[]; stop: () => void } {
  const events: Event[] = [];
  const listener = (e: Event) => events.push(e);
  window.addEventListener(AUTH_EXPIRED_EVENT, listener);
  return { events, stop: () => window.removeEventListener(AUTH_EXPIRED_EVENT, listener) };
}

afterEach(() => {
  server.resetHandlers();
});

describe('customFetch', () => {
  it('returns the response from the backend', async () => {
    server.use(http.get(LIST_URL, () => HttpResponse.json({ items: [] })));

    const res = await customFetch(LIST_URL);

    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });

  it('passes method, headers, and body through to the backend', async () => {
    let captured: Request | undefined;
    server.use(
      http.post(`${BACKEND_API}/api/v1/func/create`, ({ request }) => {
        captured = request;
        return new HttpResponse(null, { status: 201 });
      }),
    );

    const res = await customFetch(`${BACKEND_API}/api/v1/func/create`, {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'my-func' }),
    });

    expect(res.status).toBe(201);
    expect(captured?.method).toBe('POST');
    expect(captured?.headers.get('content-type')).toBe('application/json');
    await expect(captured?.json()).resolves.toEqual({ name: 'my-func' });
  });
});

describe('customFetchJSON', () => {
  it('returns the parsed data from the backend', async () => {
    const account = { login: 'twoGiants', avatarUrl: 'https://valid.url' };
    server.use(http.get(LIST_URL, () => HttpResponse.json(account)));

    await expect(customFetchJSON(LIST_URL)).resolves.toEqual(account);
  });
});

describe.each(wrappers)('$name', ({ request, failWith }) => {
  it.each([401, 403])('announces auth expiry and rejects on %i', async (status) => {
    failWith(status);
    const listener = listenForAuthExpired();

    try {
      const error = await request(LIST_URL).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe(status);
      expect(listener.events).toHaveLength(1);
    } finally {
      listener.stop();
    }
  });

  it('rejects without announcing auth expiry on other failures', async () => {
    failWith(500);
    const listener = listenForAuthExpired();

    try {
      const error = await request(LIST_URL).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe(500);
      expect(listener.events).toHaveLength(0);
    } finally {
      listener.stop();
    }
  });

  it('rejects without announcing auth expiry on network failure', async () => {
    server.use(http.get(LIST_URL, () => HttpResponse.error()));
    const listener = listenForAuthExpired();

    try {
      await expect(request(LIST_URL)).rejects.toBeInstanceOf(Error);
      expect(listener.events).toHaveLength(0);
    } finally {
      listener.stop();
    }
  });
});
