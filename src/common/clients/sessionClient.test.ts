import { http, HttpResponse } from 'msw';
import { login, logout, resumeSession, sessionFetch, sessionFetchJSON } from './sessionClient';
import { SESSION_EXPIRED_EVENT, SESSION_HEADER, SESSION_TOKEN_KEY, USER_KEY } from '../types';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { loginStub, logoutStub, resumeSessionStub } from '../testing/sessionClientStub';

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
const SESSION_URL = `${BACKEND_API}/api/v1/auth/session`;
const LOGIN_URL = `${BACKEND_API}/api/v1/auth/login`;

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

function reissues(token: string) {
  resumeSessionStub({ response: { token, login: ALICE.name, avatarUrl: ALICE.avatarUrl } });
}
function noStoredCredential() {
  resumeSessionStub({ errorResponse: { message: 'no stored credential', status: 404 } });
}
function reissueUnavailable() {
  resumeSessionStub({ errorResponse: { message: 'session store unavailable', status: 503 } });
}

function watchForExpiry() {
  const onExpired = vi.fn();
  window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
  onTestFinished(() => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired));
  return onExpired;
}

beforeEach(() => {
  sessionStorage.clear();
  sdk.calls.length = 0;
});

describe('sessionFetch', () => {
  it('sends the stored session token', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    const requests = endpoint(CREATE_URL, ok);

    await sessionFetch(CREATE_URL, { method: 'POST' });

    expect(requests[0].headers.get(SESSION_HEADER)).toBe('sess_test');
  });

  // The console merges these headers into its own, which a Headers instance
  // does not survive: it arrives as an empty object and the token is dropped.
  it('passes headers as a plain object, not a Headers instance', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    endpoint(CREATE_URL, ok);

    await sessionFetch(CREATE_URL);

    expect(sentHeaders()).not.toBeInstanceOf(Headers);
    expect(Object.keys(sentHeaders())).toContain(SESSION_HEADER.toLowerCase());
  });

  it('keeps headers supplied by the caller', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    const requests = endpoint(CREATE_URL, ok);

    await sessionFetch(CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(requests[0].headers.get('content-type')).toBe('application/json');
  });

  it('omits the session header when there is no session', async () => {
    const requests = endpoint(CREATE_URL, ok);

    await sessionFetch(CREATE_URL);

    expect(requests[0].headers.get(SESSION_HEADER)).toBeNull();
  });

  // Regression: the console reports the code only on the attached Response.
  // Checking err.status alone left the user looking connected against a session
  // the backend had already forgotten.
  it('clears the session and announces expiry on a 401 it cannot resume', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    endpoint(CREATE_URL, fails(401, 'authentication required'));
    noStoredCredential();
    const onExpired = watchForExpiry();

    await expect(sessionFetch(CREATE_URL)).rejects.toThrow('authentication required');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(onExpired).toHaveBeenCalled();
  });

  it('reissues the session and retries once after a 401', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    const requests = endpoint(CREATE_URL, fails(401, 'session expired'), ok);
    reissues('sess_new');
    const onExpired = watchForExpiry();

    await expect(sessionFetch(CREATE_URL)).resolves.toBeInstanceOf(Response);

    expect(requests[1].headers.get(SESSION_HEADER)).toBe('sess_new');
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('gives up when the retry is rejected too', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    const requests = endpoint(CREATE_URL, fails(401, 'still unauthorized'));
    reissues('sess_new');
    const onExpired = watchForExpiry();

    await expect(sessionFetch(CREATE_URL)).rejects.toThrow('still unauthorized');

    expect(requests).toHaveLength(2);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(onExpired).toHaveBeenCalled();
  });

  it('keeps the session when the reissue itself fails', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    endpoint(CREATE_URL, fails(401, 'session expired'));
    reissueUnavailable();
    const onExpired = watchForExpiry();

    await expect(sessionFetch(CREATE_URL)).rejects.toThrow('session expired');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_old');
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('shares one reissue between requests that fail together', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    endpoint(LIST_URL, fails(401, 'session expired'), ok);
    endpoint(CREATE_URL, fails(401, 'session expired'), ok);
    const reissued = endpoint(SESSION_URL, () =>
      HttpResponse.json({ token: 'sess_new', login: ALICE.name, avatarUrl: ALICE.avatarUrl }),
    );

    await Promise.all([sessionFetch(LIST_URL), sessionFetch(CREATE_URL)]);

    expect(reissued).toHaveLength(1);
  });

  it('leaves the session alone on other errors', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    endpoint(CREATE_URL, fails(500, 'Server Error'));

    await expect(sessionFetch(CREATE_URL)).rejects.toThrow('Server Error');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_test');
  });
});

