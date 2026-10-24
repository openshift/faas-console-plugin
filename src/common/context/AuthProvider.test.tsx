import { render, screen, waitFor } from '@testing-library/react';
import { useContext } from 'react';
import { AuthContext, AuthProvider } from './AuthProvider';
import { AUTH_EXPIRED_EVENT } from '../types';
import { fetchGithubUserStub, noGithubUserStub } from '../testing/authClientStub';

const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../clients/httpClient', () => ({
  customFetch: sdkTestDoubles.customFetchStub,
  customFetchJSON: sdkTestDoubles.customFetchJSONStub,
}));

function ConnectionState() {
  const { isAuthenticated, user } = useContext(AuthContext);
  return <div>{isAuthenticated ? `connected as ${user.name}` : 'not connected'}</div>;
}

function renderProvider() {
  render(
    <AuthProvider>
      <ConnectionState />
    </AuthProvider>,
  );
}

describe('AuthProvider', () => {
  // The fix this whole change is for: a user whose PAT is already in a Secret
  // opens the console and is connected, having typed nothing.
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
  it('holds its children back until the backend answers', () => {
    fetchGithubUserStub();

    renderProvider();

    expect(screen.queryByText('not connected')).not.toBeInTheDocument();
    expect(screen.queryByText(/connected as/)).not.toBeInTheDocument();
  });

  it('disconnects when a request reports the credential is gone', async () => {
    fetchGithubUserStub();

    renderProvider();
    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));

    await waitFor(() => expect(screen.getByText('not connected')).toBeInTheDocument());
  });
});
