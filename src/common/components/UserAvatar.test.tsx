import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../../../testing/msw/server';
import { UserAvatar } from './UserAvatar';
import { PAT_KEY, USER_KEY } from '../services/types';
import { ForgeConnectionContext } from '../context/ForgeConnectionProvider';
import { ReactNode } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const GITHUB_API = 'https://api.github.com';

const testUser = { name: 'twoGiants' };

function renderWithContext(
  ui: ReactNode,
  contextValue = { isActive: false, user: testUser, connectionId: 0, connectToForge: vi.fn() },
) {
  return render(
    <ForgeConnectionContext.Provider value={contextValue}>{ui}</ForgeConnectionContext.Provider>,
  );
}

describe('UserAvatar', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterAll(() => {
    sessionStorage.clear();
  });

  describe('rendering', () => {
    it('renders "Connect to GitHub" when no user is stored', () => {
      renderWithContext(<UserAvatar enableReconnect={false} />);

      expect(screen.getByText('Connect to GitHub')).toBeInTheDocument();
    });

    it('renders username when user is stored in sessionStorage', () => {
      sessionStorage.setItem(PAT_KEY, 'ghp_test');
      sessionStorage.setItem(USER_KEY, JSON.stringify(testUser));

      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.getByText('twoGiants')).toBeInTheDocument();
    });

    it('button is clickable when enableReconnect is true', async () => {
      const user = userEvent.setup();
      sessionStorage.setItem(PAT_KEY, 'ghp_test');
      sessionStorage.setItem(USER_KEY, JSON.stringify(testUser));

      renderWithContext(<UserAvatar enableReconnect />);

      const button = screen.getByRole('button', { name: 'twoGiants' });
      await user.click(button);

      expect(screen.getByText('Personal Access Token')).toBeInTheDocument();
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

  describe('modal auto-open', () => {
    it('opens modal automatically when enableReconnect is true and no PAT stored', () => {
      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.getByText('Personal Access Token')).toBeInTheDocument();
    });

    it('does not auto-open modal when PAT is already stored', () => {
      sessionStorage.setItem(PAT_KEY, 'ghp_test');
      sessionStorage.setItem(USER_KEY, JSON.stringify(testUser));

      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });

    it('does not auto-open modal when enableReconnect is false', () => {
      renderWithContext(<UserAvatar enableReconnect={false} />);

      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });
  });

  describe('PAT modal', () => {
    it('Connect button disabled when input is empty', () => {
      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    });

    it('calls GitHub API with PAT and updates UI on successful connect', async () => {
      const user = userEvent.setup();
      const connectToForge = vi.fn();

      renderWithContext(<UserAvatar enableReconnect />, {
        isActive: false,
        user: testUser,
        connectionId: 0,
        connectToForge,
      });

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_valid');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => {
        expect(screen.getByText('twoGiants')).toBeInTheDocument();
      });

      expect(sessionStorage.getItem(PAT_KEY)).toBe('ghp_valid');
      expect(JSON.parse(sessionStorage.getItem(USER_KEY)!)).toEqual(testUser);
      expect(connectToForge).toHaveBeenCalled();
    });

    it('shows error alert when GitHub API rejects', async () => {
      const user = userEvent.setup();
      server.use(
        http.get(`${GITHUB_API}/user`, () =>
          HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
        ),
      );

      renderWithContext(<UserAvatar enableReconnect />);

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_bad');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText(/Bad credentials/)).toBeInTheDocument();
    });

    it('closes modal when Cancel is clicked', async () => {
      const user = userEvent.setup();

      renderWithContext(<UserAvatar enableReconnect />);

      expect(screen.getByText('Personal Access Token')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });

    it('clears PAT input after successful connect', async () => {
      const user = userEvent.setup();
      const connectToForge = vi.fn();

      renderWithContext(<UserAvatar enableReconnect />, {
        isActive: false,
        user: testUser,
        connectionId: 0,
        connectToForge,
      });

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_valid');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => {
        expect(screen.getByText('twoGiants')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'twoGiants' }));

      expect(screen.getByLabelText('Personal Access Token')).toHaveValue('');
    });

    it('clears PAT input and error on cancel', async () => {
      const user = userEvent.setup();
      server.use(
        http.get(`${GITHUB_API}/user`, () =>
          HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
        ),
      );

      renderWithContext(<UserAvatar enableReconnect />);

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_bad');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText(/Bad credentials/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('button', { name: 'Connect to GitHub' }));

      expect(screen.getByLabelText('Personal Access Token')).toHaveValue('');
      expect(screen.queryByText(/Bad credentials/)).not.toBeInTheDocument();
    });

    it('disables Cancel button while validating', async () => {
      const user = userEvent.setup();
      server.use(
        http.get(`${GITHUB_API}/user`, async () => {
          await delay('infinite');
          return HttpResponse.json({ login: 'twoGiants' });
        }),
      );

      renderWithContext(<UserAvatar enableReconnect />);

      await user.type(screen.getByLabelText('Personal Access Token'), 'ghp_slow');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });
  });
});
