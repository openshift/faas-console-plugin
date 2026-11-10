import {
  connectGithubUserStub,
  disconnectGithubUserStub,
  fetchGithubUserStub,
  noGithubUserStub,
} from '../testing/authClientStub';
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

describe('authClient', () => {
  describe('connectGithubUser', () => {
    it('maps the backend account to an AuthUser', async () => {
      connectGithubUserStub();

      await expect(connectGithubUser('ghp_token')).resolves.toEqual({
        name: 'twoGiants',
        avatarUrl: 'https://valid.url',
      });
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
      fetchGithubUserStub({ networkError: true });

      await expect(fetchGithubUser()).rejects.toBeInstanceOf(Error);
    });
  });

  describe('disconnectGithubUser', () => {
    it('still resolves when the DELETE fails', async () => {
      disconnectGithubUserStub({
        errorResponse: { message: 'revocation failed', status: 500 },
      });

      await expect(disconnectGithubUser()).resolves.toBeUndefined();
    });
  });
});
