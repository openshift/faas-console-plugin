import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { authenticateGithubFake, logoutGithubFake } from '../../common/testing/authFake';
import { BACKEND_API } from '../../common/testing/constants';
import { server } from '../../common/testing/mswServer';
import { CreateFunctionRequest } from '../../common/types';
import FunctionCreatePage from './FunctionCreatePage';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the sdkTestDoubles available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../../common/testing/sdkTestDoubles'));

const mockNavigate = vi.hoisted(() => vi.fn());

const REGISTRY = 'image-registry.openshift-image-registry.svc:5000/';

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
    async (url: string, method?: string, options?: RequestInit) => {
      const res = await fetch(new URL(url, 'http://localhost').href, options);
      return handleResponse(res);
    },
    {
      post: async (url: string, body: object) => {
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
    useAccessReview: sdkTestDoubles.useAccessReviewStub,
    useK8sWatchResource: sdkTestDoubles.useK8sWatchResourceStub,
  };
});

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mockNavigate,
}));

describe('FunctionCreatePage', () => {
  beforeEach(() => {
    logoutGithubFake();
    authenticateGithubFake();
    // Most flows are exercised as a user who may create namespaces, because that is the only
    // role whose namespace field is a free-text input. The developer branches arrange their
    // own fixtures.
    asUserWhoCanCreateNamespaces();
  });

  afterEach(() => {
    vi.clearAllMocks();
    act(() => sdkTestDoubles.reset());
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
    backendAccepting();

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

    expect(await screen.findByText(/Backend error/)).toBeInTheDocument();
  });

  it('sends environment variables to backend during submission', async () => {
    const user = userEvent.setup();
    backendAccepting({
      envVars: [
        { name: 'MY_VAR', source: 'value', value: 'my-value', resourceName: '', resourceKey: '' },
      ],
    });

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    const envSection = screen.getByRole('group', { name: /Environment Variables/ });
    await user.type(within(envSection).getAllByRole('textbox', { name: /^Name$/ })[0], 'MY_VAR');
    await user.type(within(envSection).getByRole('textbox', { name: /^Value$/ }), 'my-value');
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/faas'));
  });

  it('renders UserAvatar in header', () => {
    renderPage();

    expect(screen.getByText('twoGiants')).toBeInTheDocument();
  });

  it('shows warning and hides form when no PAT is set', () => {
    logoutGithubFake();

    renderPage();

    expect(
      screen.getByText(/A GitHub Personal Access Token is required to create functions/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Owner/ })).not.toBeInTheDocument();
  });

  describe('namespace', () => {
    describe('user who can create namespaces', () => {
      it('keeps every character the user types, without the debounce reverting it', async () => {
        const user = userEvent.setup();

        renderPage();
        const input = screen.getByRole('textbox', { name: /Namespace/ });
        await user.type(input, 'my-functions');

        expect(input).toHaveValue('my-functions');
        expect(registryInput()).toHaveValue(`${REGISTRY}my-functions`);
      });

      it('submits the namespace typed immediately before clicking Create', async () => {
        const user = userEvent.setup();
        backendAccepting({ namespace: 'default' });

        renderPage();
        await fillForm(user);
        // No wait for the debounce here: submitting straight away must still send the value
        // on screen rather than the previously settled one.
        await user.click(screen.getByRole('button', { name: /Create/ }));

        await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/faas'));
      });

      it('warns when the typed namespace does not exist', async () => {
        const user = userEvent.setup();
        asUserWhoCanCreateNamespaces('team-a');

        renderPage();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'ghost');

        expect(screen.getByText(/does not exist/i)).toBeInTheDocument();
      });

      it('does not warn about non-existence when the namespace exists', async () => {
        const user = userEvent.setup();
        asUserWhoCanCreateNamespaces('team-a');

        renderPage();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'team-a');

        expect(screen.queryByText(/does not exist/i)).not.toBeInTheDocument();
      });

      it('does not warn about non-existence before the namespace list is known', async () => {
        const user = userEvent.setup();
        asUserWhoCanCreateNamespaces();

        renderPage();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'ghost');

        expect(screen.queryByText(/does not exist/i)).not.toBeInTheDocument();
      });

      it('does not block Create for a namespace that does not exist', async () => {
        const user = userEvent.setup();
        asUserWhoCanCreateNamespaces('team-a');

        renderPage();
        await fillForm(user, 'ghost');

        expect(screen.getByText(/does not exist/i)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled());
      });

      it('warns when a system namespace is typed', async () => {
        const user = userEvent.setup();

        renderPage();
        expect(screen.queryByText(/system namespace/i)).not.toBeInTheDocument();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'openshift-monitoring');

        expect(screen.getByText(/system namespace/i)).toBeInTheDocument();
      });

      it('does not warn about a system namespace for a normal namespace', async () => {
        const user = userEvent.setup();

        renderPage();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'my-functions');

        expect(screen.queryByText(/system namespace/i)).not.toBeInTheDocument();
      });

      it('does not block Create for a system namespace', async () => {
        const user = userEvent.setup();

        renderPage();
        await fillForm(user);

        expect(screen.getByText(/system namespace/i)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled());
      });
    });

    describe('developer with no namespaces', () => {
      it('explains that there is nothing to deploy into and offers no namespace control', () => {
        asDeveloperWithNamespaces();

        renderPage();

        expect(screen.getByText(/no namespaces available/i)).toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: /Namespace/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: /Namespace/ })).not.toBeInTheDocument();
      });

      it('explains the same when the only accessible namespaces are system namespaces', () => {
        asDeveloperWithNamespaces('openshift-monitoring', 'kube-system');

        renderPage();

        expect(screen.getByText(/no namespaces available/i)).toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: /Namespace/ })).not.toBeInTheDocument();
      });
    });

    describe('developer with exactly one namespace', () => {
      it('derives the sole namespace, disables the field, and feeds the registry', async () => {
        asDeveloperWithNamespaces('team-a');

        renderPage();

        const input = screen.getByRole('textbox', { name: /Namespace/ });
        expect(input).toHaveValue('team-a');
        expect(input).toBeDisabled();
        // Nothing is selectable, so the value has to reach the form on its own, otherwise the
        // registry path and the submitted namespace would be empty.
        await waitFor(() => expect(registryInput()).toHaveValue(`${REGISTRY}team-a`));
      });

      it('derives the sole namespace after system namespaces are filtered out', async () => {
        asDeveloperWithNamespaces('openshift-monitoring', 'team-a', 'kube-system');

        renderPage();

        expect(screen.getByRole('textbox', { name: /Namespace/ })).toHaveValue('team-a');
        await waitFor(() => expect(registryInput()).toHaveValue(`${REGISTRY}team-a`));
      });

      it('lets the user submit without touching the namespace field', async () => {
        const user = userEvent.setup();
        asDeveloperWithNamespaces('team-a');
        backendAccepting({ namespace: 'team-a' });

        renderPage();
        await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
        await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
        await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
        const create = screen.getByRole('button', { name: /Create/ });
        expect(create).toBeEnabled();
        await user.click(create);

        await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/faas'));
      });
    });

    describe('developer with several namespaces', () => {
      it('offers a dropdown of the accessible namespaces', () => {
        asDeveloperWithNamespaces('team-a', 'team-b');

        renderPage();

        expect(screen.getByRole('combobox', { name: /Namespace/ })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'team-a' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'team-b' })).toBeInTheDocument();
      });

      it('leaves system namespaces out of the dropdown', () => {
        asDeveloperWithNamespaces('team-a', 'openshift-monitoring', 'kube-system', 'team-b');

        renderPage();

        expect(screen.getByRole('option', { name: 'team-a' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'team-b' })).toBeInTheDocument();
        expect(
          screen.queryByRole('option', { name: 'openshift-monitoring' }),
        ).not.toBeInTheDocument();
        expect(screen.queryByRole('option', { name: 'kube-system' })).not.toBeInTheDocument();
      });

      it('applies the picked namespace to the form without warning about it', async () => {
        const user = userEvent.setup();
        asDeveloperWithNamespaces('team-a', 'team-b');

        renderPage();
        const dropdown = screen.getByRole('combobox', { name: /Namespace/ });
        await user.selectOptions(dropdown, 'team-a');

        expect(dropdown).toHaveValue('team-a');
        expect(registryInput()).toHaveValue(`${REGISTRY}team-a`);
        expect(screen.queryByText(/does not exist/i)).not.toBeInTheDocument();
      });
    });
  });
});

