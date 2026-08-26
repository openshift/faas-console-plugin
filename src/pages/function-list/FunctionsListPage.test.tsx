import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { authenticateGithubFake, logoutGithubFake } from '../../common/testing/authFake';
import { listFunctionsStub } from '../../common/testing/functionsClientStub';
import { FunctionListItem } from '../../common/types';
import FunctionsListPage from './FunctionsListPage';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the sdkTestDoubles available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../../common/testing/sdkTestDoubles'));

const streamStub = await vi.hoisted(
  async () => import('../../common/testing/consoleFetchStreamStub'),
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
    NamespaceBar: () => null,
    DocumentTitle: ({ children }: { children: string }) => children,
    ListPageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => (
      <>
        {title}
        {children}
      </>
    ),
    consoleFetchJSON,
    consoleFetch: streamStub.consoleFetchStub,
    SuccessStatus: ({ title }: { title: string }) => `Success: ${title}`,
    ProgressStatus: ({ title }: { title: string }) => `Progress: ${title}`,
    ErrorStatus: ({ title }: { title: string }) => `Error: ${title}`,
    InfoStatus: ({ title }: { title: string }) => `Info: ${title}`,
    StatusIconAndText: ({ title }: { title: string }) => `Warning: ${title}`,
    useDeleteModal: () => () => {},
    useK8sWatchResource: sdkTestDoubles.useK8sWatchResourceStub,
    useActiveNamespace: sdkTestDoubles.useActiveNamespaceStub,
    isAllNamespacesKey: sdkTestDoubles.isAllNamespaceKeyFake,
  };
});

