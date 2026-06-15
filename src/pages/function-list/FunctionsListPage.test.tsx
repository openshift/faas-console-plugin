import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom-v5-compat';
import FunctionsListPage from './FunctionsListPage';
import { PAT_KEY } from '../../common/services/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  DocumentTitle: ({ children }: { children: string }) => children,
  ListPageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <>
      {title}
      {children}
    </>
  ),
}));

const mockUseSourceControl = vi.fn();
vi.mock('../../common/services/source-control/useSourceControlService', () => ({
  useSourceControlService: () => mockUseSourceControl(),
}));

const mockUseClusterService = vi.fn();
vi.mock('../../common/services/cluster/useClusterService', () => ({
  useClusterService: (...args: unknown[]) => mockUseClusterService(...args),
}));

vi.mock('./components/FunctionTable', () => ({
  FunctionTable: ({
    functions,
  }: {
    functions: { name: string; status: string; replicas: number; url?: string }[];
  }) =>
    functions.map((f) => (
      <div key={f.name}>
        <span data-testid="fn-name">{f.name}</span>
        <span data-testid="fn-status">{f.status}</span>
        <span data-testid="fn-replicas">{f.replicas}</span>
        <span data-testid="fn-url">{f.url ?? ''}</span>
      </div>
    )),
}));

vi.mock('../../common/components/UserAvatar', () => ({
  UserAvatar: ({ enableReconnect }: { enableReconnect: boolean }) => (
    <span data-testid="user-avatar">{enableReconnect ? 'reconnect' : 'no-reconnect'}</span>
  ),
}));

function clusterData(
  overrides: Partial<{
    knativeServices: unknown[];
    deployments: unknown[];
    loaded: boolean;
    error: unknown;
  }> = {},
) {
  return {
    knativeServices: [],
    deployments: [],
    loaded: true,
    error: null,
    ...overrides,
  };
}

function renderAuthenticated() {
  sessionStorage.setItem(PAT_KEY, 'ghp_test');
}

function repoFixture(name: string) {
  return {
    owner: 'twoGiants',
    name,
    url: `https://github.com/twoGiants/${name}`,
    defaultBranch: 'main',
  };
}

function ksvcFixture(
  name: string,
  readyStatus: string,
  url = `https://${name}-demo.apps.example.com`,
  revision = `${name}-00001`,
) {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: 'demo',
      labels: { 'function.knative.dev/name': name },
    },
    status: {
      url,
      latestReadyRevisionName: revision,
      conditions: [{ type: 'Ready', status: readyStatus }],
    },
  };
}

function deploymentFixture(
  name: string,
  specReplicas: number,
  readyReplicas: number,
  revision = `${name}-00001`,
) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: `${revision}-deployment`,
      namespace: 'demo',
      labels: {
        'function.knative.dev/name': name,
        'serving.knative.dev/revision': revision,
      },
    },
    spec: { replicas: specReplicas },
    status: { readyReplicas },
  };
}

