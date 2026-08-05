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

vi.mock('@openshift-console/dynamic-plugin-sdk', () => {
  const consoleFetchJSON = async (url: string, _method?: string, options?: RequestInit) => {
    const res = await fetch(new URL(url, 'http://localhost').href, options);
    const json = await res.json();
    if (!res.ok) throw json;
    return json;
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
  };
});

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
        <span data-testid="fn-url">{f.url}</span>
      </div>
    )),
}));

vi.mock('../../common/components/UserAvatar', () => ({
  UserAvatar: ({ enableReconnect }: { enableReconnect: boolean }) => (
    <span data-testid="user-avatar">{enableReconnect ? 'reconnect' : 'no-reconnect'}</span>
  ),
}));

const BACKEND_API = 'http://localhost/api/proxy/plugin/console-functions-plugin/backend';

function clusterData(
  overrides: Partial<{
    functions: { name: string }[];
    loaded: boolean;
    error: unknown;
  }> = {},
) {
  const { functions: list = [], ...rest } = overrides;
  return {
    functions: new Map(list.map((cf) => [cf.name, cf])),
    loaded: true,
    error: null,
    ...rest,
  };
}

function clusterFunction(name: string, status: string, replicas: number, url?: string) {
  return {
    name,
    status,
    url,
    replicas,
    mainResource: {
      apiVersion: 'serving.knative.dev/v1',
      kind: 'Service',
      metadata: { name, namespace: 'demo' },
    },
  };
}

function renderAuthenticated() {
  sessionStorage.setItem(PAT_KEY, 'ghp_test');
}

function setupListHandler(
  items: {
    owner: string;
    repoName: string;
    url: string;
    name: string;
    namespace: string;
    runtime: string;
  }[],
) {
  server.use(
    http.get(`${BACKEND_API}/api/v1/func/list`, () =>
      HttpResponse.json(
        items.map((i) => ({
          owner: i.owner,
          repoName: i.repoName,
          url: i.url,
          defaultBranch: 'main',
          name: i.name,
          namespace: i.namespace,
          runtime: i.runtime,
        })),
      ),
    ),
  );
}

function listItem(repoName: string, name?: string, namespace = 'demo', runtime = 'go') {
  return {
    owner: 'twoGiants',
    repoName,
    url: `https://github.com/twoGiants/${repoName}`,
    name: name ?? repoName,
    namespace,
    runtime,
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
    setupListHandler([]);
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
    setupListHandler([]);
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
    setupListHandler([listItem('my-func')]);
    mockUseClusterService.mockReturnValue(
      clusterData({
        functions: [
          clusterFunction('my-func', 'Running', 1, 'https://my-func-demo.apps.example.com'),
        ],
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
    setupListHandler([listItem('orphan-func', 'orphan-func', 'demo', 'node')]);
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('NotDeployed');
  });

  it('shows error alert when listing functions fails', async () => {
    renderAuthenticated();
    server.use(
      http.get(`${BACKEND_API}/api/v1/func/list`, () =>
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

  it('renders empty state when API fails', async () => {
    renderAuthenticated();
    server.use(
      http.get(`${BACKEND_API}/api/v1/func/list`, () =>
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

  it('does not call backend API when not authenticated', async () => {
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
    setupListHandler([]);
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

  it('enriches function with status, replicas, and URL from ClusterFunction', async () => {
    renderAuthenticated();
    setupListHandler([listItem('my-func')]);
    mockUseClusterService.mockReturnValue(
      clusterData({
        functions: [
          clusterFunction('my-func', 'Running', 1, 'https://my-func-demo.apps.example.com'),
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
    expect(screen.getByTestId('fn-url')).toHaveTextContent('https://my-func-demo.apps.example.com');
  });

  it('shows ScaledToZero status and 0 replicas from ClusterFunction', async () => {
    renderAuthenticated();
    setupListHandler([listItem('my-func')]);
    mockUseClusterService.mockReturnValue(
      clusterData({
        functions: [clusterFunction('my-func', 'ScaledToZero', 0)],
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

  it('shows Deploying status from ClusterFunction', async () => {
    renderAuthenticated();
    setupListHandler([listItem('my-func')]);
    mockUseClusterService.mockReturnValue(
      clusterData({
        functions: [clusterFunction('my-func', 'Deploying', 0)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('Deploying');
  });

  it('shows Error status from ClusterFunction', async () => {
    renderAuthenticated();
    setupListHandler([listItem('my-func')]);
    mockUseClusterService.mockReturnValue(
      clusterData({
        functions: [clusterFunction('my-func', 'Error', 0)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('fn-status')).toHaveTextContent('Error');
  });

  it('passes function names to useClusterService', async () => {
    renderAuthenticated();
    setupListHandler([listItem('fn-a')]);
    mockUseClusterService.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('fn-name');

    expect(mockUseClusterService).toHaveBeenLastCalledWith(['fn-a']);
  });

  it('re-fetches functions when refresh button is clicked', async () => {
    renderAuthenticated();
    let callCount = 0;
    server.use(
      http.get(`${BACKEND_API}/api/v1/func/list`, () => {
        callCount++;
        return HttpResponse.json([
          {
            owner: 'twoGiants',
            repoName: 'fn-a',
            url: 'https://github.com/twoGiants/fn-a',
            defaultBranch: 'main',
            name: 'fn-a',
            namespace: 'demo',
            runtime: 'go',
          },
        ]);
      }),
    );
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
    setupListHandler([listItem('fn-a')]);
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
    let resolveList: (() => void) | undefined;
    let firstCall = true;

    function listJson() {
      return HttpResponse.json([
        {
          owner: 'twoGiants',
          repoName: 'fn-a',
          url: 'https://github.com/twoGiants/fn-a',
          defaultBranch: 'main',
          name: 'fn-a',
          namespace: 'demo',
          runtime: 'go',
        },
      ]);
    }

    server.use(
      http.get(`${BACKEND_API}/api/v1/func/list`, () => {
        if (firstCall) {
          firstCall = false;
          return listJson();
        }
        return new Promise<Response>((resolve) => {
          resolveList = () => resolve(listJson());
        });
      }),
    );
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

    resolveList!();
    await waitFor(() => {
      expect(refreshBtn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
    });
  });

  it('uses func.yaml name instead of repo name for cluster matching', async () => {
    renderAuthenticated();
    setupListHandler([listItem('my-repo', 'my-function', 'demo', 'node')]);
    mockUseClusterService.mockReturnValue(
      clusterData({
        functions: [
          clusterFunction('my-function', 'Running', 1, 'https://my-function-demo.apps.example.com'),
        ],
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
      http.get(`${BACKEND_API}/api/v1/func/list`, () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json([
            {
              owner: 'twoGiants',
              repoName: 'fn-a',
              url: 'https://github.com/twoGiants/fn-a',
              defaultBranch: 'main',
              name: 'fn-a',
              namespace: 'demo',
              runtime: 'go',
            },
            {
              owner: 'twoGiants',
              repoName: 'fn-b',
              url: 'https://github.com/twoGiants/fn-b',
              defaultBranch: 'main',
              name: 'fn-b',
              namespace: 'demo',
              runtime: 'go',
            },
          ]);
        }
        return HttpResponse.json([
          {
            owner: 'twoGiants',
            repoName: 'fn-a',
            url: 'https://github.com/twoGiants/fn-a',
            defaultBranch: 'main',
            name: 'fn-a',
            namespace: 'demo',
            runtime: 'go',
          },
        ]);
      }),
    );
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
