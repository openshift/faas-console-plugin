import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { BACKEND_API } from '../../common/testing/constants';
import { FunctionListItem } from '../../common/types';
import FunctionsListPage from './FunctionsListPage';
import userEvent from '@testing-library/user-event';
import { server } from '../../common/testing/mswServer';
import { authenticateGithubFake, logoutGithubFake } from '../../common/testing/authFake';
import { listFunctionsStub } from '../../common/testing/functionsClientStub';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the clusterStub available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const clusterStub = await vi.hoisted(
  async () => import('../../common/testing/useK8sWatchResourceStub'),
);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', async () => {
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
    useK8sWatchResource: clusterStub.useK8sWatchResourceStub,
  };
});

describe('FunctionsListPage', () => {
  const funcName = 'my-func';

  beforeEach(() => {
    logoutGithubFake();
    authenticateGithubFake();
  });

  afterEach(() => clusterStub.setFixtures({}));

  afterAll(() => {
    logoutGithubFake();
  });

  it('renders a spinner while loading', () => {
    listFunctionsStub();
    clusterStub.setFixtures({ knLoaded: false, depLoaded: false });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders the empty state when loaded with no functions', async () => {
    listFunctionsStub();

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No functions found' })).toBeInTheDocument();
  });

  it('renders table when functions are loaded', async () => {
    listFunctionsStub({ response: repoListItem(funcName) });
    clusterStub.setFixtures(clusterStub.funcFixture(funcName));

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(funcName)).toBeInTheDocument();
  });

  it('shows cluster-only functions that have no discoverable repo', async () => {
    const funcName = 'cluster-only';
    listFunctionsStub({ response: clusterListItem(funcName) });
    clusterStub.setFixtures(clusterStub.funcFixture(funcName));

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(funcName)).toBeInTheDocument();
  });

  it('shows NotDeployed status for repos without cluster deployment', async () => {
    listFunctionsStub({ response: repoListItem('orphan-func', 'orphan-func', 'demo', 'node') });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Info: NotDeployed')).toBeInTheDocument();
  });

  it('shows error alert when listing functions fails', async () => {
    listFunctionsStub({ errorResponse: { message: 'Bad credentials', status: 401 } });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Bad credentials/)).toBeInTheDocument();
  });

  it('renders empty state when API fails', async () => {
    listFunctionsStub({ errorResponse: { message: 'Requires authentication', status: 401 } });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No functions found' })).toBeInTheDocument();
  });

  it('does not call backend API when not authenticated', async () => {
    logoutGithubFake();
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
    listFunctionsStub();

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('twoGiants')).toBeInTheDocument();
  });

  it('renders the setup guide button in the list description', async () => {
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

    expect(await screen.findByRole('button', { name: 'View setup guide.' })).toBeInTheDocument();
  });

  it('empty state receives hint and isCreateDisabled when not authenticated', async () => {
    logoutGithubFake();
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
    listFunctionsStub({ response: repoListItem(funcName) });
    clusterStub.setFixtures(clusterStub.funcFixture(funcName));

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
    listFunctionsStub({ response: repoListItem(funcName) });
    clusterStub.setFixtures({
      knSvcs: [clusterStub.ksvcFixture(funcName, 'True')],
      deps: [clusterStub.deploymentFixture(funcName, 0, 0)],
    });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Info: ScaledToZero')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('shows Deploying status from ClusterFunction', async () => {
    listFunctionsStub({ response: repoListItem(funcName) });
    clusterStub.setFixtures({ knSvcs: [clusterStub.ksvcFixture(funcName, 'True')] });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Progress: Deploying')).toBeInTheDocument();
  });

  it('shows Error status from ClusterFunction', async () => {
    listFunctionsStub({ response: repoListItem(funcName) });
    clusterStub.setFixtures({
      knSvcs: [clusterStub.ksvcFixture(funcName, 'False')],
      deps: [clusterStub.deploymentFixture(funcName, 0, 0)],
    });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Error: Error')).toBeInTheDocument();
  });

  it('re-fetches functions when refresh button is clicked', async () => {
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
            name: funcName,
            namespace: 'demo',
            runtime: 'go',
          },
        ]);
      }),
    );

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(funcName)).toBeInTheDocument();
    expect(callCount).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(callCount).toBe(2);
    });
  });

  it('does not show spinner on refresh button during initial page load', async () => {
    listFunctionsStub({ response: repoListItem(funcName) });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(funcName)).toBeInTheDocument();
    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
    expect(refreshBtn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
  });

  it('shows spinner on refresh button only while a button-triggered refresh is in flight', async () => {
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

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('fn-a')).toBeInTheDocument();

    const refreshBtn = screen.getByRole('button', { name: 'Refresh' });

    await userEvent.click(refreshBtn);
    expect(refreshBtn.querySelector('[role="progressbar"]')).toBeInTheDocument();

    resolveList!();
    await waitFor(() => {
      expect(refreshBtn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
    });
  });

  it('uses func.yaml name instead of repo name for cluster matching', async () => {
    listFunctionsStub({ response: repoListItem('my-repo', funcName, 'demo', 'node') });
    clusterStub.setFixtures(clusterStub.funcFixture(funcName));
    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(funcName)).toBeInTheDocument();
    expect(screen.getByText('Success: Running')).toBeInTheDocument();
  });

  it('removes a deleted repo from the list after refresh', async () => {
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

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('fn-a')).toBeInTheDocument();
    expect(screen.getByText('fn-b')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(screen.getByText('fn-a')).toBeInTheDocument();
      expect(screen.queryByText('fn-b')).not.toBeInTheDocument();
    });
  });
});

// -----------------------------------------------------------------------------
// Test data factories ---------------------------------------------------------
// -----------------------------------------------------------------------------
function clusterListItem(name: string, namespace = 'demo', runtime = 'node'): FunctionListItem {
  return {
    owner: '',
    repoName: '',
    repoURL: '',
    defaultBranch: 'main',
    name,
    namespace,
    runtime,
  };
}

function repoListItem(
  repoName: string,
  name?: string,
  namespace = 'demo',
  runtime = 'go',
): FunctionListItem {
  return {
    owner: 'twoGiants',
    repoName,
    repoURL: `https://github.com/twoGiants/${repoName}`,
    defaultBranch: 'main',
    name: name ?? repoName,
    namespace,
    runtime,
  };
}
