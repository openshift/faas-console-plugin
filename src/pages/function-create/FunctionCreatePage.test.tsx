import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../testing/msw/server';
import { MemoryRouter } from 'react-router';
import FunctionCreatePage from './FunctionCreatePage';
import { PAT_KEY, USER_KEY } from '../../common/types';
import { BACKEND_API } from '../../../testing/setup';

const mockNavigate = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => {
  async function handleResponse(res: Response) {
    const json = await res.json();
    if (!res.ok) throw json;
    return json;
  }

  const consoleFetchJSON = Object.assign(
    async (url: string, _method?: string, options?: RequestInit) => {
      const res = await fetch(new URL(url, 'http://localhost').href, options);
      return handleResponse(res);
    },
    {
      post: async (url: string, body: unknown) => {
        const res = await fetch(new URL(url, 'http://localhost').href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return handleResponse(res);
      },
    },
  );

  const consoleFetch = async (url: string, options?: RequestInit) => {
    const res = await fetch(new URL(url, 'http://localhost').href, options);
    if (!res.ok) throw await res.json();
    return res;
  };

  return {
    DocumentTitle: ({ children }: { children: string }) => children,
    ListPageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => (
      <>
        {title}
        {children}
      </>
    ),
    consoleFetchJSON,
    consoleFetch,
    useK8sWatchResource: vi.fn().mockReturnValue([[], true, null]),
  };
});

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../common/components/UserAvatar', () => ({
  UserAvatar: ({ enableReconnect }: { enableReconnect: boolean }) => (
    <span data-testid="user-avatar">{enableReconnect ? 'reconnect' : 'no-reconnect'}</span>
  ),
}));

function setupCreateFlowHandlers() {
  server.use(
    http.post(`${BACKEND_API}/api/v1/func/create`, () => new HttpResponse(null, { status: 201 })),
  );
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <FunctionCreatePage />
    </MemoryRouter>,
  );

const fillForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
  await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
  await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
  await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');
};

describe('FunctionCreatePage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    sessionStorage.clear();
  });

  it('renders CreateFunctionForm', () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');

    renderPage();

    expect(screen.getByRole('textbox', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
  });

  it('creates function via backend, then navigates on submit', async () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: 'testuser', avatarUrl: '' }));
    const user = userEvent.setup();
    setupCreateFlowHandlers();

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/faas');
    });
  });

  it('shows an alert on error', async () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: 'testuser', avatarUrl: '' }));
    const user = userEvent.setup();

    server.use(
      http.post(`${BACKEND_API}/api/v1/func/create`, () =>
        HttpResponse.json({ message: 'Backend error' }, { status: 500 }),
      ),
    );

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(screen.getByText(/Backend error/)).toBeInTheDocument();
    });
  });

  it('renders UserAvatar in header', () => {
    renderPage();

    expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
  });

  it('shows warning and hides form when no PAT is set', () => {
    renderPage();

    expect(
      screen.getByText(/A GitHub Personal Access Token is required to create functions/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Owner/ })).not.toBeInTheDocument();
  });

  it('sends environment variables to backend during submission', async () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: 'testuser', avatarUrl: '' }));
    const user = userEvent.setup();
    let capturedRequest: Record<string, unknown> | null = null;
    server.use(
      http.post(`${BACKEND_API}/api/v1/func/create`, async ({ request }) => {
        capturedRequest = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 201 });
      }),
    );

    renderPage();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    const envSection = screen.getByRole('group', { name: /Environment Variables/ });
    const nameInput = within(envSection).getAllByRole('textbox', { name: /^Name$/ })[0];
    const valueInput = within(envSection).getByRole('textbox', { name: /^Value$/ });

    expect(nameInput).toBeInTheDocument();
    expect(valueInput).toBeInTheDocument();

    await user.type(nameInput, 'MY_VAR');
    await user.type(valueInput, 'my-value');
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/faas');
    });

    expect(capturedRequest).toBeTruthy();
    expect(capturedRequest!.envVars).toEqual([
      { name: 'MY_VAR', source: 'value', value: 'my-value', resourceName: '', resourceKey: '' },
    ]);
  });
});