describe('FunctionsListPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    sessionStorage.clear();
  });

  it('renders a spinner while loading', () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([]),
      fetchFileContent: vi.fn(),
    });
    mockUseClusterService.mockReturnValue(clusterData({ loaded: false }));

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders the empty state when loaded with no functions', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([]),
      fetchFileContent: vi.fn(),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No functions found' })).toBeInTheDocument();
  });

  it('renders table when functions are loaded', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('my-func')]),
      fetchFileContent: vi.fn().mockResolvedValue('name: my-func\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(
      clusterData({
        knativeServices: [ksvcFixture('my-func', 'True')],
        deployments: [deploymentFixture('my-func', 1, 1)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-name')).toHaveTextContent('my-func');
  });

  it('shows NotDeployed status for repos without cluster deployment', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('orphan-func')]),
      fetchFileContent: vi
        .fn()
        .mockResolvedValue('name: orphan-func\nruntime: node\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('NotDeployed');
  });

  it('shows error alert when listing repos fails', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockRejectedValue(new Error('Bad credentials')),
      fetchFileContent: vi.fn(),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Bad credentials')).toBeInTheDocument();
  });

  it('renders empty state when GitHub API fails', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockRejectedValue(new Error('Requires authentication')),
      fetchFileContent: vi.fn(),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No functions found' })).toBeInTheDocument();
  });

  it('does not call listFunctionRepos when not authenticated', async () => {
    const mockListRepos = vi.fn().mockResolvedValue([]);
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: mockListRepos,
      fetchFileContent: vi.fn(),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'No functions found' });

    expect(mockListRepos).not.toHaveBeenCalled();
  });

  it('renders UserAvatar in header', () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([]),
      fetchFileContent: vi.fn(),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
  });

  it('empty state receives hint and isCreateDisabled when not authenticated', async () => {
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([]),
      fetchFileContent: vi.fn(),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'No functions found' });

    const button = screen.getByRole('button', { name: 'Create function' });
    expect(button).toBeDisabled();
  });

  it('enriches function with status from Knative Service and replicas from Deployment', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('my-func')]),
      fetchFileContent: vi.fn().mockResolvedValue('name: my-func\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(
      clusterData({
        knativeServices: [ksvcFixture('my-func', 'True')],
        deployments: [deploymentFixture('my-func', 1, 1)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('Running');
    expect(screen.getByTestId('fn-replicas')).toHaveTextContent('1');
    expect(screen.getByTestId('fn-url')).toHaveTextContent('https://my-func-demo.apps.example.com');
  });

  it('shows ScaledToZero when Knative Service is Ready but Deployment has 0 replicas', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('my-func')]),
      fetchFileContent: vi.fn().mockResolvedValue('name: my-func\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(
      clusterData({
        knativeServices: [ksvcFixture('my-func', 'True')],
        deployments: [deploymentFixture('my-func', 0, 0)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('ScaledToZero');
    expect(screen.getByTestId('fn-replicas')).toHaveTextContent('0');
  });

  it('shows Deploying when Knative Service Ready condition is Unknown', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('my-func')]),
      fetchFileContent: vi.fn().mockResolvedValue('name: my-func\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(
      clusterData({
        knativeServices: [ksvcFixture('my-func', 'Unknown')],
        deployments: [deploymentFixture('my-func', 1, 0)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('Deploying');
  });

  it('shows Error when Knative Service Ready condition is False', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('my-func')]),
      fetchFileContent: vi.fn().mockResolvedValue('name: my-func\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(
      clusterData({
        knativeServices: [ksvcFixture('my-func', 'False')],
        deployments: [deploymentFixture('my-func', 0, 0)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('Error');
  });

  it('picks latest revision deployment when multiple revisions exist', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('my-func')]),
      fetchFileContent: vi.fn().mockResolvedValue('name: my-func\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(
      clusterData({
        knativeServices: [ksvcFixture('my-func', 'True', undefined, 'my-func-00002')],
        deployments: [
          deploymentFixture('my-func', 0, 0, 'my-func-00001'),
          deploymentFixture('my-func', 1, 1, 'my-func-00002'),
        ],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('Running');
    expect(screen.getByTestId('fn-replicas')).toHaveTextContent('1');
  });

  it('passes function names to useClusterService', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('fn-a')]),
      fetchFileContent: vi.fn().mockResolvedValue('name: fn-a\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('fn-name');

    expect(mockUseClusterService).toHaveBeenLastCalledWith(['fn-a']);
  });

  it('re-fetches repos when refresh button is clicked', async () => {
    renderAuthenticated();
    const mockListRepos = vi.fn().mockResolvedValue([repoFixture('fn-a')]);
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: mockListRepos,
      fetchFileContent: vi.fn().mockResolvedValue('name: fn-a\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('fn-name');
    expect(mockListRepos).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(mockListRepos).toHaveBeenCalledTimes(2);
    });
  });

  it('does not show spinner on refresh button during initial page load', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('fn-a')]),
      fetchFileContent: vi.fn().mockResolvedValue('name: fn-a\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('fn-name');

    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
    expect(refreshBtn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
  });

  it('shows spinner on refresh button only while a button-triggered refresh is in flight', async () => {
    renderAuthenticated();
    let resolveRepos: (value: unknown[]) => void;
    const mockListRepos = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRepos = resolve;
        }),
    );
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: mockListRepos,
      fetchFileContent: vi.fn().mockResolvedValue('name: fn-a\nruntime: go\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    // Complete initial load
    resolveRepos!([repoFixture('fn-a')]);
    await screen.findByTestId('fn-name');

    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });

    // Click refresh -- should show spinner
    await userEvent.click(refreshBtn);
    expect(refreshBtn.querySelector('[role="progressbar"]')).toBeInTheDocument();

    // Resolve the refresh fetch -- spinner should disappear
    resolveRepos!([repoFixture('fn-a')]);
    await waitFor(() => {
      expect(refreshBtn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
    });
  });

  it('skips repo when fetchFileContent throws (deleted repo)', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi
        .fn()
        .mockResolvedValue([repoFixture('good-func'), repoFixture('deleted-repo')]),
      fetchFileContent: vi.fn().mockImplementation((repo: { name: string }) => {
        if (repo.name === 'deleted-repo') return Promise.reject(new Error('Not Found'));
        return Promise.resolve(`name: ${repo.name}\nruntime: go\nnamespace: demo\n`);
      }),
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    const names = await screen.findAllByTestId('fn-name');
    expect(names).toHaveLength(1);
    expect(names[0]).toHaveTextContent('good-func');
  });

  it('uses func.yaml name instead of repo name for cluster matching', async () => {
    renderAuthenticated();
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: vi.fn().mockResolvedValue([repoFixture('my-repo')]),
      fetchFileContent: vi
        .fn()
        .mockResolvedValue('name: my-function\nruntime: node\nnamespace: demo\n'),
    });
    mockUseClusterService.mockReturnValue(
      clusterData({
        knativeServices: [ksvcFixture('my-function', 'True')],
        deployments: [deploymentFixture('my-function', 1, 1)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-name')).toHaveTextContent('my-function');
    expect(screen.getByTestId('fn-status')).toHaveTextContent('Running');
    expect(mockUseClusterService).toHaveBeenLastCalledWith(['my-function']);
  });

  it('removes a deleted repo from the list after refresh', async () => {
    renderAuthenticated();
    const mockListRepos = vi
      .fn()
      .mockResolvedValueOnce([repoFixture('fn-a'), repoFixture('fn-b')])
      .mockResolvedValueOnce([repoFixture('fn-a')]);
    const mockFetchFile = vi
      .fn()
      .mockImplementation(
        (repo: { name: string }) => `name: ${repo.name}\nruntime: go\nnamespace: demo\n`,
      );
    mockUseSourceControl.mockReturnValue({
      listFunctionRepos: mockListRepos,
      fetchFileContent: mockFetchFile,
    });
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    // Initial load: both repos visible
    const names = await screen.findAllByTestId('fn-name');
    expect(names).toHaveLength(2);
    expect(names[0]).toHaveTextContent('fn-a');
    expect(names[1]).toHaveTextContent('fn-b');

    // Click refresh (second call returns only fn-a)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      const refreshedNames = screen.getAllByTestId('fn-name');
      expect(refreshedNames).toHaveLength(1);
      expect(refreshedNames[0]).toHaveTextContent('fn-a');
    });
  });
});
