import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { fetchGithubUserStub, noGithubUserStub } from '../../common/testing/authClientStub';
import { createFunctionStub, getNamespacesStub } from '../../common/testing/functionsClientStub';
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

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  HttpError: sdkTestDoubles.HttpError,
  consoleFetch: sdkTestDoubles.consoleFetchStub,
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONStub,
  DocumentTitle: ({ children }: { children: string }) => children,
  ListPageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <>
      {title}
      {children}
    </>
  ),
  useActiveNamespace: sdkTestDoubles.useActiveNamespaceStub,
  useK8sWatchResource: sdkTestDoubles.useK8sWatchResourceStub,
}));

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => mockNavigate,
}));

vi.mock('../../common/components/UserAvatar', () => ({
  UserAvatar: () => <span data-testid="user-avatar" />,
}));

describe('FunctionCreatePage', () => {
  beforeEach(() => {
    fetchGithubUserStub();
    // Most flows are exercised as a user who may create namespaces, because that is the only
    // role whose namespace field is a free-text input. The developer branches arrange their
    // own fixtures.
    asUserWhoCanCreateNamespaces();
  });

  afterEach(() => {
    vi.clearAllMocks();
    act(() => sdkTestDoubles.reset());
  });

  it('renders CreateFunctionForm for a user the backend already connected', async () => {
    await renderPage();

    expect(await screen.findByRole('textbox', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
  });

  it('creates function via backend, then navigates on submit', async () => {
    const user = userEvent.setup();
    createFunctionStub();

    await renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/faas');
    });
  });

  it('shows an alert on error', async () => {
    const user = userEvent.setup();
    createFunctionStub({ errorResponse: { message: 'Backend error', status: 500 } });

    await renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    expect(await screen.findByText(/Backend error/)).toBeInTheDocument();
  });

  it('sends environment variables to the backend', async () => {
    const user = userEvent.setup();
    const requests = createFunctionStub();

    await renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    const envSection = screen.getByRole('group', { name: /Environment Variables/ });
    await user.type(within(envSection).getAllByRole('textbox', { name: /^Name$/ })[0], 'MY_VAR');
    await user.type(within(envSection).getByRole('textbox', { name: /^Value$/ }), 'my-value');
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/faas'));
    expect(requests).toHaveLength(1);
    expect(requests[0].envVars).toEqual([
      { name: 'MY_VAR', source: 'value', value: 'my-value', resourceName: '', resourceKey: '' },
    ]);
  });

  it('shows a spinner instead of the form until the namespaces have loaded', () => {
    getNamespacesStub({ wait: new Promise(() => {}) });

    render(
      <MemoryRouter>
        <FunctionCreatePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Namespace/ })).not.toBeInTheDocument();
  });

  it('renders UserAvatar in header', async () => {
    noGithubUserStub();
    await renderPage();

    expect(await screen.findByTestId('user-avatar')).toBeInTheDocument();
  });

  it('hides form when the backend holds no credential', async () => {
    noGithubUserStub();
    await renderPage();

    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /Owner/ })).not.toBeInTheDocument(),
    );
  });

  describe('namespace', () => {
    describe('user who can create namespaces', () => {
      it('keeps every character the user types, without the debounce reverting it', async () => {
        const user = userEvent.setup();

        await renderPage();
        const input = screen.getByRole('textbox', { name: /Namespace/ });
        await user.type(input, 'my-functions');

        expect(input).toHaveValue('my-functions');
        expect(registryInput()).toHaveValue(`${REGISTRY}my-functions`);
      });

      it('warns when the typed namespace does not exist', async () => {
        const user = userEvent.setup();
        asUserWhoCanCreateNamespaces('team-a');

        await renderPage();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'ghost');

        expect(screen.getByText(/does not exist/i)).toBeInTheDocument();
      });

      it('does not warn about non-existence when the namespace exists', async () => {
        const user = userEvent.setup();
        asUserWhoCanCreateNamespaces('team-a');

        await renderPage();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'team-a');

        expect(screen.queryByText(/does not exist/i)).not.toBeInTheDocument();
      });

      it('does not warn about non-existence before the namespace list is known', async () => {
        const user = userEvent.setup();
        asUserWhoCanCreateNamespaces();

        await renderPage();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'ghost');

        expect(screen.queryByText(/does not exist/i)).not.toBeInTheDocument();
      });

      it('does not block Create for a namespace that does not exist', async () => {
        const user = userEvent.setup();
        asUserWhoCanCreateNamespaces('team-a');

        await renderPage();
        await fillForm(user, 'ghost');

        expect(screen.getByText(/does not exist/i)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled());
      });

      it('warns when a system namespace is typed', async () => {
        const user = userEvent.setup();

        await renderPage();
        expect(screen.queryByText(/system namespace/i)).not.toBeInTheDocument();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'openshift-monitoring');

        expect(screen.getByText(/system namespace/i)).toBeInTheDocument();
      });

      it('does not warn about a system namespace for a normal namespace', async () => {
        const user = userEvent.setup();

        await renderPage();
        await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'my-functions');

        expect(screen.queryByText(/system namespace/i)).not.toBeInTheDocument();
      });

      it('does not block Create for a system namespace', async () => {
        const user = userEvent.setup();

        await renderPage();
        await fillForm(user);

        expect(screen.getByText(/system namespace/i)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled());
      });
    });

    describe('developer with no namespaces', () => {
      it('explains that there is nothing to deploy into and offers no namespace control', async () => {
        asDeveloperWithNamespaces();

        await renderPage();

        expect(screen.getByText(/no namespaces available/i)).toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: /Namespace/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: /Namespace/ })).not.toBeInTheDocument();
      });
    });

    describe('developer with exactly one namespace', () => {
      it('derives the sole namespace, disables the field, and feeds the registry', async () => {
        asDeveloperWithNamespaces('team-a');

        await renderPage();

        const input = screen.getByRole('textbox', { name: /Namespace/ });
        expect(input).toHaveValue('team-a');
        expect(input).toBeDisabled();
        // Nothing is selectable, so the value has to reach the form on its own, otherwise the
        // registry path and the submitted namespace would be empty.
        await waitFor(() => expect(registryInput()).toHaveValue(`${REGISTRY}team-a`));
      });

      it('lets the user submit without touching the namespace field', async () => {
        const user = userEvent.setup();
        asDeveloperWithNamespaces('team-a');
        const requests = createFunctionStub();

        await renderPage();
        await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
        await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
        await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
        const create = screen.getByRole('button', { name: /Create/ });
        expect(create).toBeEnabled();
        await user.click(create);

        await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/faas'));
        expect(requests).toHaveLength(1);
        expect(requests[0].namespace).toBe('team-a');
      });
    });

    describe('developer with several namespaces', () => {
      it('offers a dropdown of the accessible namespaces', async () => {
        asDeveloperWithNamespaces('team-a', 'team-b');

        await renderPage();

        expect(screen.getByRole('combobox', { name: /Namespace/ })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'team-a' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'team-b' })).toBeInTheDocument();
      });

      it('applies the picked namespace to the form without warning about it', async () => {
        const user = userEvent.setup();
        asDeveloperWithNamespaces('team-a', 'team-b');

        await renderPage();
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

function setProjects(canCreateNamespaces: boolean, namespaces: string[]) {
  getNamespacesStub({ canCreateNamespaces, namespaces });
}

// Renders the page and waits for the namespace options to arrive from the backend, since the
// form is held back behind a spinner until then.
async function renderPage() {
  const view = render(
    <MemoryRouter>
      <FunctionCreatePage />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.queryByRole('progressbar', { name: 'Loading' })).not.toBeInTheDocument(),
  );
  return view;
}

// The form appears only once the backend has confirmed a stored credential,
// so every flow through it waits for that answer first.
async function fillForm(user: ReturnType<typeof userEvent.setup>, namespace = 'default') {
  await screen.findByRole('textbox', { name: /Owner/ });
  await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
  await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
  await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
  await user.type(screen.getByRole('textbox', { name: /Namespace/ }), namespace);
}

function registryInput() {
  return screen.getByRole('textbox', { name: /Registry/ });
}
