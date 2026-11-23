import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { fetchGithubUserStub, noGithubUserStub } from '../../common/testing/authClientStub';
import {
  createFunctionStub,
  getConfigMapsStub,
  getNamespacesStub,
  getSecretsStub,
} from '../../common/testing/functionsClientStub';
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
    // Most flows are exercised as a user who may create namespaces, who picks from every
    // namespace. The developer branches arrange their own fixtures.
    asUserWhoCanCreateNamespaces('default', 'my-functions');
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
    getNamespacesStub({ wait: heldUntilTestEnds().held });

    render(
      <MemoryRouter>
        <FunctionCreatePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Namespace/ })).not.toBeInTheDocument();
  });

  it('offers the secrets and config maps of the chosen namespace', async () => {
    const user = userEvent.setup();
    asUserWhoCanCreateNamespaces('team-a');
    getSecretsStub({ byNamespace: { 'team-a': [{ name: 'db-credentials', keys: ['password'] }] } });
    getConfigMapsStub({ byNamespace: { 'team-a': [{ name: 'app-settings', keys: ['mode'] }] } });

    await renderPage();
    await user.selectOptions(screen.getByRole('combobox', { name: /Namespace/ }), 'team-a');
    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    expect(await screen.findByRole('option', { name: 'db-credentials' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'app-settings' })).toBeInTheDocument();
  });

  it('shows why the namespaces could not be loaded instead of the form', async () => {
    getNamespacesStub({ errorResponse: { message: 'failed to list namespaces', status: 502 } });

    await renderPage();

    expect(screen.getByText('Error loading namespaces')).toBeInTheDocument();
    expect(screen.getByText('failed to list namespaces')).toBeInTheDocument();
    expect(screen.queryByText(/no namespaces available/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create/ })).not.toBeInTheDocument();
  });

  it('explains when the user cannot read Secrets in the chosen namespace', async () => {
    const user = userEvent.setup();
    asUserWhoCanCreateNamespaces('team-a');
    getSecretsStub({
      errorResponse: { message: 'not allowed to list secrets in namespace team-a', status: 403 },
    });

    await renderPage();
    await user.selectOptions(screen.getByRole('combobox', { name: /Namespace/ }), 'team-a');

    expect(await screen.findByText(/cannot read Secrets or ConfigMaps/)).toBeInTheDocument();
    expect(screen.queryByText('Error loading Secrets and ConfigMaps')).not.toBeInTheDocument();
  });

  it('shows the backend message when Secrets fail to load, separately from create errors', async () => {
    const user = userEvent.setup();
    asUserWhoCanCreateNamespaces('team-a');
    getSecretsStub({ errorResponse: { message: 'failed to list secrets', status: 502 } });

    await renderPage();
    await user.selectOptions(screen.getByRole('combobox', { name: /Namespace/ }), 'team-a');

    expect(await screen.findByText('Error loading Secrets and ConfigMaps')).toBeInTheDocument();
    expect(screen.getByText('failed to list secrets')).toBeInTheDocument();
    expect(screen.queryByText('Error creating function')).not.toBeInTheDocument();
  });

  it('drops a slow answer for a namespace the user has already moved away from', async () => {
    const user = userEvent.setup();
    asUserWhoCanCreateNamespaces('team-a', 'team-b');
    const teamA = heldUntilTestEnds();
    const requested = getSecretsStub({
      byNamespace: {
        'team-a': [{ name: 'team-a-secret', keys: ['k'] }],
        'team-b': [{ name: 'team-b-secret', keys: ['k'] }],
      },
      waitFor: { 'team-a': teamA.held },
    });

    await renderPage();
    const field = screen.getByRole('combobox', { name: /Namespace/ });
    await user.selectOptions(field, 'team-a');
    await waitFor(() => expect(requested).toContain('team-a'));
    await user.selectOptions(field, 'team-b');
    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));
    expect(await screen.findByRole('option', { name: 'team-b-secret' })).toBeInTheDocument();

    teamA.release();
    await waitFor(() => expect(requested).toEqual(['team-a', 'team-b']));
    // Give the late answer a chance to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByRole('option', { name: 'team-b-secret' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'team-a-secret' })).not.toBeInTheDocument();
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
      it('offers every namespace in a dropdown, system namespaces included', async () => {
        getNamespacesStub({
          canCreateNamespaces: true,
          namespaces: ['kube-system', 'openshift-monitoring', 'team-a'],
          systemNamespaces: ['kube-system', 'openshift-monitoring'],
        });

        await renderPage();

        expect(screen.queryByRole('textbox', { name: /Namespace/ })).not.toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: /Namespace/ })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'kube-system' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'openshift-monitoring' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'team-a' })).toBeInTheDocument();
      });

      it('offers a dropdown even when there is a single namespace', async () => {
        asUserWhoCanCreateNamespaces('team-a');

        await renderPage();

        expect(screen.getByRole('combobox', { name: /Namespace/ })).toBeEnabled();
      });

      it('warns when a namespace the backend reports as a system namespace is picked', async () => {
        const user = userEvent.setup();
        getNamespacesStub({
          canCreateNamespaces: true,
          namespaces: ['openshift-monitoring', 'team-a'],
          systemNamespaces: ['openshift-monitoring'],
        });

        await renderPage();
        expect(screen.queryByText(/system namespace/i)).not.toBeInTheDocument();
        await user.selectOptions(
          screen.getByRole('combobox', { name: /Namespace/ }),
          'openshift-monitoring',
        );

        expect(screen.getByText(/system namespace/i)).toBeInTheDocument();
      });

      it('does not warn about a system namespace for a normal namespace', async () => {
        const user = userEvent.setup();

        await renderPage();
        await user.selectOptions(
          screen.getByRole('combobox', { name: /Namespace/ }),
          'my-functions',
        );

        expect(screen.queryByText(/system namespace/i)).not.toBeInTheDocument();
      });

      it('does not block Create for a system namespace', async () => {
        const user = userEvent.setup();
        getNamespacesStub({
          canCreateNamespaces: true,
          namespaces: ['default', 'team-a'],
          systemNamespaces: ['default'],
        });

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

    describe('console active namespace', () => {
      it('pre-selects the active namespace when the user may deploy there', async () => {
        sdkTestDoubles.setActiveNamespace('team-b');
        asUserWhoCanCreateNamespaces('team-a', 'team-b');

        await renderPage();

        expect(screen.getByRole('combobox', { name: /Namespace/ })).toHaveValue('team-b');
        expect(registryInput()).toHaveValue(`${REGISTRY}team-b`);
      });

      it('does not pre-select a system namespace', async () => {
        sdkTestDoubles.setActiveNamespace('default');
        getNamespacesStub({
          canCreateNamespaces: true,
          namespaces: ['default', 'team-a'],
          systemNamespaces: ['default'],
        });

        await renderPage();

        expect(screen.getByRole('combobox', { name: /Namespace/ })).toHaveValue('');
      });

      it('leaves the field empty when the active namespace is not one the user may pick', async () => {
        sdkTestDoubles.setActiveNamespace('someone-elses');
        asUserWhoCanCreateNamespaces('team-a', 'team-b');

        await renderPage();

        expect(screen.getByRole('combobox', { name: /Namespace/ })).toHaveValue('');
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

      it('loads the Secrets of the namespace picked from the dropdown', async () => {
        const user = userEvent.setup();
        asDeveloperWithNamespaces('team-a', 'team-b');
        getSecretsStub({ byNamespace: { 'team-b': [{ name: 'team-b-secret', keys: ['k'] }] } });

        await renderPage();
        await user.selectOptions(screen.getByRole('combobox', { name: /Namespace/ }), 'team-b');
        await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

        expect(await screen.findByRole('option', { name: 'team-b-secret' })).toBeInTheDocument();
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
// A backend answer held back until release() is called, and released when the test ends at the
// latest, so no request is left pending after the test.
function heldUntilTestEnds() {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  onTestFinished(() => release());
  return { held, release };
}

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
  await user.selectOptions(screen.getByRole('combobox', { name: /Namespace/ }), namespace);
}

function registryInput() {
  return screen.getByRole('textbox', { name: /Registry/ });
}