describe('sessionFetchJSON', () => {
  it('passes the session token as a plain object header', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    endpoint(LIST_URL, ok);

    await sessionFetchJSON(LIST_URL);

    expect(sdk.calls[0].method).toBe('GET');
    expect(sentHeaders()).not.toBeInstanceOf(Headers);
    expect(sentHeaders()[SESSION_HEADER.toLowerCase()]).toBe('sess_test');
  });

  it('clears the session and announces expiry on a 401 it cannot resume', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    endpoint(LIST_URL, fails(401, 'authentication required'));
    noStoredCredential();
    const onExpired = watchForExpiry();

    await expect(sessionFetchJSON(LIST_URL)).rejects.toThrow('authentication required');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(onExpired).toHaveBeenCalled();
  });

  it('reissues the session and retries once after a 401', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    const requests = endpoint(LIST_URL, fails(401, 'session expired'), () => HttpResponse.json([]));
    reissues('sess_new');

    await expect(sessionFetchJSON(LIST_URL)).resolves.toEqual([]);

    expect(requests[1].headers.get(SESSION_HEADER)).toBe('sess_new');
  });
});

describe('login', () => {
  it('exchanges the PAT for a session and returns the user', async () => {
    let sent: { pat?: string } = {};
    server.use(
      http.post(LOGIN_URL, async ({ request }) => {
        sent = (await request.json()) as { pat?: string };
        return HttpResponse.json({
          token: 'sess_new',
          login: ALICE.name,
          avatarUrl: ALICE.avatarUrl,
        });
      }),
    );

    await expect(login('ghp_valid')).resolves.toEqual(ALICE);

    expect(sent.pat).toBe('ghp_valid');
  });

  it('stores the session token, not the PAT', async () => {
    loginStub({ response: { token: 'sess_new', login: ALICE.name, avatarUrl: '' } });

    await login('ghp_valid');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_new');
    expect(sessionStorage.getItem(USER_KEY)).toBe(
      JSON.stringify({ name: ALICE.name, avatarUrl: '' }),
    );
    const allValues = Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k));
    expect(allValues).not.toContain('ghp_valid');
  });

  it('propagates the error when the backend rejects the PAT', async () => {
    loginStub({ errorResponse: { message: 'invalid github pat', status: 401 } });

    await expect(login('ghp_bad')).rejects.toThrow('invalid github pat');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});

describe('resume', () => {
  it('stores the reissued session and reports the user', async () => {
    reissues('sess_new');

    await expect(resumeSession()).resolves.toEqual(ALICE);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_new');
  });

  it('reports nothing to resume and clears up after a 404', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_stale');
    noStoredCredential();

    await expect(resumeSession()).resolves.toBeNull();

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it('throws and keeps the session when the backend cannot answer', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    reissueUnavailable();

    await expect(resumeSession()).rejects.toThrow('session store unavailable');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_old');
  });
});

describe('logout', () => {
  it('revokes on the backend and clears local state', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    const requests = endpoint(
      `${BACKEND_API}/api/v1/auth/logout`,
      () => new Response(null, { status: 204 }),
    );

    await logout();

    expect(requests[0].headers.get(SESSION_HEADER)).toBe('sess_test');
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(USER_KEY)).toBeNull();
  });

  it('clears local state even when revocation fails', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    logoutStub({ errorResponse: { message: 'session store unavailable', status: 503 } });

    await expect(logout()).resolves.toBeUndefined();

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});
