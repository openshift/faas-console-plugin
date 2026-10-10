import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { authenticateGithubFake, logoutGithubFake } from '../../common/testing/authFake';
import { listFunctionsStub } from '../../common/testing/functionsClientStub';
import { server } from '../../common/testing/mswServer';
import { repoListItem } from '../../common/testing/testData';
import { FunctionListItem } from '../../common/types';
import FunctionsListPageV2 from './FunctionsListPageV2';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the sdkTestDoubles available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../../common/testing/sdkTestDoubles'));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  NamespaceBar: () => null,
  DocumentTitle: ({ children }: { children: string }) => children,
  ListPageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <>
      {title}
      {children}
    </>
  ),
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONFake,
  consoleFetch: sdkTestDoubles.consoleFetchFake,
  SuccessStatus: ({ title }: { title: string }) => <span>Success: {title}</span>,
  ProgressStatus: ({ title }: { title: string }) => <span>Progress: {title}</span>,
  ErrorStatus: ({ title }: { title: string }) => <span>Error: {title}</span>,
  InfoStatus: ({ title }: { title: string }) => <span>Info: {title}</span>,
  StatusIconAndText: ({ title }: { title: string }) => <span>Warning: {title}</span>,
  useDeleteModal: () => () => {},
  useK8sWatchResource: sdkTestDoubles.useK8sWatchResourceStub,
  useActiveNamespace: sdkTestDoubles.useActiveNamespaceStub,
  isAllNamespacesKey: sdkTestDoubles.isAllNamespaceKeyFake,
}));

