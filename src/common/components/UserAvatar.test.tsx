import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { UserAvatar } from './UserAvatar';
import { SESSION_TOKEN_KEY, USER_KEY } from '../types';
import { AuthContext } from '../context/AuthProvider';
import { ReactNode } from 'react';
import { authenticateGithubFake, logoutGithubFake } from '../testing/authFake';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => {
  const consoleFetchJSON = Object.assign(
    async (url: string, _method?: string, options?: RequestInit) => {
      const res = await fetch(new URL(url, 'http://localhost').href, options);
      const json = await res.json();
      if (!res.ok) throw json;
      return json;
    },
    {
      post: async (url: string, body: unknown) => {
        const res = await fetch(new URL(url, 'http://localhost').href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw json;
        return json;
      },
    },
  );

  const consoleFetch = async (url: string, options?: RequestInit) => {
    const res = await fetch(new URL(url, 'http://localhost').href, options);
    if (!res.ok) throw await res.json();
    return res;
  };

  return { consoleFetch, consoleFetchJSON };
});

const LOGIN_URL = `${BACKEND_API}/api/v1/auth/login`;

const testUser = { name: 'twoGiants', avatarUrl: '' };

function authContext(overrides = {}) {
  return {
    isAuthenticated: false,
    user: testUser,
    connectionId: 0,
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
}

function renderWithContext(ui: ReactNode, contextValue = authContext()) {
  return render(<AuthContext.Provider value={contextValue}>{ui}</AuthContext.Provider>);
}

/** Everything sessionStorage holds, for asserting on what is not in it. */
function storedValues(): (string | null)[] {
  return Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key));
}

/** Puts the component in the connected state: authenticated context plus a stored session. */
function connectedContext(overrides = {}) {
  authenticateGithubFake();
  return authContext({ isAuthenticated: true, ...overrides });
}

