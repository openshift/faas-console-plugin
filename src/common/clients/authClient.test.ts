import { http, HttpResponse } from 'msw';
import { customFetch, customFetchJSON, connect, disconnect, fetchConnection } from './authClient';
import { AUTH_EXPIRED_EVENT } from '../types';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { connectStub, disconnectStub } from '../testing/authClientStub';

const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

const sdk = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; options?: RequestInit }[],
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: (url: string, options?: RequestInit) => {
    sdk.calls.push({ url, options });
    return sdkTestDoubles.consoleFetchStub(url, options);
  },
  consoleFetchJSON: Object.assign(
    (url: string, method?: string, options?: RequestInit) => {
      sdk.calls.push({ url, method, options });
      return sdkTestDoubles.consoleFetchJSONStub(url, method, options);
    },
    { post: sdkTestDoubles.consoleFetchJSONStub.post },
  ),
}));

const CREATE_URL = `${BACKEND_API}/api/v1/func/create`;
const LIST_URL = `${BACKEND_API}/api/v1/func/list`;
const TOKEN_URL = `${BACKEND_API}/api/v1/auth/github-token`;

const ALICE = { name: 'alice-gh', avatarUrl: 'https://example.com/avatar' };

function ok() {
  return HttpResponse.json({ ok: true });
}
function fails(status: number, message: string) {
  return () => HttpResponse.json({ message }, { status });
}

function endpoint(url: string, ...replies: (() => Response)[]) {
  const requests: Request[] = [];
  server.use(
    http.all(url, ({ request }) => {
      requests.push(request.clone());
      return replies[Math.min(requests.length - 1, replies.length - 1)]();
    }),
  );
  return requests;
}

function sentHeaders(index = 0) {
  return sdk.calls[index].options?.headers as Record<string, string>;
}

function watchForAuthLoss() {
  const onLost = vi.fn();
  window.addEventListener(AUTH_EXPIRED_EVENT, onLost);
  onTestFinished(() => window.removeEventListener(AUTH_EXPIRED_EVENT, onLost));
  return onLost;
}

beforeEach(() => {
  sessionStorage.clear();
  sdk.calls.length = 0;
});

describe('connect', () => {
  it('sends the PAT and returns the GitHub account behind it', async () => {
    let sent: { pat?: string } = {};
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        sent = (await request.json()) as { pat?: string };
        return HttpResponse.json({ login: ALICE.name, avatarUrl: ALICE.avatarUrl });
      }),
    );

    await expect(connect('ghp_valid')).resolves.toEqual(ALICE);

    expect(sent.pat).toBe('ghp_valid');
  });

  // The whole point of storing the credential on the backend: having just
  // typed a PAT must not leave a copy of it in the browser.
  it('leaves nothing behind in browser storage', async () => {
    connectStub({ response: { login: ALICE.name, avatarUrl: '' } });

    await connect('ghp_valid');

    expect(sessionStorage.length).toBe(0);
    expect(localStorage.getItem('pat')).toBeNull();
  });

  it('propagates the error when the backend rejects the PAT', async () => {
    connectStub({ errorResponse: { message: 'invalid github pat', status: 401 } });

    await expect(connect('ghp_bad')).rejects.toThrow('invalid github pat');
  });
});

describe('fetchConnection', () => {
  // A browser holding no state at all is still connected, because the
  // OpenShift identity the console forwards is what finds the credential.
  it('reports the stored GitHub account', async () => {
    endpoint(TOKEN_URL, () => HttpResponse.json({ login: ALICE.name, avatarUrl: ALICE.avatarUrl }));

    await expect(fetchConnection()).resolves.toEqual(ALICE);
  });

  it('reads it with a GET', async () => {
    const requests = endpoint(TOKEN_URL, () =>
      HttpResponse.json({ login: ALICE.name, avatarUrl: '' }),
    );

    await fetchConnection();

    expect(requests[0].method).toBe('GET');
  });

  it('resolves null when the user has never connected', async () => {
    endpoint(TOKEN_URL, fails(404, 'no stored credential'));

    await expect(fetchConnection()).resolves.toBeNull();
  });

  // Null means "nothing stored, ask for a PAT". A backend that cannot answer
  // has not told us that, so it must not be reported as a missing credential.
  it('throws when the backend cannot answer', async () => {
    endpoint(TOKEN_URL, fails(503, 'credential store unavailable'));

    await expect(fetchConnection()).rejects.toThrow('credential store unavailable');
  });
});

describe('disconnect', () => {
  it('deletes the stored credential', async () => {
    const requests = endpoint(TOKEN_URL, () => new Response(null, { status: 204 }));

    await disconnect();

    expect(requests[0].method).toBe('DELETE');
  });

  // The credential expires on its own, and leaving the user looking connected
  // because revocation failed is the worse outcome.
  it('resolves even when revocation fails', async () => {
    disconnectStub({ errorResponse: { message: 'credential store unavailable', status: 503 } });

    await expect(disconnect()).resolves.toBeUndefined();
  });
});

describe('authFetch', () => {
  it('announces the lost connection on a 401', async () => {
    endpoint(CREATE_URL, fails(401, 'authentication required'));
    const onLost = watchForAuthLoss();

    await expect(customFetch(CREATE_URL)).rejects.toThrow('authentication required');

    expect(onLost).toHaveBeenCalled();
  });

  // There is no handle to refresh any more: a 401 means the stored credential
  // is gone, and asking again would only produce a second 401.
  it('does not retry a request the backend rejected', async () => {
    const requests = endpoint(CREATE_URL, fails(401, 'authentication required'));

    await expect(customFetch(CREATE_URL)).rejects.toThrow('authentication required');

    expect(requests).toHaveLength(1);
  });

  it('stays quiet on other errors', async () => {
    endpoint(CREATE_URL, fails(500, 'Server Error'));
    const onLost = watchForAuthLoss();

    await expect(customFetch(CREATE_URL)).rejects.toThrow('Server Error');

    expect(onLost).not.toHaveBeenCalled();
  });

  it('keeps headers supplied by the caller', async () => {
    const requests = endpoint(CREATE_URL, ok);

    await customFetch(CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(requests[0].headers.get('content-type')).toBe('application/json');
  });

  // The console merges these into its own headers, which a Headers instance
  // does not survive: it arrives as an empty object and the value is dropped.
  it('passes headers as a plain object, not a Headers instance', async () => {
    endpoint(CREATE_URL, ok);

    await customFetch(CREATE_URL, { headers: { 'X-Test': 'yes' } });

    expect(sentHeaders()).not.toBeInstanceOf(Headers);
    expect(sentHeaders()['x-test']).toBe('yes');
  });
});

describe('authFetchJSON', () => {
  it('returns the parsed body', async () => {
    endpoint(LIST_URL, () => HttpResponse.json([{ name: 'hello' }]));

    await expect(customFetchJSON(LIST_URL)).resolves.toEqual([{ name: 'hello' }]);
    expect(sdk.calls[0].method).toBe('GET');
  });

  it('announces the lost connection on a 401', async () => {
    endpoint(LIST_URL, fails(401, 'authentication required'));
    const onLost = watchForAuthLoss();

    await expect(customFetchJSON(LIST_URL)).rejects.toThrow('authentication required');

    expect(onLost).toHaveBeenCalled();
  });
});