describe('FunctionsListPageV2', () => {
  const funcName = 'my-func';

  beforeEach(() => {
    logoutGithubFake();
    authenticateGithubFake();
  });

  afterEach(() => {
    server.resetHandlers();
    act(() => sdkTestDoubles.reset());
  });

  afterAll(() => {
    logoutGithubFake();
  });

  describe('Visible page elements and loading states', () => {
    it('renders a spinner while loading', () => {
      listFunctionsStub();
      sdkTestDoubles.setWatchFixtures({ knLoaded: false, depLoaded: false });

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('renders the empty state when loaded with no functions', async () => {
      listFunctionsStub();

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(
        await screen.findByRole('heading', { name: 'No functions found' }),
      ).toBeInTheDocument();
    });

    it('renders table when functions are loaded', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: funcName })] });
      sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(await screen.findByText(funcName)).toBeInTheDocument();
    });

    it('renders UserAvatar in header', () => {
      listFunctionsStub();

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(screen.getByText('twoGiants')).toBeInTheDocument();
    });

    it('renders the setup guide button in the list description', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: funcName })] });

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(await screen.findByRole('button', { name: 'View setup guide.' })).toBeInTheDocument();
    });
  });

  describe('Auth and general error', () => {
    it('renders empty state when API fails', async () => {
      listFunctionsStub({ errorResponse: { message: 'Requires authentication', status: 401 } });

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(
        await screen.findByRole('heading', { name: 'No functions found' }),
      ).toBeInTheDocument();
    });

    it('does not call backend API when not authenticated', async () => {
      logoutGithubFake();
      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(
        await screen.findByRole('heading', { name: 'No functions found', hidden: true }),
      ).toBeInTheDocument();
    });

    it('empty state receives hint and isCreateDisabled when not authenticated', async () => {
      logoutGithubFake();
      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(
        await screen.findByRole('heading', { name: 'No functions found', hidden: true }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create function', hidden: true })).toBeDisabled();
    });

    it('shows error alert when listing functions fails', async () => {
      listFunctionsStub({ errorResponse: { message: 'Bad credentials', status: 401 } });

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(await screen.findByText(/Bad credentials/)).toBeInTheDocument();
    });
  });

  describe('Functions table', () => {
    describe('Listing', () => {
      it('shows repo and cluster-only functions together in a union list', async () => {
        listFunctionsStub({
          responses: [repoListItem({ repoName: 'repo-func' }), clusterListItem('cluster-func')],
        });
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
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText('repo-func')).toBeInTheDocument();
        expect(screen.getByText('cluster-func')).toBeInTheDocument();
      });

      it('shows cluster-only functions that have no discoverable repo', async () => {
        const funcName = 'cluster-only';
        listFunctionsStub({ responses: [clusterListItem(funcName)] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
      });

      it('disables edit button for cluster-only functions', async () => {
        listFunctionsStub({ responses: [clusterListItem('cluster-func')] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('cluster-func'));

        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText('cluster-func')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute(
          'aria-disabled',
          'true',
        );
      });

      it('shows dash for URL and Replicas for repo functions which are not deployed yet', async () => {
        listFunctionsStub({ responses: [repoListItem({ repoName: funcName })] });

        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: NotDeployed')).toBeInTheDocument();
        const row = screen.getByText(funcName).closest('tr')!;
        expect(row.querySelector('[data-label="URL"]')).toHaveTextContent('—');
        expect(row.querySelector('[data-label="Replicas"]')).toHaveTextContent('—');
      });

      it('enriches function with status, replicas, and routeURL from cluster data', async () => {
        listFunctionsStub({ responses: [repoListItem({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Success: Running')).toBeInTheDocument();
        expect(screen.getByText('1')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'my-func-demo' })).toHaveAttribute(
          'href',
          'https://my-func-demo.apps.example.com',
        );
      });

      // Repo name is 'my-repo' but func.yaml name is 'my-func'. The ksvc is
      // labeled with the func.yaml name. Proves matching uses the function name,
      // not the repo name.
      it('uses func.yaml name instead of repo name for cluster matching', async () => {
        listFunctionsStub({
          responses: [
            repoListItem({
              repoName: 'my-repo',
              name: funcName,
              namespace: 'demo',
              runtime: 'node',
            }),
          ],
        });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));
        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
        expect(screen.getByText('Success: Running')).toBeInTheDocument();
      });
    });

    describe('Status column', () => {
      it('shows NotDeployed status for repos without cluster deployment', async () => {
        listFunctionsStub({
          responses: [
            repoListItem({
              repoName: 'orphan-func',
              name: 'orphan-func',
              namespace: 'demo',
              runtime: 'node',
            }),
          ],
        });

        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: NotDeployed')).toBeInTheDocument();
      });

      it('shows ScaledToZero status and 0 replicas for a deployment with 0 desired and ready replicas', async () => {
        listFunctionsStub({ responses: [repoListItem({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'True')],
          deps: [sdkTestDoubles.deploymentFixture(funcName, 0, 0)],
        });

        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: ScaledToZero')).toBeInTheDocument();
        expect(screen.getByText('0')).toBeInTheDocument();
      });

      it('shows Deploying status when there is a ksvc but no deployment yet', async () => {
        listFunctionsStub({ responses: [repoListItem({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({ knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'True')] });

        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: Deploying')).toBeInTheDocument();
      });

      it('shows Error status with error message tooltip when the ready condition is false', async () => {
        listFunctionsStub({ responses: [repoListItem({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'False')],
          deps: [sdkTestDoubles.deploymentFixture(funcName, 0, 0)],
        });

        render(
          <MemoryRouter>
            <FunctionsListPageV2 />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Error: Error')).toBeInTheDocument();
        await userEvent.setup().hover(screen.getByText('Error: Error'));
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Ready condition is False');
      });
    });
  });

  describe('Refresh button behaviour', () => {
    it('re-fetch updates list after refresh if a repo was deleted', async () => {
      const salesFuncRepoItem = repoListItem({
        repoName: 'sales-aggregator',
        name: 'sales-aggregator',
        namespace: 'demo',
        runtime: 'go',
      });
      const transcribeFuncRepoItem = repoListItem({
        repoName: 'transcriber',
        name: 'transcriber',
        namespace: 'demo',
        runtime: 'go',
      });

      listFunctionsStub({
        responses: [salesFuncRepoItem, transcribeFuncRepoItem],
      });

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
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
      listFunctionsStub({ responses: [repoListItem({ repoName: funcName })] });

      render(
        <MemoryRouter>
          <FunctionsListPageV2 />
        </MemoryRouter>,
      );

      expect(await screen.findByText(funcName)).toBeInTheDocument();
      const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
      expect(refreshBtn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
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
          <FunctionsListPageV2 />
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
          <FunctionsListPageV2 />
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
          <FunctionsListPageV2 />
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
          <FunctionsListPageV2 />
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
          <FunctionsListPageV2 />
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
// Testing framework -----------------------------------------------------------
// -----------------------------------------------------------------------------

// Test data factories ---------------------------------------------------------
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