describe('UserAvatar', () => {
  beforeEach(() => {
    logoutGithubFake();
    server.use(
      http.post(LOGIN_URL, () =>
        HttpResponse.json({ token: 'sess_new', login: 'twoGiants', avatarUrl: '' }),
      ),
    );
  });

  describe('rendering', () => {
    it('renders "Connect to GitHub" when not connected', () => {
      renderWithContext(<UserAvatar enableReconnect={false} />);

      expect(screen.getByText('Connect to GitHub')).toBeInTheDocument();
    });

    it('renders username when connected', () => {
      renderWithContext(<UserAvatar enableReconnect />, connectedContext());

      expect(screen.getByText('twoGiants')).toBeInTheDocument();
    });

    it('renders the GitHub avatar when the user has one', () => {
      const avatarUrl = 'https://avatars.githubusercontent.com/u/1?v=4';
      renderWithContext(
        <UserAvatar enableReconnect />,
        connectedContext({ user: { name: 'twoGiants', avatarUrl } }),
      );

      const avatar = document.querySelector('[data-test="user-avatar"]');
      expect(avatar).toHaveAttribute('src', avatarUrl);
      // The login is already rendered next to the image, so the avatar stays
      // out of the accessibility tree rather than repeating it.
      expect(avatar).toHaveAttribute('alt', '');
    });

    it('falls back to the generic icon when there is no avatar URL', () => {
      renderWithContext(<UserAvatar enableReconnect />, connectedContext());

      expect(document.querySelector('[data-test="user-avatar"]')).not.toBeInTheDocument();
      expect(screen.getByText('twoGiants')).toBeInTheDocument();
    });

    it('button is disabled when enableReconnect is false', async () => {
      const user = userEvent.setup();

      renderWithContext(<UserAvatar enableReconnect={false} />);

      const button = screen.getByRole('button', { name: 'Connect to GitHub' });
      expect(button).toBeDisabled();

      await user.click(button);
      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });
  });

  describe('disconnect', () => {
    it('shows Disconnect in the user menu', async () => {
      const user = userEvent.setup();

      renderWithContext(<UserAvatar enableReconnect />, connectedContext());

      await user.click(screen.getByRole('button', { name: /twoGiants/ }));

      expect(screen.getByText('Disconnect')).toBeInTheDocument();
    });

    it('calls onLogout when Disconnect is clicked', async () => {
      const user = userEvent.setup();
      const onLogout = vi.fn();

      renderWithContext(<UserAvatar enableReconnect />, connectedContext({ onLogout }));

      await user.click(screen.getByRole('button', { name: /twoGiants/ }));
      await user.click(screen.getByText('Disconnect'));

      expect(onLogout).toHaveBeenCalled();
    });

    it('does not show the user menu when disconnected', () => {
      renderWithContext(<UserAvatar enableReconnect={false} />);

      expect(screen.queryByText('twoGiants')).not.toBeInTheDocument();
    });
  });

  describe('modal auto-open', () => {
    it('opens modal automatically when enableReconnect is true and no session stored', () => {
      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.getByText('Personal Access Token')).toBeInTheDocument();
    });

    it('does not auto-open modal when a session is already stored', () => {
      authenticateGithubFake();

      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });

    it('does not auto-open modal when enableReconnect is false', () => {
      renderWithContext(<UserAvatar enableReconnect={false} />);

      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });
  });

  describe('OAuth button placeholder', () => {
    it('renders a disabled "Sign in with GitHub" button', () => {
      renderWithContext(<UserAvatar enableReconnect />);

      const oauthButton = screen.getByRole('button', { name: /Sign in with GitHub/i });
      expect(oauthButton).toHaveAttribute('aria-disabled', 'true');
    });

    it('does not trigger any action when clicked', async () => {
      const user = userEvent.setup();
      const onLogin = vi.fn();

      renderWithContext(<UserAvatar enableReconnect />, authContext({ onLogin }));

      const oauthButton = screen.getByRole('button', { name: /Sign in with GitHub/i });
      await user.click(oauthButton);

      expect(onLogin).not.toHaveBeenCalled();
    });
  });

  describe('PAT modal', () => {
    it('Connect button disabled when input is empty', () => {
      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    });

    it('exchanges the PAT for a session and stores the token, not the PAT', async () => {
      const user = userEvent.setup();
      const onLogin = vi.fn();

      renderWithContext(<UserAvatar enableReconnect />, authContext({ onLogin }));

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_valid');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => {
        expect(onLogin).toHaveBeenCalledWith(testUser);
      });

      expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('sess_new');
      expect(JSON.parse(sessionStorage.getItem(USER_KEY)!)).toEqual(testUser);
      expect(storedValues()).not.toContain('ghp_valid');
    });

    it('sends the PAT to the backend rather than to GitHub', async () => {
      const user = userEvent.setup();
      let sentBody: { pat?: string } = {};
      server.use(
        http.post(LOGIN_URL, async ({ request }) => {
          sentBody = (await request.json()) as { pat?: string };
          return HttpResponse.json({ token: 'sess_new', login: 'twoGiants', avatarUrl: '' });
        }),
      );

      renderWithContext(<UserAvatar enableReconnect />);

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_valid');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => {
        expect(sentBody.pat).toBe('ghp_valid');
      });
    });

    it('shows error alert when the backend rejects the PAT', async () => {
      const user = userEvent.setup();
      server.use(
        http.post(LOGIN_URL, () =>
          HttpResponse.json({ message: 'invalid github pat' }, { status: 401 }),
        ),
      );

      renderWithContext(<UserAvatar enableReconnect />);

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_bad');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText(/invalid github pat/)).toBeInTheDocument();
    });

    it('submits PAT when Enter is pressed in the input', async () => {
      const user = userEvent.setup();
      const onLogin = vi.fn();

      renderWithContext(<UserAvatar enableReconnect />, authContext({ onLogin }));

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_valid');
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(onLogin).toHaveBeenCalled();
      });
    });

    it('closes modal when Cancel is clicked', async () => {
      const user = userEvent.setup();

      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.getByText('Personal Access Token')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });

    it('clears PAT input and error on cancel', async () => {
      const user = userEvent.setup();
      server.use(
        http.post(LOGIN_URL, () =>
          HttpResponse.json({ message: 'invalid github pat' }, { status: 401 }),
        ),
      );

      renderWithContext(<UserAvatar enableReconnect />);

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_bad');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText(/invalid github pat/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('button', { name: 'Connect to GitHub' }));

      expect(screen.getByLabelText('Personal Access Token')).toHaveValue('');
      expect(screen.queryByText(/invalid github pat/)).not.toBeInTheDocument();
    });

    it('disables Cancel button while validating', async () => {
      const user = userEvent.setup();
      server.use(
        http.post(LOGIN_URL, async () => {
          await delay('infinite');
          return HttpResponse.json({ token: 'sess_new', login: 'twoGiants', avatarUrl: '' });
        }),
      );

      renderWithContext(<UserAvatar enableReconnect />);

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_slow');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });
  });
});
