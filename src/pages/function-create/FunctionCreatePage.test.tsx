import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import FunctionCreatePage from './FunctionCreatePage';
import { BACKEND_API } from '../../common/testing/constants';
import { authenticateGithubFake, logoutGithubFake } from '../../common/testing/authFake';
import { server } from '../../common/testing/mswServer';

const mockNavigate = vi.fn();

// The role and the accessible namespaces drive which namespace control is rendered, so
// they are mutable per test rather than fixed in the module mock.
const cluster = vi.hoisted(() => ({
  canCreateNamespaces: true,
  projects: [] as { metadata: { name: string } }[],
}));

function asDeveloperWithNamespaces(...names: string[]) {
  cluster.canCreateNamespaces = false;
  cluster.projects = names.map((name) => ({ metadata: { name } }));
}

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
    if (!res.ok) {
      // Mirror the SDK: a non-ok response is thrown as an Error with the Response attached,
      // so callers can inspect the status (e.g. isNotFoundError on a 404).
      const json = await res.json();
      throw Object.assign(new Error(json.message), { response: res, json });
    }
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
    useK8sWatchResource: (config: { groupVersionKind?: { kind?: string } } | null) =>
      config?.groupVersionKind?.kind === 'Project'
        ? [cluster.projects, true, null]
        : [[], true, null],
    // Defaults to an admin, so the namespace field is a free-text input.
    useAccessReview: () => [cluster.canCreateNamespaces, false],
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
    logoutGithubFake();
    authenticateGithubFake();
  });

  afterEach(() => {
    vi.clearAllMocks();
    cluster.canCreateNamespaces = true;
    cluster.projects = [];
  });

  afterAll(() => {
    logoutGithubFake();
  });

  it('renders CreateFunctionForm', () => {
    renderPage();

    expect(screen.getByRole('textbox', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
  });

  it('creates function via backend, then navigates on submit', async () => {
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

  describe('namespace', () => {
    it('keeps every character the user types, without the debounce reverting it', async () => {
      const user = userEvent.setup();

      renderPage();

      const input = screen.getByRole('textbox', { name: /Namespace/ });
      await user.type(input, 'my-functions');

      expect(input).toHaveValue('my-functions');
      expect(screen.getByRole('textbox', { name: /Registry/ })).toHaveValue(
        'image-registry.openshift-image-registry.svc:5000/my-functions',
      );
    });

    it('derives the sole namespace for a developer who cannot create namespaces', () => {
      asDeveloperWithNamespaces('team-a');

      renderPage();

      const input = screen.getByRole('textbox', { name: /Namespace/ });
      expect(input).toHaveValue('team-a');
      expect(input).toBeDisabled();
      // The derived namespace has to reach the registry too, otherwise the image would be
      // pushed to a registry path with no namespace.
      expect(screen.getByRole('textbox', { name: /Registry/ })).toHaveValue(
        'image-registry.openshift-image-registry.svc:5000/team-a',
      );
    });

    it('lets a developer with a derived sole namespace submit', async () => {
      const user = userEvent.setup();
      asDeveloperWithNamespaces('team-a');
      let captured: Record<string, unknown> | null = null;
      server.use(
        http.post(`${BACKEND_API}/api/v1/func/create`, async ({ request }) => {
          captured = (await request.json()) as Record<string, unknown>;
          return new HttpResponse(null, { status: 201 });
        }),
      );

      renderPage();

      await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
      await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
      await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');

      const create = screen.getByRole('button', { name: /Create/ });
      expect(create).toBeEnabled();
      await user.click(create);

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/faas'));
      expect(captured!.namespace).toBe('team-a');
    });

    it('offers a dropdown to a developer with several namespaces', () => {
      asDeveloperWithNamespaces('team-a', 'team-b');

      renderPage();

      expect(screen.getByRole('combobox', { name: /Namespace/ })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'team-a' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'team-b' })).toBeInTheDocument();
    });

    it('submits the namespace typed immediately before clicking Create', async () => {
      const user = userEvent.setup();
      let captured: Record<string, unknown> | null = null;
      server.use(
        http.post(`${BACKEND_API}/api/v1/func/create`, async ({ request }) => {
          captured = (await request.json()) as Record<string, unknown>;
          return new HttpResponse(null, { status: 201 });
        }),
      );

      renderPage();
      await fillForm(user);
      // No wait for the debounce here: submitting straight away must still send the value
      // on screen rather than the previously settled one.
      await user.click(screen.getByRole('button', { name: /Create/ }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/faas'));
      expect(captured!.namespace).toBe('default');
    });
  });

  it('renders UserAvatar in header', () => {
    logoutGithubFake();
    renderPage();

    expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
  });

  it('shows warning and hides form when no PAT is set', () => {
    logoutGithubFake();
    renderPage();

    expect(
      screen.getByText(/A GitHub Personal Access Token is required to create functions/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Owner/ })).not.toBeInTheDocument();
  });

  it('sends environment variables to backend during submission', async () => {
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