// -----------------------------------------------------------------------------
// Arrange helpers -------------------------------------------------------------
// -----------------------------------------------------------------------------
function asUserWhoCanCreateNamespaces(...names: string[]) {
  setProjects(true, names);
}

function asDeveloperWithNamespaces(...names: string[]) {
  setProjects(false, names);
}

function setProjects(canCreate: boolean, names: string[]) {
  sdkTestDoubles.setWatchFixtures({
    canCreate,
    projects: names.map((name) => sdkTestDoubles.projectFixture(name)),
  });
}

// Behaves like a backend that validates its input: it accepts the create request only when the
// payload matches and rejects anything else. The page navigates away on success and shows an
// alert on rejection, so the assertion stays on what the user sees.
function backendAccepting(expected: Partial<CreateFunctionRequest> = {}) {
  const keys = Object.keys(expected) as (keyof CreateFunctionRequest)[];

  server.use(
    http.post(`${BACKEND_API}/api/v1/func/create`, async ({ request }) => {
      const body = (await request.json()) as CreateFunctionRequest;
      const matches = keys.every(
        (key) => JSON.stringify(body[key]) === JSON.stringify(expected[key]),
      );
      if (!matches) {
        return HttpResponse.json({ message: 'Unexpected payload' }, { status: 422 });
      }
      return new HttpResponse(null, { status: 201 });
    }),
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <FunctionCreatePage />
    </MemoryRouter>,
  );
}

async function fillForm(user: ReturnType<typeof userEvent.setup>, namespace = 'default') {
  await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
  await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
  await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
  await user.type(screen.getByRole('textbox', { name: /Namespace/ }), namespace);
}

function registryInput() {
  return screen.getByRole('textbox', { name: /Registry/ });
}
