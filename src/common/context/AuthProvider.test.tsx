import { render, screen, waitFor } from '@testing-library/react';
import { useContext } from 'react';
import { AuthContext, AuthProvider } from './AuthProvider';
import { SESSION_TOKEN_KEY } from '../types';
import { startSessionFake, endSessionFake, resumeSessionStub } from '../testing/sessionClientStub';

const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: sdkTestDoubles.consoleFetchStub,
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONStub,
}));

function ConnectionState() {
  const { isAuthenticated, user } = useContext(AuthContext);
  return <div>{isAuthenticated ? `connected as ${user.name}` : 'not connected'}</div>;
}

describe('AuthProvider', () => {
  beforeEach(() => {
    endSessionFake();
  });

  it('resumes the session when the tab has no token', async () => {
    resumeSessionStub();

    render(
      <AuthProvider>
        <ConnectionState />
      </AuthProvider>,
    );

    expect(await screen.findByText('connected as twoGiants')).toBeInTheDocument();
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_test');
  });

  it('stays disconnected when the backend has no credential to resume', async () => {
    resumeSessionStub({ errorResponse: { message: 'no stored credential', status: 404 } });

    render(
      <AuthProvider>
        <ConnectionState />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('not connected')).toBeInTheDocument());
  });

  it('survives a resume the backend could not answer', async () => {
    resumeSessionStub({
      errorResponse: { message: 'session store unavailable', status: 503 },
    });

    render(
      <AuthProvider>
        <ConnectionState />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('not connected')).toBeInTheDocument());
  });

  it('does not ask for a session when the tab already has one', () => {
    startSessionFake();

    render(
      <AuthProvider>
        <ConnectionState />
      </AuthProvider>,
    );

    expect(screen.getByText('connected as twoGiants')).toBeInTheDocument();
  });
});
