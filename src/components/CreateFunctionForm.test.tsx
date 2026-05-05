import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateFunctionForm } from './CreateFunctionForm';
import { ForgeConnectionContext } from '../context/ForgeConnectionProvider';
import { ForgeUser } from '../services/types';

const testUser: ForgeUser = { name: 'testuser' };
const forgeContext = {
  isActive: true,
  user: testUser,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CreateFunctionForm', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onSubmit.mockClear();
    onCancel.mockClear();
  });

  it('renders all form fields', () => {
    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={false} />,
    );

    expect(screen.getByRole('textbox', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Repository/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Branch/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Name$/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Language/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Registry/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Namespace/ })).toBeInTheDocument();
  });

  it('presets owner from context and disables the field', () => {
    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={false} />,
    );

    const ownerInput = screen.getByRole('textbox', { name: /Owner/ });
    expect(ownerInput).toHaveValue('testuser');
    expect(ownerInput).toBeDisabled();
  });

  it('presets registry to OCP internal registry and disables the field', () => {
    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={false} />,
    );

    const registryInput = screen.getByRole('textbox', { name: /Registry/ });
    expect(registryInput).toHaveValue('image-registry.openshift-image-registry.svc:5000/');
    expect(registryInput).toBeDisabled();
  });

  it('updates registry to include namespace when namespace is typed', async () => {
    const user = userEvent.setup();

    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={false} />,
    );

    await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'my-ns');

    expect(screen.getByRole('textbox', { name: /Registry/ })).toHaveValue(
      'image-registry.openshift-image-registry.svc:5000/my-ns',
    );
  });

  it('renders Create and Cancel buttons', () => {
    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={false} />,
    );

    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument();
  });

  it('disables Create button when required fields are empty', () => {
    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={false} />,
    );

    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
  });

  it('disables Create button when isSubmitting is true', () => {
    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={true} />,
    );

    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();

    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={false} />,
    );

    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onSubmit with form data when form is filled and Create is clicked', async () => {
    const user = userEvent.setup();

    renderWithContext(
      <CreateFunctionForm onSubmit={onSubmit} onCancel={onCancel} isSubmitting={false} />,
    );

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
    });
  });
});
