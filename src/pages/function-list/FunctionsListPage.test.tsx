import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../testing/msw/server';
import { MemoryRouter } from 'react-router';
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

const GITHUB_API = 'https://api.github.com';

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

function setupReposHandler(repos: { owner: string; name: string; url: string }[]) {
  server.use(
    http.get(`${GITHUB_API}/search/repositories`, () =>
      HttpResponse.json({
        total_count: repos.length,
        items: repos.map((r) => ({
          owner: { login: r.owner },
          name: r.name,
          html_url: r.url,
          default_branch: 'main',
        })),
      }),
    ),
  );
}

function setupFuncYamlHandler(repoName: string, yaml: string) {
  server.use(
    http.get(`${GITHUB_API}/repos/twoGiants/${repoName}/contents/func.yaml`, () =>
      HttpResponse.json({
        content: btoa(yaml),
        encoding: 'base64',
        type: 'file',
      }),
    ),
  );
}

function setupFuncYamlHandlerAll(repos: { name: string; yaml: string }[]) {
  for (const repo of repos) {
    setupFuncYamlHandler(repo.name, repo.yaml);
  }
}

function repoFixture(name: string) {
  return {
    owner: 'twoGiants',
    name,
    url: `https://github.com/twoGiants/${name}`,
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

  afterAll(() => {
    sessionStorage.clear();
  });

  it('renders a spinner while loading', () => {
    renderAuthenticated();
    setupReposHandler([]);
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
    setupReposHandler([]);
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
    setupReposHandler([repoFixture('my-func')]);
    setupFuncYamlHandler('my-func', 'name: my-func\nruntime: go\nnamespace: demo\n');
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
    setupReposHandler([repoFixture('orphan-func')]);
    setupFuncYamlHandler('orphan-func', 'name: orphan-func\nruntime: node\nnamespace: demo\n');
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
    server.use(
      http.get(`${GITHUB_API}/search/repositories`, () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Bad credentials/)).toBeInTheDocument();
  });

  it('renders empty state when GitHub API fails', async () => {
    renderAuthenticated();
    server.use(
      http.get(`${GITHUB_API}/search/repositories`, () =>
        HttpResponse.json({ message: 'Requires authentication' }, { status: 401 }),
      ),
    );
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No functions found' })).toBeInTheDocument();
  });

  it('does not call GitHub API when not authenticated', async () => {
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'No functions found' });
  });

  it('renders UserAvatar in header', () => {
    renderAuthenticated();
    setupReposHandler([]);
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
  });

  it('empty state receives hint and isCreateDisabled when not authenticated', async () => {
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
    setupReposHandler([repoFixture('my-func')]);
    setupFuncYamlHandler('my-func', 'name: my-func\nruntime: go\nnamespace: demo\n');
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
    setupReposHandler([repoFixture('my-func')]);
    setupFuncYamlHandler('my-func', 'name: my-func\nruntime: go\nnamespace: demo\n');
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
    setupReposHandler([repoFixture('my-func')]);
    setupFuncYamlHandler('my-func', 'name: my-func\nruntime: go\nnamespace: demo\n');
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
    setupReposHandler([repoFixture('my-func')]);
    setupFuncYamlHandler('my-func', 'name: my-func\nruntime: go\nnamespace: demo\n');
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
    setupReposHandler([repoFixture('my-func')]);
    setupFuncYamlHandler('my-func', 'name: my-func\nruntime: go\nnamespace: demo\n');
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
    setupReposHandler([repoFixture('fn-a')]);
    setupFuncYamlHandler('fn-a', 'name: fn-a\nruntime: go\nnamespace: demo\n');
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
    let callCount = 0;
    server.use(
      http.get(`${GITHUB_API}/search/repositories`, () => {
        callCount++;
        return HttpResponse.json({
          total_count: 1,
          items: [
            {
              owner: { login: 'twoGiants' },
              name: 'fn-a',
              html_url: 'https://github.com/twoGiants/fn-a',
              default_branch: 'main',
            },
          ],
        });
      }),
    );
    setupFuncYamlHandler('fn-a', 'name: fn-a\nruntime: go\nnamespace: demo\n');
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('fn-name');
    expect(callCount).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(callCount).toBe(2);
    });
  });

  it('does not show spinner on refresh button during initial page load', async () => {
    renderAuthenticated();
    setupReposHandler([repoFixture('fn-a')]);
    setupFuncYamlHandler('fn-a', 'name: fn-a\nruntime: go\nnamespace: demo\n');
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
    let resolveSearch: (() => void) | undefined;
    let firstCall = true;

    function repoJson() {
      return HttpResponse.json({
        total_count: 1,
        items: [
          {
            owner: { login: 'twoGiants' },
            name: 'fn-a',
            html_url: 'https://github.com/twoGiants/fn-a',
            default_branch: 'main',
          },
        ],
      });
    }

    server.use(
      http.get(`${GITHUB_API}/search/repositories`, () => {
        if (firstCall) {
          firstCall = false;
          return repoJson();
        }
        return new Promise<Response>((resolve) => {
          resolveSearch = () => resolve(repoJson());
        });
      }),
    );
    setupFuncYamlHandler('fn-a', 'name: fn-a\nruntime: go\nnamespace: demo\n');
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('fn-name');

    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });

    await userEvent.click(refreshBtn);
    expect(refreshBtn.querySelector('[role="progressbar"]')).toBeInTheDocument();

    resolveSearch!();
    await waitFor(() => {
      expect(refreshBtn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
    });
  });

  it('shows error item when fetchFileContent throws (deleted repo)', async () => {
    renderAuthenticated();
    setupReposHandler([repoFixture('good-func'), repoFixture('deleted-repo')]);
    setupFuncYamlHandler('good-func', 'name: good-func\nruntime: go\nnamespace: demo\n');
    server.use(
      http.get(`${GITHUB_API}/repos/twoGiants/deleted-repo/contents/func.yaml`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    const names = await screen.findAllByTestId('fn-name');
    expect(names).toHaveLength(2);
    expect(names[0]).toHaveTextContent('good-func');
    expect(names[1]).toHaveTextContent('deleted-repo');
  });

  it('uses func.yaml name instead of repo name for cluster matching', async () => {
    renderAuthenticated();
    setupReposHandler([repoFixture('my-repo')]);
    setupFuncYamlHandler('my-repo', 'name: my-function\nruntime: node\nnamespace: demo\n');
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
    let callCount = 0;
    server.use(
      http.get(`${GITHUB_API}/search/repositories`, () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json({
            total_count: 2,
            items: [
              {
                owner: { login: 'twoGiants' },
                name: 'fn-a',
                html_url: 'https://github.com/twoGiants/fn-a',
                default_branch: 'main',
              },
              {
                owner: { login: 'twoGiants' },
                name: 'fn-b',
                html_url: 'https://github.com/twoGiants/fn-b',
                default_branch: 'main',
              },
            ],
          });
        }
        return HttpResponse.json({
          total_count: 1,
          items: [
            {
              owner: { login: 'twoGiants' },
              name: 'fn-a',
              html_url: 'https://github.com/twoGiants/fn-a',
              default_branch: 'main',
            },
          ],
        });
      }),
    );
    setupFuncYamlHandlerAll([
      { name: 'fn-a', yaml: 'name: fn-a\nruntime: go\nnamespace: demo\n' },
      { name: 'fn-b', yaml: 'name: fn-b\nruntime: go\nnamespace: demo\n' },
    ]);
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    const names = await screen.findAllByTestId('fn-name');
    expect(names).toHaveLength(2);
    expect(names[0]).toHaveTextContent('fn-a');
    expect(names[1]).toHaveTextContent('fn-b');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      const refreshedNames = screen.getAllByTestId('fn-name');
      expect(refreshedNames).toHaveLength(1);
      expect(refreshedNames[0]).toHaveTextContent('fn-a');
    });
  });
});
