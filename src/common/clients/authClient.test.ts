import { PROXY_BASE } from '../types';
import { connectGithubUser, disconnectGithubUser, fetchGithubUser } from './authClient';
import { customFetch, customFetchJSON } from './httpClient';

vi.mock('./httpClient', () => ({
  customFetch: vi.fn(),
  customFetchJSON: vi.fn(),
}));

const customFetchDouble = vi.mocked(customFetch);
const customFetchJSONDouble = vi.mocked(customFetchJSON);

const CREDENTIAL_URL = `${PROXY_BASE}/api/v1/scm/github/credential`;

afterEach(() => {
  vi.clearAllMocks();
});

describe('connectGithubUser', () => {
  it('maps the backend account to an AuthUser', async () => {
    customFetchJSONDouble.mockResolvedValueOnce({
      login: 'twoGiants',
      avatarUrl: 'https://valid.url',
    });

    await expect(connectGithubUser('ghp_token')).resolves.toEqual({
      name: 'twoGiants',
      avatarUrl: 'https://valid.url',
    });
  });

  it('posts the PAT to the credential endpoint', async () => {
    customFetchJSONDouble.mockResolvedValueOnce({ login: 'twoGiants', avatarUrl: '' });

    await connectGithubUser('ghp_token');

    expect(customFetchJSONDouble).toHaveBeenCalledWith(CREDENTIAL_URL, 'POST', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pat: 'ghp_token' }),
    });
  });
});

describe('fetchGithubUser', () => {
  it('maps the backend account to an AuthUser', async () => {
    customFetchJSONDouble.mockResolvedValueOnce({
      login: 'twoGiants',
      avatarUrl: 'https://valid.url',
    });

    await expect(fetchGithubUser()).resolves.toEqual({
      name: 'twoGiants',
      avatarUrl: 'https://valid.url',
    });
  });

  it('resolves null when the backend reports 404 (top-level status)', async () => {
    customFetchJSONDouble.mockRejectedValueOnce(
      Object.assign(new Error('no credential stored'), { status: 404 }) as never,
    );

    await expect(fetchGithubUser()).resolves.toBeNull();
  });

  it('resolves null when the backend reports 404 (response.status)', async () => {
    customFetchJSONDouble.mockRejectedValueOnce(
      Object.assign(new Error('no credential stored'), { response: { status: 404 } }) as never,
    );

    await expect(fetchGithubUser()).resolves.toBeNull();
  });

  it('rethrows errors other than 404', async () => {
    const error = Object.assign(new Error('credential store unavailable'), { status: 503 });
    customFetchJSONDouble.mockRejectedValueOnce(error as never);

    await expect(fetchGithubUser()).rejects.toBe(error);
  });

  it('propagates errors that carry no status', async () => {
    const error = new Error('network down');
    customFetchJSONDouble.mockRejectedValueOnce(error as never);

    await expect(fetchGithubUser()).rejects.toBe(error);
  });
});

describe('disconnectGithubUser', () => {
  it('sends a DELETE to the credential endpoint', async () => {
    customFetchDouble.mockResolvedValueOnce(new Response(null));

    await disconnectGithubUser();

    expect(customFetchDouble).toHaveBeenCalledWith(CREDENTIAL_URL, { method: 'DELETE' });
  });

  it('still resolves when the DELETE fails', async () => {
    customFetchDouble.mockRejectedValueOnce(new Error('revocation failed') as never);

    await expect(disconnectGithubUser()).resolves.toBeUndefined();
  });
});
