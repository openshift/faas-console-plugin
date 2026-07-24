import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateFunctionForm } from './CreateFunctionForm';
import { ForgeConnectionContext } from '../../../common/context/ForgeConnectionProvider';
import { ForgeUser, K8sKeyedResource } from '../../../common/services/types';

const testUser: ForgeUser = { name: 'testuser' };
const forgeContext = {
  isActive: true,
  user: testUser,
  connectionId: 0,
  connectToForge: vi.fn(),
};

function renderWithContext(ui: React.ReactElement) {
  return render(
    <ForgeConnectionContext.Provider value={forgeContext}>{ui}</ForgeConnectionContext.Provider>,
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const emptySecrets: K8sKeyedResource[] = [];
const emptyConfigMaps: K8sKeyedResource[] = [];

describe('CreateFunctionForm', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  const defaultProps = {
    onSubmit,
    onCancel,
    onNamespaceChange: vi.fn(),
    isSubmitting: false,
    secrets: emptySecrets,
    configMaps: emptyConfigMaps,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all form fields', () => {
    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    expect(screen.getByRole('textbox', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Repository/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Branch/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Name$/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Language/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Registry/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Namespace/ })).toBeInTheDocument();
  });

  it('presets owner from context and disables the field', () => {
    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    const ownerInput = screen.getByRole('textbox', { name: /Owner/ });
    expect(ownerInput).toHaveValue('testuser');
    expect(ownerInput).toBeDisabled();
  });

  it('presets registry to OCP internal registry and disables the field', () => {
    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    const registryInput = screen.getByRole('textbox', { name: /Registry/ });
    expect(registryInput).toHaveValue('image-registry.openshift-image-registry.svc:5000/');
    expect(registryInput).toBeDisabled();
  });

  it('updates registry to include namespace when namespace is typed', async () => {
    const user = userEvent.setup();

    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'my-ns');

    expect(screen.getByRole('textbox', { name: /Registry/ })).toHaveValue(
      'image-registry.openshift-image-registry.svc:5000/my-ns',
    );
  });

  it('renders Create and Cancel buttons', () => {
    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument();
  });

  it('disables Create button when required fields are empty', () => {
    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
  });

  it('disables Create button when isSubmitting is true', () => {
    renderWithContext(<CreateFunctionForm {...defaultProps} isSubmitting={true} />);

    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();

    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onSubmit with form data when form is filled and Create is clicked', async () => {
    const user = userEvent.setup();

    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
    await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
    await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');

    await user.click(screen.getByRole('button', { name: /Create/ }));

    expect(onSubmit).toHaveBeenCalledWith({
      owner: 'testuser',
      repo: 'my-repo',
      branch: 'main',
      name: 'my-func',
      runtime: 'node',
      registry: 'image-registry.openshift-image-registry.svc:5000/default',
      namespace: 'default',
      plainEnvVars: [],
      secretEnvVars: [],
      configMapEnvVars: [],
    });
  });

  it('renders the Environment Variables section with empty row after expansion', async () => {
    const user = userEvent.setup();
    const { container } = renderWithContext(<CreateFunctionForm {...defaultProps} />);

    expect(screen.getByText('Environment Variables')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    expect(screen.getAllByRole('button', { name: /Add key\/value/ })[0]).toBeInTheDocument();
    expect(container.querySelector('#env-name-0')).toBeInTheDocument();
    expect(container.querySelector('#env-value-0')).toBeInTheDocument();
  });

  it('renders Secrets and ConfigMaps groups', async () => {
    const user = userEvent.setup();
    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    expect(screen.getByText('Secrets')).toBeInTheDocument();
    expect(screen.getByText('ConfigMaps')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add key\/value/ }).length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('enables Create button when all required fields and valid env vars are filled', async () => {
    const user = userEvent.setup();

    const { container } = renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
    await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
    await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));
    await user.click(screen.getAllByRole('button', { name: /Add key\/value/ })[0]);

    const envName0 = container.querySelector('#env-name-0');
    const envValue0 = container.querySelector('#env-value-0');
    const envName1 = container.querySelector('#env-name-1');
    const envValue1 = container.querySelector('#env-value-1');

    if (!envName0 || !envValue0 || !envName1 || !envValue1) {
      throw new Error('Env var inputs not found');
    }

    await user.type(envName0, 'MY_VAR');
    await user.type(envValue0, 'my-value');
    await user.type(envName1, 'OTHER_VAR');
    await user.type(envValue1, 'other-value');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create/ })).not.toBeDisabled();
    });
  });

  it('disables Create button when env var has empty name', async () => {
    const user = userEvent.setup();

    const { container } = renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
    await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
    await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));
    await user.click(screen.getAllByRole('button', { name: /Add key\/value/ })[0]);

    const envValueInput = container.querySelector('#env-value-0');
    if (!envValueInput) throw new Error('Env value input not found');

    await user.type(envValueInput, 'my-value');

    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
  });

  it('removes the last env var row when Remove is clicked', async () => {
    const user = userEvent.setup();

    const { container } = renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));
    await user.click(screen.getAllByRole('button', { name: /Add key\/value/ })[0]);

    const envNameInputs = container.querySelectorAll('[id^="env-name-"]');
    expect(envNameInputs).toHaveLength(2);

    const removeButtons = screen.getAllByRole('button', { name: /^Remove$/ });
    await user.click(removeButtons[0]);

    const remaining = container.querySelectorAll('[id^="env-name-"]');
    expect(remaining).toHaveLength(1);
  });

  it('shows duplicate name error for repeated env var names', async () => {
    const user = userEvent.setup();

    const { container } = renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));
    await user.click(screen.getAllByRole('button', { name: /Add key\/value/ })[0]);

    const envName0 = container.querySelector('#env-name-0');
    const envName1 = container.querySelector('#env-name-1');
    if (!envName0 || !envName1) throw new Error('Env name inputs not found');

    await user.type(envName0, 'SAME');
    await user.type(envName1, 'SAME');

    expect(screen.getAllByText('Duplicate name')).toHaveLength(2);
  });

  it('renders Secret resource and key dropdowns in the secrets group', async () => {
    const user = userEvent.setup();
    const { container } = renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    expect(container.querySelector('#secret-name-0')).toBeInTheDocument();
    expect(container.querySelector('#secret-resource-0')).toBeInTheDocument();
    expect(container.querySelector('#secret-key-0')).toBeInTheDocument();
  });

  it('renders ConfigMap resource and key dropdowns in the configmaps group', async () => {
    const user = userEvent.setup();
    const { container } = renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    expect(container.querySelector('#configmap-name-0')).toBeInTheDocument();
    expect(container.querySelector('#configmap-resource-0')).toBeInTheDocument();
    expect(container.querySelector('#configmap-key-0')).toBeInTheDocument();
  });

  it('disables Create button when env var name starts with a digit', async () => {
    const user = userEvent.setup();

    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
    await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
    await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    const envSection = screen.getByRole('group', { name: /Environment Variables/ });
    const envNameInput = within(envSection).getAllByRole('textbox', { name: /^Name$/ })[0];
    const envValueInput = within(envSection).getByRole('textbox', { name: /^Value$/ });

    expect(envNameInput).toBeInTheDocument();
    expect(envValueInput).toBeInTheDocument();

    await user.type(envNameInput, '1BAD');
    await user.type(envValueInput, 'some-value');

    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
    expect(
      screen.getByText(
        'Must start with a letter, dot, dash, or underscore, followed by letters, digits, dots, dashes, or underscores',
      ),
    ).toBeInTheDocument();
  });

  it('disables Create button when env var name contains invalid characters', async () => {
    const user = userEvent.setup();

    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
    await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
    await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    const envSection = screen.getByRole('group', { name: /Environment Variables/ });
    const envNameInput = within(envSection).getAllByRole('textbox', { name: /^Name$/ })[0];
    const envValueInput = within(envSection).getByRole('textbox', { name: /^Value$/ });

    expect(envNameInput).toBeInTheDocument();
    expect(envValueInput).toBeInTheDocument();

    await user.type(envNameInput, 'NO SPACES');
    await user.type(envValueInput, 'some-value');

    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
  });

  it('enables Create button when env var name uses dots, dashes, or underscores', async () => {
    const user = userEvent.setup();

    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
    await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
    await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    const envSection = screen.getByRole('group', { name: /Environment Variables/ });
    const envNameInput = within(envSection).getAllByRole('textbox', { name: /^Name$/ })[0];
    const envValueInput = within(envSection).getByRole('textbox', { name: /^Value$/ });

    expect(envNameInput).toBeInTheDocument();
    expect(envValueInput).toBeInTheDocument();

    await user.type(envNameInput, '_my.env-var');
    await user.type(envValueInput, 'some-value');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create/ })).not.toBeDisabled();
    });
  });

  it('shows duplicate error across env var groups', async () => {
    const user = userEvent.setup();

    renderWithContext(
      <CreateFunctionForm {...defaultProps} secrets={[{ name: 'my-secret', keys: ['key1'] }]} />,
    );

    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    const envSection = screen.getByRole('group', { name: /Environment Variables/ });
    const plainNameInput = within(envSection).getAllByRole('textbox', { name: /^Name$/ })[0];
    const plainValueInput = within(envSection).getByRole('textbox', { name: /^Value$/ });

    expect(plainNameInput).toBeInTheDocument();
    expect(plainValueInput).toBeInTheDocument();

    await user.type(plainNameInput, 'SAME_NAME');
    await user.type(plainValueInput, 'value');

    const secretNameInputs = within(envSection).getAllByRole('textbox', { name: /^Name$/ });
    const secretNameInput = secretNameInputs[secretNameInputs.length - 1];

    expect(secretNameInput).toBeInTheDocument();

    await user.type(secretNameInput, 'SAME_NAME');

    expect(screen.getAllByText('Duplicate name')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
  });

  it('does not flag empty names as duplicates', async () => {
    const user = userEvent.setup();

    renderWithContext(<CreateFunctionForm {...defaultProps} />);

    await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
    await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
    await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');

    await user.click(screen.getByRole('button', { name: /Add environment variable/ }));

    expect(screen.queryByText('Duplicate name')).not.toBeInTheDocument();
  });
});