describe('FunctionsListPage', () => {
  const funcName = 'my-func';

  beforeEach(() => {
    logoutGithubFake();
    authenticateGithubFake();
    streamStub.resetStreamFrames();
  });

  afterEach(() => {
    act(() => sdkTestDoubles.reset());
  });

  afterAll(() => {
    logoutGithubFake();
  });

  it('renders a spinner while loading', () => {
    listFunctionsStub();
    sdkTestDoubles.setWatchFixtures({ knLoaded: false, depLoaded: false });

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
    listFunctionsStub({ responses: [repoListItem(funcName)] });
    sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(funcName)).toBeInTheDocument();
  });

  it('shows cluster-only functions that have no discoverable repo', async () => {
    const funcName = 'cluster-only';
    listFunctionsStub({ responses: [clusterListItem(funcName)] });
    sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(funcName)).toBeInTheDocument();
  });

  it('shows NotDeployed status for repos without cluster deployment', async () => {
    listFunctionsStub({ responses: [repoListItem('orphan-func', 'orphan-func', 'demo', 'node')] });

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
    listFunctionsStub({ responses: [repoListItem(funcName)] });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'View setup guide.' })).toBeInTheDocument();
  });

  it('shows repo and cluster-only functions together in a union list', async () => {
    listFunctionsStub({ responses: [repoListItem('repo-func'), clusterListItem('cluster-func')] });
    sdkTestDoubles.setWatchFixtures({
      knSvcs: [
        sdkTestDoubles.ksvcFixture('repo-func', 'True'),
        sdkTestDoubles.ksvcFixture('cluster-func', 'True'),
      ],
      deps: [
        sdkTestDoubles.deploymentFixture('repo-func', 1, 1),
        sdkTestDoubles.deploymentFixture('cluster-func', 1, 1),
      ],
    });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('repo-func')).toBeInTheDocument();
    expect(screen.getByText('cluster-func')).toBeInTheDocument();
  });

  it('disables Edit button for cluster-only functions', async () => {
    listFunctionsStub({ responses: [clusterListItem('cluster-func')] });
    sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('cluster-func'));

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('cluster-func')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true');
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
    listFunctionsStub({ responses: [repoListItem(funcName)] });
    sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

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
    listFunctionsStub({ responses: [repoListItem(funcName)] });
    sdkTestDoubles.setWatchFixtures({
      knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'True')],
      deps: [sdkTestDoubles.deploymentFixture(funcName, 0, 0)],
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
    listFunctionsStub({ responses: [repoListItem(funcName)] });
    sdkTestDoubles.setWatchFixtures({ knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'True')] });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Progress: Deploying')).toBeInTheDocument();
  });

  it('shows Error status from ClusterFunction', async () => {
    listFunctionsStub({ responses: [repoListItem(funcName)] });
    sdkTestDoubles.setWatchFixtures({
      knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'False')],
      deps: [sdkTestDoubles.deploymentFixture(funcName, 0, 0)],
    });

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Error: Error')).toBeInTheDocument();
  });

  it('shows Building from the build stream, overriding cluster status', async () => {
    listFunctionsStub({ responses: [repoListItem(funcName)] });
    sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame([{ key: `twoGiants/${funcName}`, buildStatus: 'Building' }]),
    ]);

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Progress: Building')).toBeInTheDocument();
  });

  it('keeps Running when a build Failed but the cluster is Running', async () => {
    listFunctionsStub({ responses: [repoListItem(funcName)] });
    sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame([
        {
          key: `twoGiants/${funcName}`,
          buildStatus: 'Failed',
          failureReason: 'build / go test',
          runURL: 'https://github.com/twoGiants/my-func/actions/runs/1',
        },
      ]),
    ]);

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Success: Running')).toBeInTheDocument();
    expect(screen.queryByText('Error: BuildFailed')).not.toBeInTheDocument();
  });

  it('shows BuildFailed with the failure reason and run link from the build stream', async () => {
    listFunctionsStub({ responses: [repoListItem(funcName)] });
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame([
        {
          key: `twoGiants/${funcName}`,
          buildStatus: 'Failed',
          failureReason: 'build / go test',
          runURL: 'https://github.com/twoGiants/my-func/actions/runs/1',
        },
      ]),
    ]);

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Error: BuildFailed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Error: BuildFailed' })).toHaveAttribute(
      'href',
      'https://github.com/twoGiants/my-func/actions/runs/1',
    );
  });

  it('uses func.yaml name instead of repo name for cluster matching', async () => {
    listFunctionsStub({ responses: [repoListItem('my-repo', funcName, 'demo', 'node')] });
    sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));
    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(funcName)).toBeInTheDocument();
    expect(screen.getByText('Success: Running')).toBeInTheDocument();
  });

  describe('Refresh button behaviour', () => {
    it('re-fetch updates list after refresh if a repo was deleted', async () => {
      const salesFuncRepoItem = repoListItem('sales-aggregator', 'sales-aggregator', 'demo', 'go');
      const transcribeFuncRepoItem = repoListItem('transcriber', 'transcriber', 'demo', 'go');

      listFunctionsStub({
        responses: [salesFuncRepoItem, transcribeFuncRepoItem],
      });

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(salesFuncRepoItem.name)).toBeInTheDocument();
      expect(screen.getByText(transcribeFuncRepoItem.name)).toBeInTheDocument();

      // simulate transcribe func repo deletion
      listFunctionsStub({
        responses: [salesFuncRepoItem],
      });

      await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => {
        expect(screen.getByText(salesFuncRepoItem.name)).toBeInTheDocument();
        expect(screen.queryByText(transcribeFuncRepoItem.name)).not.toBeInTheDocument();
      });
    });

    it('does not show spinner on refresh button during initial page load', async () => {
      listFunctionsStub({ responses: [repoListItem(funcName)] });

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
      listFunctionsStub({
        responses: [repoListItem('fn-a')],
      });

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText('fn-a')).toBeInTheDocument();

      // add an infinite delay in form of a promise which we resolve later to
      // verify that the spinner is gone
      let continueWithRequest = () => {};
      listFunctionsStub({
        responses: [repoListItem('fn-a')],
        wait: new Promise<void>((r) => {
          continueWithRequest = r;
        }),
      });

      const refreshBtn = screen.getByRole('button', { name: 'Refresh' });

      await userEvent.click(refreshBtn);
      expect(refreshBtn.querySelector('[role="progressbar"]')).toBeInTheDocument();

      continueWithRequest();
      await waitFor(() => {
        expect(refreshBtn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
      });
    });
  });

  describe('Namespace scoping', () => {
    const devNamespace = 'dev';
    const prodNamespace = 'prod';
    const salesFuncName = 'sales-aggregator';
    const transcriberFuncName = 'transcriber';

    beforeEach(() => {
      const func1Ksvc = sdkTestDoubles.ksvcFixture(salesFuncName, 'True', devNamespace);
      const func1Depl = sdkTestDoubles.deploymentFixture(salesFuncName, 1, 1, devNamespace);

      const func2Ksvc = sdkTestDoubles.ksvcFixture(transcriberFuncName, 'True', prodNamespace);
      const func2Depl = sdkTestDoubles.deploymentFixture(transcriberFuncName, 2, 2, prodNamespace);

      sdkTestDoubles.setWatchFixtures({
        knSvcs: [func1Ksvc, func2Ksvc],
        deps: [func1Depl, func2Depl],
      });

      listFunctionsStub({
        responses: [
          clusterListItem(salesFuncName, devNamespace),
          clusterListItem(transcriberFuncName, prodNamespace),
        ],
      });
    });

    it('shows function from active "dev" namespace and ignores function from "prod" namespace', async () => {
      sdkTestDoubles.setActiveNamespace(devNamespace);

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(salesFuncName)).toBeInTheDocument();
      expect(screen.getByText(1)).toBeInTheDocument();

      expect(screen.queryByText(devNamespace)).not.toBeInTheDocument();
      expect(screen.queryByText(transcriberFuncName)).not.toBeInTheDocument();
      expect(screen.queryByText(prodNamespace)).not.toBeInTheDocument();

      expect(screen.getAllByText('Success: Running')).toHaveLength(1);
    });

    it('shows cluster functions from all namespaces when all namespaces are active', async () => {
      sdkTestDoubles.setActiveNamespace('#ALL_NS#');

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(salesFuncName)).toBeInTheDocument();
      expect(screen.getByText(devNamespace)).toBeInTheDocument();
      expect(screen.getByText(1)).toBeInTheDocument();

      expect(screen.queryByText(transcriberFuncName)).toBeInTheDocument();
      expect(screen.queryByText(prodNamespace)).toBeInTheDocument();
      expect(screen.getByText(2)).toBeInTheDocument();

      expect(screen.getAllByText('Success: Running')).toHaveLength(2);
    });

    it('missing namespace shows an error', async () => {
      sdkTestDoubles.setActiveNamespace('');

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(/namespace can not be empty/)).toBeInTheDocument();
      expect(screen.queryByText(salesFuncName)).not.toBeInTheDocument();
      expect(screen.queryByText(transcriberFuncName)).not.toBeInTheDocument();
    });

    it('shows spinner during load after namespace switch, hiding stale rows', async () => {
      sdkTestDoubles.setActiveNamespace(devNamespace);

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(salesFuncName)).toBeInTheDocument();

      let continueWithRequest = () => {};
      listFunctionsStub({
        responses: [clusterListItem(transcriberFuncName, prodNamespace)],
        wait: new Promise<void>((r) => {
          continueWithRequest = r;
        }),
      });

      act(() => sdkTestDoubles.setActiveNamespace(prodNamespace));

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByText(salesFuncName)).not.toBeInTheDocument();

      continueWithRequest();
      expect(await screen.findByText(transcriberFuncName)).toBeInTheDocument();
    });

    it('re-fetches function when namespace changes from "dev" to "prod"', async () => {
      sdkTestDoubles.setActiveNamespace(devNamespace);

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(salesFuncName)).toBeInTheDocument();
      expect(screen.getByText(1)).toBeInTheDocument();
      expect(screen.queryByText(devNamespace)).not.toBeInTheDocument();
      expect(screen.queryByText(transcriberFuncName)).not.toBeInTheDocument();
      expect(screen.queryByText(prodNamespace)).not.toBeInTheDocument();
      expect(screen.getAllByText('Success: Running')).toHaveLength(1);

      // triggers re-render + re-fetch
      act(() => sdkTestDoubles.setActiveNamespace(prodNamespace));

      expect(await screen.findByText(transcriberFuncName)).toBeInTheDocument();
      expect(screen.getByText(2)).toBeInTheDocument();
      expect(screen.queryByText(prodNamespace)).not.toBeInTheDocument();
      expect(screen.queryByText(salesFuncName)).not.toBeInTheDocument();
      expect(screen.queryByText(devNamespace)).not.toBeInTheDocument();
      expect(screen.getAllByText('Success: Running')).toHaveLength(1);
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
    source: 'cluster',
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
    source: 'repo',
  };
}
