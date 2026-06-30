import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom-v5-compat';
import { FunctionTable, FunctionTableItem } from './FunctionTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockUseDeleteModal = vi.fn().mockReturnValue(vi.fn());

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  SuccessStatus: ({ title }: { title: string }) => `Success: ${title}`,
  ProgressStatus: ({ title }: { title: string }) => `Progress: ${title}`,
  ErrorStatus: ({ title }: { title: string }) => `Error: ${title}`,
  InfoStatus: ({ title }: { title: string }) => `Info: ${title}`,
  StatusIconAndText: ({ title }: { title: string }) => `Warning: ${title}`,
  useDeleteModal: (...args: unknown[]) => mockUseDeleteModal(...args),
}));

vi.mock('@patternfly/react-icons', () => ({
  ExclamationTriangleIcon: () => 'WarningIcon',
  PencilAltIcon: () => 'EditIcon',
  TrashIcon: () => 'DeleteIcon',
}));

const mockKnativeService = {
  apiVersion: 'serving.knative.dev/v1',
  kind: 'Service',
  metadata: {
    name: 'my-func',
    namespace: 'demo',
    labels: { 'function.knative.dev/name': 'my-func' },
  },
};

const mockFunctions: FunctionTableItem[] = [
  {
    name: 'my-func',
    repoName: 'my-func',
    runtime: 'go',
    status: 'Running',
    url: 'http://my-func.demo.svc',
    replicas: 1,
    namespace: 'demo',
    mainResource: mockKnativeService,
  },
  {
    name: 'idle-func',
    repoName: 'idle-func',
    runtime: 'node',
    status: 'NotDeployed',
    replicas: 0,
    namespace: '',
  },
];

describe('FunctionTable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a row for each function', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={mockFunctions} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('my-func').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('idle-func')).toBeInTheDocument();
  });

  it('renders namespace with dash for empty value', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={mockFunctions} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Namespace')).toBeInTheDocument();
    expect(screen.getAllByText('demo').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('renders SuccessStatus for Running functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[0]]} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Success: Running')).toBeInTheDocument();
  });

  it('renders InfoStatus for NotDeployed functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[1]]} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Info: NotDeployed')).toBeInTheDocument();
  });

  it('displays hostname-only link for URL', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[0]]} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'my-func' });
    expect(link).toHaveAttribute('href', 'http://my-func.demo.svc');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('calls onEdit when edit button is clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[0]]} onEdit={onEdit} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith('my-func');
  });

  it('calls onEdit with repoName, not display name', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    const fn: FunctionTableItem = {
      name: 'my-function',
      repoName: 'my-repo',
      runtime: 'node',
      status: 'Running',
      replicas: 1,
      namespace: 'demo',
    };

    render(
      <MemoryRouter>
        <FunctionTable functions={[fn]} onEdit={onEdit} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith('my-repo');
  });

  it('launches delete modal when delete button is clicked', async () => {
    const mockLauncher = vi.fn();
    mockUseDeleteModal.mockReturnValue(mockLauncher);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[0]]} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mockLauncher).toHaveBeenCalled();
    expect(mockUseDeleteModal).toHaveBeenCalledWith(
      mockKnativeService,
      undefined,
      undefined,
      'Undeploy',
    );
  });

  it('disables delete button for NotDeployed functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[1]]} onEdit={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });
});
