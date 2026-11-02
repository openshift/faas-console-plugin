import { http, HttpResponse } from 'msw';
import {
  connectGithubUserStub,
  disconnectGithubUserStub,
  fetchGithubUserStub,
  noGithubUserStub,
} from '../testing/authClientStub';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { connectGithubUser, disconnectGithubUser, fetchGithubUser } from './authClient';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the sdkTestDoubles available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  HttpError: sdkTestDoubles.HttpError,
  consoleFetch: sdkTestDoubles.consoleFetchStub,
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONStub,
}));

const CREDENTIAL_URL = `${BACKEND_API}/api/v1/scm/github/credential`;

afterEach(() => {
  server.resetHandlers();
});

describe('connectGithubUser', () => {
  it('maps the backend account to an AuthUser', async () => {
    connectGithubUserStub();

    await expect(connectGithubUser('ghp_token')).resolves.toEqual({
      name: 'twoGiants',
      avatarUrl: 'https://valid.url',
    });
  });

  it('posts the PAT to the credential endpoint', async () => {
    let captured: Request | undefined;
    server.use(
      http.post(CREDENTIAL_URL, ({ request }) => {
        captured = request;
        return HttpResponse.json({ login: 'twoGiants', avatarUrl: '' });
      }),
    );

    await connectGithubUser('ghp_token');

    expect(captured?.method).toBe('POST');
    expect(captured?.headers.get('content-type')).toBe('application/json');
    await expect(captured?.json()).resolves.toEqual({ pat: 'ghp_token' });
  });
});

describe('fetchGithubUser', () => {
  it('maps the backend account to an AuthUser', async () => {
    fetchGithubUserStub();

    await expect(fetchGithubUser()).resolves.toEqual({
      name: 'twoGiants',
      avatarUrl: 'https://valid.url',
    });
  });

  it('resolves null when the backend reports 404', async () => {
    noGithubUserStub();

    await expect(fetchGithubUser()).resolves.toBeNull();
  });

  it('rethrows errors other than 404', async () => {
    fetchGithubUserStub({
      errorResponse: { message: 'credential store unavailable', status: 503 },
    });

    await expect(fetchGithubUser()).rejects.toMatchObject({ code: 503 });
  });

  it('propagates errors that carry no status', async () => {
    server.use(http.get(CREDENTIAL_URL, () => HttpResponse.error()));

    await expect(fetchGithubUser()).rejects.toBeInstanceOf(Error);
  });
});

describe('disconnectGithubUser', () => {
  it('sends a DELETE to the credential endpoint', async () => {
    let captured: Request | undefined;
    server.use(
      http.delete(CREDENTIAL_URL, ({ request }) => {
        captured = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await disconnectGithubUser();

    expect(captured?.method).toBe('DELETE');
  });

  it('still resolves when the DELETE fails', async () => {
    disconnectGithubUserStub({
      errorResponse: { message: 'revocation failed', status: 500 },
    });

    await expect(disconnectGithubUser()).resolves.toBeUndefined();
  });
});
