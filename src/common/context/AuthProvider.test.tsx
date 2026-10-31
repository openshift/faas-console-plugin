import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useContext } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AuthContext, AuthProvider } from './AuthProvider';
import { AUTH_EXPIRED_EVENT } from '../types';
import {
  disconnectGithubUserStub,
  fetchGithubUserStub,
  noGithubUserStub,
} from '../testing/authClientStub';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';

const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: sdkTestDoubles.consoleFetchStub,
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONStub,
}));

const CREDENTIAL_URL = `${BACKEND_API}/api/v1/scm/github/credential`;

function ConnectionState() {
  const { isAuthenticated, user } = useContext(AuthContext);
  return (
    <>
      <div>{isAuthenticated ? `connected as ${user?.name}` : 'not connected'}</div>
      <div>{user === null ? 'user is null' : 'user is present'}</div>
    </>
  );
}

function LoginButton() {
  const { onLogin } = useContext(AuthContext);
  return (
    <button onClick={() => onLogin({ name: 'twoGiants', avatarUrl: 'https://valid.url' })}>
      Log in
    </button>
  );
}

function LogoutButton() {
  const { onLogout } = useContext(AuthContext);
  return <button onClick={() => void onLogout()}>Log out</button>;
}

// AuthProvider navigates on logout, so it needs a router above it.
function renderProvider() {
  render(
    <MemoryRouter>
      <AuthProvider>
        <ConnectionState />
        <LoginButton />
        <LogoutButton />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AuthProvider', () => {
  // A user whose PAT is already in a Secret opens the console and
  // is connected, having typed nothing.
  it('connects a user whose credential the backend already holds', async () => {
    fetchGithubUserStub();

    renderProvider();

    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();
  });

  it('stays disconnected when the backend holds no credential', async () => {
    noGithubUserStub();

    renderProvider();

    await waitFor(() => expect(screen.getByText('not connected')).toBeInTheDocument());
  });

  it('stays disconnected when the backend cannot answer', async () => {
    fetchGithubUserStub({
      errorResponse: { message: 'credential store unavailable', status: 503 },
    });

    renderProvider();

    await waitFor(() => expect(screen.getByText('not connected')).toBeInTheDocument());
  });

  // Children must not mount before the answer arrives, or they would act on
  // "not connected" when the backend is about to say otherwise.
  it('holds its children back until the backend answers', async () => {
    fetchGithubUserStub();

    renderProvider();

    expect(screen.queryByText('not connected')).not.toBeInTheDocument();
    expect(screen.queryByText(/connected as/)).not.toBeInTheDocument();

    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();
  });

  it('disconnects when a request reports the credential is gone', async () => {
    fetchGithubUserStub();

    renderProvider();
    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    });

    await waitFor(() => expect(screen.getByText('not connected')).toBeInTheDocument());
  });

  it('exposes a null user while disconnected', async () => {
    noGithubUserStub();

    renderProvider();

    expect(await screen.findByText('user is null')).toBeInTheDocument();
  });

  it('connects a user who logs in by hand', async () => {
    noGithubUserStub();

    renderProvider();
    expect(await screen.findByText('not connected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();
  });

  it('disconnects and revokes the stored credential on logout', async () => {
    fetchGithubUserStub();
    let revoked = false;
    server.use(
      http.delete(CREDENTIAL_URL, () => {
        revoked = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderProvider();
    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await screen.findByText('not connected')).toBeInTheDocument();
    // The backend DELETE must finish before the UI drops the connection.
    expect(revoked).toBe(true);
  });

  it('shows the expiry warning after the credential expires', async () => {
    fetchGithubUserStub();

    renderProvider();
    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    });

    expect(await screen.findByText(/session has expired/)).toBeInTheDocument();
    expect(screen.getByText('not connected')).toBeInTheDocument();
  });

  it('clears the expiry warning once the user reconnects', async () => {
    fetchGithubUserStub();

    renderProvider();
    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    });
    expect(await screen.findByText(/session has expired/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();
    expect(screen.queryByText(/session has expired/)).not.toBeInTheDocument();
  });

  it('navigates to the functions list after logout', async () => {
    fetchGithubUserStub();
    disconnectGithubUserStub();

    render(
      <MemoryRouter initialEntries={['/faas/edit/my-func']}>
        <Routes>
          <Route
            path="/faas/edit/:name"
            element={
              <AuthProvider>
                <ConnectionState />
                <LogoutButton />
              </AuthProvider>
            }
          />
          <Route path="/faas" element={<div>Functions list</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await screen.findByText('Functions list')).toBeInTheDocument();
    expect(screen.queryByText('connected as twoGiants')).not.toBeInTheDocument();
  });
});
