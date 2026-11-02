import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { UserAvatar } from './UserAvatar';
import { AuthProvider } from '../context/AuthProvider';
import {
  connectGithubUserStub,
  disconnectGithubUserStub,
  fetchGithubUserStub,
  noGithubUserStub,
} from '../testing/authClientStub';
import { server } from '../testing/mswServer';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the sdkTestDoubles available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  HttpError: sdkTestDoubles.HttpError,
  consoleFetch: sdkTestDoubles.consoleFetchStub,
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONStub,
}));

// The avatar reads its state from AuthProvider, which resolves the connection
// on mount, so every render goes through the provider and awaits its outcome.
function renderAvatar() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <UserAvatar />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('UserAvatar', () => {
  beforeEach(() => {
    connectGithubUserStub({ response: { login: 'twoGiants', avatarUrl: '' } });
    disconnectGithubUserStub();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  describe('rendering', () => {
    it('prompts for a PAT and shows no user menu when the backend holds no credential', async () => {
      noGithubUserStub();
      renderAvatar();

      expect(await screen.findByRole('dialog', { name: /Connect to GitHub/ })).toBeInTheDocument();
      expect(screen.queryByText('twoGiants')).not.toBeInTheDocument();
    });

    it('renders username when connected', async () => {
      fetchGithubUserStub();
      renderAvatar();

      expect(await screen.findByText('twoGiants')).toBeInTheDocument();
    });

    it('renders the GitHub avatar with the user name as its alt text', async () => {
      const avatarUrl = 'https://avatars.githubusercontent.com/u/1?v=4';
      fetchGithubUserStub({ response: { login: 'twoGiants', avatarUrl } });
      renderAvatar();

      const avatar = await screen.findByRole('img', { name: 'twoGiants' });
      expect(avatar).toHaveAttribute('src', avatarUrl);
    });

    it('falls back to the generic icon when there is no avatar URL', async () => {
      fetchGithubUserStub({ response: { login: 'twoGiants', avatarUrl: '' } });
      renderAvatar();

      expect(await screen.findByText('twoGiants')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'twoGiants' })).not.toBeInTheDocument();
    });
  });

  describe('disconnect', () => {
    it('shows Disconnect in the user menu', async () => {
      const user = userEvent.setup();
      fetchGithubUserStub();
      renderAvatar();

      await user.click(await screen.findByRole('button', { name: /twoGiants/ }));

      expect(screen.getByText('Disconnect')).toBeInTheDocument();
    });

    it('returns to the connect flow when Disconnect is clicked', async () => {
      const user = userEvent.setup();
      fetchGithubUserStub();
      renderAvatar();

      await user.click(await screen.findByRole('button', { name: /twoGiants/ }));
      await user.click(screen.getByText('Disconnect'));

      expect(await screen.findByRole('button', { name: 'Connect to GitHub' })).toBeInTheDocument();
    });
  });

  describe('modal auto-open', () => {
    it('does not prompt a user when the backend has a credential', async () => {
      fetchGithubUserStub();
      renderAvatar();

      expect(await screen.findByText('twoGiants')).toBeInTheDocument();
      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });

    it('does not reopen the modal after the user dismisses it', async () => {
      const user = userEvent.setup();
      noGithubUserStub();
      renderAvatar();

      await user.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });
  });

  describe('OAuth button placeholder', () => {
    it('renders a disabled "Sign in with GitHub" button', async () => {
      noGithubUserStub();
      renderAvatar();

      const oauthButton = await screen.findByRole('button', { name: /Sign in with GitHub/i });
      expect(oauthButton).toHaveAttribute('aria-disabled', 'true');
    });

    it('keeps the modal open when the disabled button is clicked', async () => {
      const user = userEvent.setup();
      noGithubUserStub();
      renderAvatar();

      await user.click(await screen.findByRole('button', { name: /Sign in with GitHub/i }));

      expect(screen.getByText('Personal Access Token')).toBeInTheDocument();
    });
  });

  describe('PAT modal', () => {
    it('disables Connect while the input is empty', async () => {
      noGithubUserStub();
      renderAvatar();

      expect(await screen.findByText('Personal Access Token')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    });

    it('connects the user when the backend accepts the PAT', async () => {
      const user = userEvent.setup();
      noGithubUserStub();
      renderAvatar();

      await user.type(await screen.findByLabelText('Personal Access Token'), 'ghp_valid');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText('twoGiants')).toBeInTheDocument();
      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });

    it('shows error alert when the backend rejects the PAT', async () => {
      const user = userEvent.setup();
      connectGithubUserStub({ errorResponse: { message: 'invalid SCM token', status: 403 } });
      noGithubUserStub();
      renderAvatar();

      await user.type(await screen.findByLabelText('Personal Access Token'), 'ghp_bad');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText(/invalid SCM token/)).toBeInTheDocument();
    });

    it('connects the user when Enter is pressed in the input', async () => {
      const user = userEvent.setup();
      noGithubUserStub();
      renderAvatar();

      await user.type(await screen.findByLabelText('Personal Access Token'), 'ghp_valid');
      await user.keyboard('{Enter}');

      expect(await screen.findByText('twoGiants')).toBeInTheDocument();
    });

    it('closes modal when Cancel is clicked', async () => {
      const user = userEvent.setup();
      noGithubUserStub();
      renderAvatar();

      expect(await screen.findByText('Personal Access Token')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Personal Access Token')).not.toBeInTheDocument();
    });

    it('clears PAT input and error on cancel', async () => {
      const user = userEvent.setup();
      connectGithubUserStub({ errorResponse: { message: 'invalid SCM token', status: 403 } });
      noGithubUserStub();
      renderAvatar();

      await user.type(await screen.findByLabelText('Personal Access Token'), 'ghp_bad');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText(/invalid SCM token/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('button', { name: 'Connect to GitHub' }));

      expect(screen.getByLabelText('Personal Access Token')).toHaveValue('');
      expect(screen.queryByText(/invalid SCM token/)).not.toBeInTheDocument();
    });

    it('disables Cancel button while validating', async () => {
      const user = userEvent.setup();
      connectGithubUserStub({ wait: new Promise(() => {}) });
      noGithubUserStub();
      renderAvatar();

      await user.type(await screen.findByLabelText('Personal Access Token'), 'ghp_slow');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });
  });
});
