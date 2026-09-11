import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { FUNCTION_NAME_LABEL } from '../../../common/types';
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
  PowerOffIcon: () => 'UndeployIcon',
  PlayIcon: () => 'DeployIcon',
}));

const mockKnativeService = {
  apiVersion: 'serving.knative.dev/v1',
  kind: 'Service',
  metadata: {
    name: 'my-func',
    namespace: 'demo',
    labels: { [FUNCTION_NAME_LABEL]: 'my-func' },
  },
};

const mockFunctions: FunctionTableItem[] = [
  {
    name: 'my-func',
    repoName: 'my-func',
    owner: 'alice',
    branch: 'main',
    runtime: 'go',
    status: 'Running',
    url: 'http://my-func.demo.svc',
    replicas: 1,
    namespace: 'demo',
    source: 'repo',
    mainResource: mockKnativeService,
  },
  {
    name: 'idle-func',
    repoName: 'idle-func',
    owner: 'alice',
    branch: 'main',
    runtime: 'node',
    status: 'NotDeployed',
    url: '',
    replicas: 0,
    namespace: '',
    source: 'repo',
  },
];

const clusterOnlyFunction: FunctionTableItem = {
  name: 'cluster-only',
  repoName: '',
  owner: 'alice',
  branch: 'main',
  runtime: 'node',
  status: 'Running',
  url: 'http://cluster-only.demo.svc',
  replicas: 1,
  namespace: 'demo',
  source: 'cluster',
  mainResource: mockKnativeService,
};

describe('FunctionTable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a row for each function', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={mockFunctions}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('my-func').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('idle-func')).toBeInTheDocument();
  });

  it('renders runtime with dash for empty value', () => {
    const noRuntime: FunctionTableItem = {
      name: 'cluster-only',
      repoName: '',
      owner: 'alice',
      branch: 'main',
      runtime: '',
      status: 'Running',
      url: 'http://cluster-only.demo.svc',
      replicas: 1,
      namespace: 'demo',
      source: 'cluster',
      mainResource: mockKnativeService,
    };

    render(
      <MemoryRouter>
        <FunctionTable functions={[noRuntime]} onEdit={vi.fn()} onDeploy={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders namespace with dash for empty value', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={mockFunctions}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Namespace')).toBeInTheDocument();
    expect(screen.getAllByText('demo').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('hides the namespace column when showNamespace is false', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={mockFunctions}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace={false}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Namespace')).not.toBeInTheDocument();
    expect(screen.queryByText('demo')).not.toBeInTheDocument();
  });

  it('renders SuccessStatus for Running functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={[mockFunctions[0]]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Success: Running')).toBeInTheDocument();
  });

  it('renders InfoStatus for NotDeployed functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={[mockFunctions[1]]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Info: NotDeployed')).toBeInTheDocument();
  });

  it('displays hostname-only link for URL', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={[mockFunctions[0]]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
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
        <FunctionTable
          functions={[mockFunctions[0]]}
          onEdit={onEdit}
          onDeploy={vi.fn()}
          showNamespace
        />
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
      owner: 'alice',
      branch: 'main',
      runtime: 'node',
      status: 'Running',
      url: '',
      replicas: 1,
      namespace: 'demo',
      source: 'repo',
    };

    render(
      <MemoryRouter>
        <FunctionTable functions={[fn]} onEdit={onEdit} onDeploy={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith('my-repo');
  });

  it('launches undeploy modal when the undeploy button is clicked', async () => {
    const mockLauncher = vi.fn();
    mockUseDeleteModal.mockReturnValue(mockLauncher);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FunctionTable
          functions={[mockFunctions[0]]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Undeploy' }));
    expect(mockLauncher).toHaveBeenCalled();
    expect(mockUseDeleteModal).toHaveBeenCalledWith(
      mockKnativeService,
      undefined,
      expect.anything(),
      'Undeploy',
    );
  });

  it('shows an enabled deploy button for NotDeployed functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={[mockFunctions[1]]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Undeploy' })).not.toBeInTheDocument();
  });

  it('calls onDeploy with the function item when the deploy button is clicked', async () => {
    const onDeploy = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FunctionTable
          functions={[mockFunctions[1]]}
          onEdit={vi.fn()}
          onDeploy={onDeploy}
          showNamespace
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(onDeploy).toHaveBeenCalledWith(mockFunctions[1]);
  });

  it('shows the undeploy button for Running functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={[mockFunctions[0]]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Undeploy' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Deploy' })).not.toBeInTheDocument();
  });

  it('disables the deploy button with a tooltip for transitional states', async () => {
    const user = userEvent.setup();
    const deploying: FunctionTableItem = { ...mockFunctions[1], status: 'Deploying' };

    render(
      <MemoryRouter>
        <FunctionTable functions={[deploying]} onEdit={vi.fn()} onDeploy={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('button', { name: 'Deploy' });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');

    await user.hover(toggle);
    expect(await screen.findByText('Function is not ready to deploy yet')).toBeInTheDocument();
  });

  it('disables edit button for cluster-only functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={[clusterOnlyFunction]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not call onEdit when the disabled edit button is clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FunctionTable
          functions={[clusterOnlyFunction]}
          onEdit={onEdit}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('explains why edit is disabled on hover for cluster-only functions', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FunctionTable
          functions={[clusterOnlyFunction]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    await user.hover(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('No source repository to edit')).toBeInTheDocument();
  });

  it('enables edit button for functions with a repo source', () => {
    render(
      <MemoryRouter>
        <FunctionTable
          functions={[mockFunctions[1]]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('disables the deploy button for a deployable function with no source repository', () => {
    const clusterOnlyNotDeployed: FunctionTableItem = {
      ...clusterOnlyFunction,
      status: 'NotDeployed',
      mainResource: undefined,
    };

    render(
      <MemoryRouter>
        <FunctionTable
          functions={[clusterOnlyNotDeployed]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Deploy' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not call onDeploy when the disabled deploy button (no repo) is clicked', async () => {
    const onDeploy = vi.fn();
    const user = userEvent.setup();
    const clusterOnlyNotDeployed: FunctionTableItem = {
      ...clusterOnlyFunction,
      status: 'NotDeployed',
      mainResource: undefined,
    };

    render(
      <MemoryRouter>
        <FunctionTable
          functions={[clusterOnlyNotDeployed]}
          onEdit={vi.fn()}
          onDeploy={onDeploy}
          showNamespace
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(onDeploy).not.toHaveBeenCalled();
  });

  it('explains why the deploy button is disabled on hover for a deployable function with no repo', async () => {
    const user = userEvent.setup();
    const clusterOnlyNotDeployed: FunctionTableItem = {
      ...clusterOnlyFunction,
      status: 'NotDeployed',
      mainResource: undefined,
    };

    render(
      <MemoryRouter>
        <FunctionTable
          functions={[clusterOnlyNotDeployed]}
          onEdit={vi.fn()}
          onDeploy={vi.fn()}
          showNamespace
        />
      </MemoryRouter>,
    );

    await user.hover(screen.getByRole('button', { name: 'Deploy' }));
    expect(await screen.findByText('No source repository to deploy')).toBeInTheDocument();
  });
});
