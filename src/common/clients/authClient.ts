import { AuthUser, PROXY_BASE } from '../types';
import { resolveErrorStatus } from '../utils/utils';
import { customFetch, customFetchJSON } from './httpClient';

export { customFetch, customFetchJSON } from './httpClient';

const CREDENTIAL_URL = `${PROXY_BASE}/api/v1/scm/github/credential`;

interface AccountResponse {
  login: string;
  avatarUrl: string;
}

export async function connectGithubUser(pat: string): Promise<AuthUser> {
  const account = await customFetchJSON<AccountResponse>(CREDENTIAL_URL, 'POST', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pat }),
  });
  return toUser(account);
}

// Resolves null only when the backend says it holds nothing, which is the
// signal to ask for a PAT.
export async function fetchGithubUser(): Promise<AuthUser | null> {
  try {
    const account = await customFetchJSON<AccountResponse>(CREDENTIAL_URL);
    return toUser(account);
  } catch (err) {
    if (resolveErrorStatus(err) !== 404) throw err;
    return null;
  }
}

export async function disconnectGithubUser(): Promise<void> {
  try {
    await customFetch(CREDENTIAL_URL, { method: 'DELETE' });
  } catch {
    // Best effort: the stored credential expires on its own, and leaving the
    // caller looking connected because revocation failed is the worse outcome.
  }
}

function toUser({ login, avatarUrl }: AccountResponse): AuthUser {
  return { name: login, avatarUrl };
}
