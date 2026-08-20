import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../testing/msw/server';
import { MemoryRouter } from 'react-router';
import FunctionsListPage from './FunctionsListPage';
import { PAT_KEY, USER_KEY } from '../../common/types';
import { BACKEND_API } from '../../../testing/setup';

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
    SuccessStatus: ({ title }: { title: string }) => `Success: ${title}`,
    ProgressStatus: ({ title }: { title: string }) => `Progress: ${title}`,
    ErrorStatus: ({ title }: { title: string }) => `Error: ${title}`,
    InfoStatus: ({ title }: { title: string }) => `Info: ${title}`,
    StatusIconAndText: ({ title }: { title: string }) => `Warning: ${title}`,
    useDeleteModal: () => () => {},
  };
});

const mockUseCluster = vi.fn();
vi.mock('../../common/clients/useCluster', () => ({
  useCluster: (...args: unknown[]) => mockUseCluster(...args),
}));

describe('FunctionsListPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterAll(() => {
    sessionStorage.clear();
  });

  it('renders a spinner while loading', () => {
    renderAuthenticated();
    setupBackendListAPIResponse([]);
    mockUseCluster.mockReturnValue(clusterData({ loaded: false }));

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders the empty state when loaded with no functions', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([]);
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No functions found' })).toBeInTheDocument();
  });

  it('renders table when functions are loaded', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([listItem('my-func')]);
    mockUseCluster.mockReturnValue(
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

    expect(await screen.findByText('my-func')).toBeInTheDocument();
  });

  it('shows cluster-only functions that have no discoverable repo', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([clusterOnlyListItem('cluster-only')]);
    mockUseCluster.mockReturnValue(
      clusterData({
        functions: [clusterFunction('cluster-only', 'Running', 1)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('cluster-only')).toBeInTheDocument();
  });

  it('shows NotDeployed status for repos without cluster deployment', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([listItem('orphan-func', 'orphan-func', 'demo', 'node')]);
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Info: NotDeployed')).toBeInTheDocument();
  });

  it('shows error alert when listing functions fails', async () => {
    renderAuthenticated();
    server.use(
      http.get(`${BACKEND_API}/api/v1/func/list`, () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );
    mockUseCluster.mockReturnValue(clusterData());

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
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No functions found' })).toBeInTheDocument();
  });

  it('does not call backend API when not authenticated', async () => {
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { name: 'No functions found', hidden: true }),
    ).toBeInTheDocument();
  });

  it('renders UserAvatar in header', () => {
    renderAuthenticated();
    setupBackendListAPIResponse([]);
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('twoGiants')).toBeInTheDocument();
  });

  it('empty state receives hint and isCreateDisabled when not authenticated', async () => {
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { name: 'No functions found', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create function', hidden: true })).toBeDisabled();
  });

  it('enriches function with status, replicas, and URL from ClusterFunction', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([listItem('my-func')]);
    mockUseCluster.mockReturnValue(
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

    expect(await screen.findByText('Success: Running')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'my-func-demo' })).toHaveAttribute(
      'href',
      'https://my-func-demo.apps.example.com',
    );
  });

  it('shows ScaledToZero status and 0 replicas from ClusterFunction', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([listItem('my-func')]);
    mockUseCluster.mockReturnValue(
      clusterData({
        functions: [clusterFunction('my-func', 'ScaledToZero', 0)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Info: ScaledToZero')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('shows Deploying status from ClusterFunction', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([listItem('my-func')]);
    mockUseCluster.mockReturnValue(
      clusterData({
        functions: [clusterFunction('my-func', 'Deploying', 0)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Progress: Deploying')).toBeInTheDocument();
  });

  it('shows Error status from ClusterFunction', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([listItem('my-func')]);
    mockUseCluster.mockReturnValue(
      clusterData({
        functions: [clusterFunction('my-func', 'Error', 0)],
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Error: Error')).toBeInTheDocument();
  });

  it('passes function names to useCluster', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([listItem('fn-a')]);
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByText('fn-a');

    expect(mockUseCluster).toHaveBeenLastCalledWith(['fn-a']);
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
            repoURL: 'https://github.com/twoGiants/fn-a',
            defaultBranch: 'main',
            name: 'fn-a',
            namespace: 'demo',
            runtime: 'go',
          },
        ]);
      }),
    );
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByText('fn-a');
    expect(callCount).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(callCount).toBe(2);
    });
  });

  it('does not show spinner on refresh button during initial page load', async () => {
    renderAuthenticated();
    setupBackendListAPIResponse([listItem('fn-a')]);
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByText('fn-a');

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
          repoURL: 'https://github.com/twoGiants/fn-a',
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
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByText('fn-a');

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
    setupBackendListAPIResponse([listItem('my-repo', 'my-function', 'demo', 'node')]);
    mockUseCluster.mockReturnValue(
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

    expect(await screen.findByText('my-function')).toBeInTheDocument();
    expect(screen.getByText('Success: Running')).toBeInTheDocument();
    expect(mockUseCluster).toHaveBeenLastCalledWith(['my-function']);
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
              repoURL: 'https://github.com/twoGiants/fn-a',
              defaultBranch: 'main',
              name: 'fn-a',
              namespace: 'demo',
              runtime: 'go',
            },
            {
              owner: 'twoGiants',
              repoName: 'fn-b',
              repoURL: 'https://github.com/twoGiants/fn-b',
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
            repoURL: 'https://github.com/twoGiants/fn-a',
            defaultBranch: 'main',
            name: 'fn-a',
            namespace: 'demo',
            runtime: 'go',
          },
        ]);
      }),
    );
    mockUseCluster.mockReturnValue(clusterData());

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    await screen.findByText('fn-a');
    expect(screen.getByText('fn-b')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(screen.getByText('fn-a')).toBeInTheDocument();
      expect(screen.queryByText('fn-b')).not.toBeInTheDocument();
    });
  });
});

function renderAuthenticated() {
  sessionStorage.setItem(PAT_KEY, 'ghp_test');
  sessionStorage.setItem(
    USER_KEY,
    JSON.stringify({ name: 'twoGiants', avatarUrl: 'https://valid.url' }),
  );
}

function setupBackendListAPIResponse(
  items: {
    owner: string;
    repoName: string;
    repoURL: string;
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
          repoURL: i.repoURL,
          defaultBranch: 'main',
          name: i.name,
          namespace: i.namespace,
          runtime: i.runtime,
        })),
      ),
    ),
  );
}

function clusterOnlyListItem(name: string, namespace = 'demo', runtime = 'node') {
  return {
    owner: '',
    repoName: '',
    repoURL: '',
    name,
    namespace,
    runtime,
    source: 'cluster',
  };
}

function listItem(repoName: string, name?: string, namespace = 'demo', runtime = 'go') {
  return {
    owner: 'twoGiants',
    repoName,
    repoURL: `https://github.com/twoGiants/${repoName}`,
    name: name ?? repoName,
    namespace,
    runtime,
    source: 'repo',
  };
}

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
