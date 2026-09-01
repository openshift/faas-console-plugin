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
  TrashIcon: () => 'DeleteIcon',
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
    owner: 'twoGiants',
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
    owner: 'twoGiants',
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
  owner: '',
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
        <FunctionTable functions={mockFunctions} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('my-func').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('idle-func')).toBeInTheDocument();
  });

  it('renders runtime with dash for empty value', () => {
    const noRuntime: FunctionTableItem = {
      name: 'cluster-only',
      repoName: '',
      owner: '',
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
        <FunctionTable functions={[noRuntime]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders namespace with dash for empty value', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={mockFunctions} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Namespace')).toBeInTheDocument();
    expect(screen.getAllByText('demo').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('hides the namespace column when showNamespace is false', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={mockFunctions} onEdit={vi.fn()} showNamespace={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Namespace')).not.toBeInTheDocument();
    expect(screen.queryByText('demo')).not.toBeInTheDocument();
  });

  it('renders SuccessStatus for Running functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[0]]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Success: Running')).toBeInTheDocument();
  });

  it('keeps Running and shows a build-in-progress spinner when buildActivity is Building', () => {
    const rebuilding: FunctionTableItem = { ...mockFunctions[0], buildActivity: 'Building' };

    render(
      <MemoryRouter>
        <FunctionTable functions={[rebuilding]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Success: Running')).toBeInTheDocument();
    expect(screen.getByLabelText('Build in progress')).toBeInTheDocument();
  });

  it('keeps Running and shows a warning icon linking to the run when buildActivity is Failed', () => {
    const failedRebuild: FunctionTableItem = {
      ...mockFunctions[0],
      buildActivity: 'Failed',
      failureReason: 'build / go test',
      buildRunURL: 'https://github.com/twoGiants/my-func/actions/runs/1',
    };

    render(
      <MemoryRouter>
        <FunctionTable functions={[failedRebuild]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Success: Running')).toBeInTheDocument();
    expect(screen.getByText('WarningIcon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Latest build failed' })).toHaveAttribute(
      'href',
      'https://github.com/twoGiants/my-func/actions/runs/1',
    );
  });

  it('keeps ScaledToZero and shows a build-in-progress spinner when buildActivity is Building', () => {
    const idleRebuilding: FunctionTableItem = {
      ...mockFunctions[0],
      status: 'ScaledToZero',
      buildActivity: 'Building',
    };

    render(
      <MemoryRouter>
        <FunctionTable functions={[idleRebuilding]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Info: ScaledToZero')).toBeInTheDocument();
    expect(screen.getByLabelText('Build in progress')).toBeInTheDocument();
  });

  it('keeps ScaledToZero and shows a warning icon linking to the run when buildActivity is Failed', () => {
    const idleFailedRebuild: FunctionTableItem = {
      ...mockFunctions[0],
      status: 'ScaledToZero',
      buildActivity: 'Failed',
      failureReason: 'build / go test',
      buildRunURL: 'https://github.com/twoGiants/my-func/actions/runs/1',
    };

    render(
      <MemoryRouter>
        <FunctionTable functions={[idleFailedRebuild]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Info: ScaledToZero')).toBeInTheDocument();
    expect(screen.getByText('WarningIcon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Latest build failed' })).toHaveAttribute(
      'href',
      'https://github.com/twoGiants/my-func/actions/runs/1',
    );
  });

  it('renders InfoStatus for NotDeployed functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[1]]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByText('Info: NotDeployed')).toBeInTheDocument();
  });

  it('displays hostname-only link for URL', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[0]]} onEdit={vi.fn()} showNamespace />
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
        <FunctionTable functions={[mockFunctions[0]]} onEdit={onEdit} showNamespace />
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
      owner: 'twoGiants',
      runtime: 'node',
      status: 'Running',
      url: '',
      replicas: 1,
      namespace: 'demo',
      source: 'repo',
    };

    render(
      <MemoryRouter>
        <FunctionTable functions={[fn]} onEdit={onEdit} showNamespace />
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
        <FunctionTable functions={[mockFunctions[0]]} onEdit={vi.fn()} showNamespace />
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
        <FunctionTable functions={[mockFunctions[1]]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('disables edit button for cluster-only functions', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[clusterOnlyFunction]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not call onEdit when the disabled edit button is clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FunctionTable functions={[clusterOnlyFunction]} onEdit={onEdit} showNamespace />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('explains why edit is disabled on hover for cluster-only functions', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <FunctionTable functions={[clusterOnlyFunction]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    await user.hover(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('No source repository to edit')).toBeInTheDocument();
  });

  it('enables edit button for functions with a repo source', () => {
    render(
      <MemoryRouter>
        <FunctionTable functions={[mockFunctions[1]]} onEdit={vi.fn()} showNamespace />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
  });
});
