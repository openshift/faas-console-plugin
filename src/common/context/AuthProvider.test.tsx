import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { render, screen, waitFor } from '@testing-library/react';
import { useContext } from 'react';
import { AuthContext, AuthProvider } from './AuthProvider';
import { SESSION_TOKEN_KEY, USER_KEY } from '../types';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: vi.fn(),
  consoleFetchJSON: Object.assign(vi.fn(), { post: vi.fn() }),
}));

const resumeMock = vi.mocked(consoleFetchJSON.post);

function ConnectionState() {
  const { isAuthenticated, user } = useContext(AuthContext);
  return <div>{isAuthenticated ? `connected as ${user.name}` : 'not connected'}</div>;
}

describe('AuthProvider', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('resumes the session when the tab has no token', async () => {
    resumeMock.mockResolvedValue({
      token: 'sess_new',
      login: 'alice-gh',
      avatarUrl: 'https://example.com/avatar',
    });

    render(
      <AuthProvider>
        <ConnectionState />
      </AuthProvider>,
    );

    expect(await screen.findByText('connected as alice-gh')).toBeInTheDocument();
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_new');
  });

  it('stays disconnected when the backend has no credential to resume', async () => {
    resumeMock.mockRejectedValue(
      Object.assign(new Error('no stored credential'), {
        response: new Response(null, { status: 404 }),
      }),
    );

    render(
      <AuthProvider>
        <ConnectionState />
      </AuthProvider>,
    );

    await waitFor(() => expect(resumeMock).toHaveBeenCalled());
    expect(screen.getByText('not connected')).toBeInTheDocument();
  });

  it('survives a resume the backend could not answer', async () => {
    resumeMock.mockRejectedValue(
      Object.assign(new Error('session store unavailable'), {
        response: new Response(null, { status: 503 }),
      }),
    );

    render(
      <AuthProvider>
        <ConnectionState />
      </AuthProvider>,
    );

    await waitFor(() => expect(resumeMock).toHaveBeenCalled());
    expect(screen.getByText('not connected')).toBeInTheDocument();
  });

  it('does not ask for a session when the tab already has one', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'sess_existing');
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: 'alice-gh', avatarUrl: '' }));

    render(
      <AuthProvider>
        <ConnectionState />
      </AuthProvider>,
    );

    expect(screen.getByText('connected as alice-gh')).toBeInTheDocument();
    expect(resumeMock).not.toHaveBeenCalled();
  });
});
