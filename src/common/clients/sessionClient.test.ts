import { consoleFetch, consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { logout, resumeSession, sessionFetch, sessionFetchJSON } from './sessionClient';
import { SESSION_EXPIRED_EVENT, SESSION_HEADER, SESSION_TOKEN_KEY, USER_KEY } from '../types';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: vi.fn(),
  consoleFetchJSON: Object.assign(vi.fn(), { post: vi.fn() }),
}));

const fetchMock = vi.mocked(consoleFetch);
const fetchJSONMock = vi.mocked(consoleFetchJSON);

function sentHeaders(options: RequestInit | undefined) {
  return options?.headers as Record<string, string>;
}

function coFetchError(status: number, message = 'request failed') {
  return Object.assign(new Error(message), { response: new Response(null, { status }) });
}
function httpError(status: number, message = 'request failed') {
  return Object.assign(new Error(message), { status, response: new Response(null, { status }) });
}
function reissues(token: string) {
  vi.mocked(consoleFetchJSON.post).mockResolvedValue({
    token,
    login: 'alice-gh',
    avatarUrl: 'https://example.com/avatar',
  });
}
function noStoredCredential() {
  vi.mocked(consoleFetchJSON.post).mockRejectedValue(coFetchError(404, 'no stored credential'));
}
function reissueUnavailable() {
  vi.mocked(consoleFetchJSON.post).mockRejectedValue(
    coFetchError(503, 'session store unavailable'),
  );
}
function watchForExpiry() {
  const onExpired = vi.fn();
  window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
  onTestFinished(() => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired));
  return onExpired;
}

describe('sessionFetch', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    fetchJSONMock.mockResolvedValue({});
  });

  it('sends the stored session token', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');

    await sessionFetch('/api/v1/func/create', { method: 'POST' });

    const [, options] = fetchMock.mock.calls[0];
    expect(sentHeaders(options)[SESSION_HEADER.toLowerCase()]).toBe('sess_test');
  });

  it('passes headers as a plain object, not a Headers instance', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');

    await sessionFetch('/api/v1/func/create');

    const [, options] = fetchMock.mock.calls[0];
    expect(sentHeaders(options)).not.toBeInstanceOf(Headers);
    expect(Object.keys(sentHeaders(options))).toContain(SESSION_HEADER.toLowerCase());
  });

  it('keeps headers supplied by the caller', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');

    await sessionFetch('/api/v1/func/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(sentHeaders(options)['content-type']).toBe('application/json');
  });

  it('omits the session header when there is no session', async () => {
    await sessionFetch('/api/v1/func/create');

    const [, options] = fetchMock.mock.calls[0];
    expect(Object.keys(sentHeaders(options))).not.toContain(SESSION_HEADER.toLowerCase());
  });

  // Regression: the console reports the code only on the attached Response.
  // Checking err.status alone left the user looking connected against a session
  // the backend had already forgotten.
  it('clears the session and announces expiry on a 401 it cannot resume', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    fetchMock.mockRejectedValue(coFetchError(401, 'authentication required'));
    noStoredCredential();
    const onExpired = watchForExpiry();

    await expect(sessionFetch('/api/v1/func/create')).rejects.toThrow('authentication required');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(onExpired).toHaveBeenCalled();
  });

  it('clears the session when the 401 arrives as an HttpError', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    fetchMock.mockRejectedValue(httpError(401, 'Unauthorized'));
    noStoredCredential();

    await expect(sessionFetch('/api/v1/func/create')).rejects.toThrow('Unauthorized');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it('reissues the session and retries once after a 401', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    fetchMock
      .mockRejectedValueOnce(coFetchError(401, 'session expired'))
      .mockResolvedValue(new Response(null, { status: 200 }));
    reissues('sess_new');
    const onExpired = watchForExpiry();

    await expect(sessionFetch('/api/v1/func/create')).resolves.toBeInstanceOf(Response);

    const [, retried] = fetchMock.mock.calls[1];
    expect(sentHeaders(retried)[SESSION_HEADER.toLowerCase()]).toBe('sess_new');
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('gives up when the retry is rejected too', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    fetchMock.mockRejectedValue(coFetchError(401, 'still unauthorized'));
    reissues('sess_new');
    const onExpired = watchForExpiry();

    await expect(sessionFetch('/api/v1/func/create')).rejects.toThrow('still unauthorized');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(onExpired).toHaveBeenCalled();
  });

  it('keeps the session when the reissue itself fails', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    fetchMock.mockRejectedValue(coFetchError(401, 'session expired'));
    reissueUnavailable();
    const onExpired = watchForExpiry();

    await expect(sessionFetch('/api/v1/func/create')).rejects.toThrow('session expired');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_old');
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('shares one reissue between requests that fail together', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    fetchMock
      .mockRejectedValueOnce(coFetchError(401, 'session expired'))
      .mockRejectedValueOnce(coFetchError(401, 'session expired'))
      .mockResolvedValue(new Response(null, { status: 200 }));
    reissues('sess_new');

    await Promise.all([sessionFetch('/api/v1/func/list'), sessionFetch('/api/v1/func/create')]);

    expect(fetchJSONMock.post).toHaveBeenCalledTimes(1);
  });

  it('leaves the session alone on other errors', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    fetchMock.mockRejectedValue(coFetchError(500, 'Server Error'));

    await expect(sessionFetch('/api/v1/func/create')).rejects.toThrow('Server Error');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_test');
  });
});

describe('sessionFetchJSON', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    fetchJSONMock.mockResolvedValue({});
  });

  it('passes the session token as a plain object header', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');

    await sessionFetchJSON('/api/v1/func/list');

    const [, method, options] = fetchJSONMock.mock.calls[0];
    expect(method).toBe('GET');
    expect(sentHeaders(options)).not.toBeInstanceOf(Headers);
    expect(sentHeaders(options)[SESSION_HEADER.toLowerCase()]).toBe('sess_test');
  });

  it('clears the session and announces expiry on a 401 it cannot resume', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    fetchJSONMock.mockRejectedValue(coFetchError(401, 'authentication required'));
    noStoredCredential();
    const onExpired = watchForExpiry();

    await expect(sessionFetchJSON('/api/v1/func/list')).rejects.toThrow('authentication required');

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(onExpired).toHaveBeenCalled();
  });

  it('reissues the session and retries once after a 401', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_old');
    fetchJSONMock.mockRejectedValueOnce(coFetchError(401, 'session expired')).mockResolvedValue([]);
    reissues('sess_new');

    await expect(sessionFetchJSON('/api/v1/func/list')).resolves.toEqual([]);

    const [, , retried] = fetchJSONMock.mock.calls[1];
    expect(sentHeaders(retried)[SESSION_HEADER.toLowerCase()]).toBe('sess_new');
  });
});

describe('resume', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('stores the reissued session and reports the user', async () => {
    reissues('sess_new');

    await expect(resumeSession()).resolves.toEqual({
      name: 'alice-gh',
      avatarUrl: 'https://example.com/avatar',
    });
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
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it('revokes on the backend and clears local state', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');

    await logout();

    const [, options] = fetchMock.mock.calls[0];
    expect(sentHeaders(options)[SESSION_HEADER]).toBe('sess_test');
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(USER_KEY)).toBeNull();
  });

  it('clears local state even when revocation fails', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_test');
    fetchMock.mockRejectedValue(coFetchError(503, 'session store unavailable'));

    await expect(logout()).resolves.toBeUndefined();

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});
