import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { authenticateGithubFake, logoutGithubFake } from '../../common/testing/authFake';
import {
  listFunctionsStub,
  receiveWorkflowRunEventsStub,
  WorkflowRunStreamEvent,
} from '../../common/testing/functionsClientStub';
import { server } from '../../common/testing/mswServer';
import { functionMetadata } from '../../common/testing/testData';
import { timerFake } from '../../common/testing/timerFake';
import { FUNCTION_NAME_LABEL, FunctionMetadata } from '../../common/types';
import { AsyncQueue } from '../../common/testing/AsyncQueue';
import FunctionsListPage from './FunctionsListPage';

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
  ErrorStatus: ({ title }: { title: string }) => <span>Error: {title}</span>,
  InfoStatus: ({ title }: { title: string }) => <span>Info: {title}</span>,
  StatusIconAndText: ({ title }: { title: string }) => <span>Warning: {title}</span>,
  useDeleteModal: sdkTestDoubles.useDeleteModalStub,
  useK8sWatchResource: sdkTestDoubles.useK8sWatchResourceStub,
  useActiveNamespace: sdkTestDoubles.useActiveNamespaceStub,
  isAllNamespacesKey: sdkTestDoubles.isAllNamespaceKeyFake,
}));

describe('FunctionsListPage', () => {
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

      expect(
        await screen.findByRole('heading', { name: 'No functions found' }),
      ).toBeInTheDocument();
    });

    it('renders table when functions are loaded', async () => {
      listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
      sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(funcName)).toBeInTheDocument();
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
      listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });

      render(
        <MemoryRouter>
          <FunctionsListPage />
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
          <FunctionsListPage />
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
          <FunctionsListPage />
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
          <FunctionsListPage />
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
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText(/Bad credentials/)).toBeInTheDocument();
    });

    it('resets functions when user reconnects', async () => {
      listFunctionsStub({ responses: [functionMetadata({ repoName: 'fn-a' })] });

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText('fn-a')).toBeInTheDocument();

      listFunctionsStub({ responses: [functionMetadata({ repoName: 'fn-b', name: 'fn-b' })] });

      // Click avatar to open PAT modal
      await userEvent.setup().click(screen.getByRole('button', { name: 'twoGiants' }));

      // Enter PAT and submit
      await userEvent.setup().type(screen.getByLabelText('Personal Access Token'), 'ghp_new');
      await userEvent.setup().click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => {
        expect(screen.getByText('fn-b')).toBeInTheDocument();
        expect(screen.queryByText('fn-a')).not.toBeInTheDocument();
      });
    });
  });

  describe('Functions table', () => {
    describe('Listing', () => {
      it('shows repo and cluster-only functions together in a union list', async () => {
        listFunctionsStub({
          responses: [
            functionMetadata({ repoName: 'repo-func' }),
            clusterFunctionMetadata('cluster-func'),
          ],
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
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('repo-func')).toBeInTheDocument();
        expect(screen.getByText('cluster-func')).toBeInTheDocument();
      });

      it('shows cluster-only functions that have no discoverable repo', async () => {
        const funcName = 'cluster-only';
        listFunctionsStub({ responses: [clusterFunctionMetadata(funcName)] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
      });

      it('disables edit button for cluster-only functions', async () => {
        listFunctionsStub({ responses: [clusterFunctionMetadata('cluster-func')] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('cluster-func'));

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('cluster-func')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute(
          'aria-disabled',
          'true',
        );
      });

      it('shows dash for URL and Replicas for repo functions which are not deployed yet', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: NotDeployed')).toBeInTheDocument();
        const row = screen.getByText(funcName).closest('tr')!;
        expect(row.querySelector('[data-label="URL"]')).toHaveTextContent('—');
        expect(row.querySelector('[data-label="Replicas"]')).toHaveTextContent('—');
      });

      it('enriches function with status, replicas, and routeURL from cluster data', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
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

      // Repo name is 'my-repo' but func.yaml name is 'my-func'. The ksvc is
      // labeled with the func.yaml name. Proves matching uses the function name,
      // not the repo name.
      it('uses func.yaml name instead of repo name for cluster matching', async () => {
        listFunctionsStub({
          responses: [
            functionMetadata({
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
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
        expect(screen.getByText('Success: Running')).toBeInTheDocument();
      });

      it('shows dash for runtime when runtime is empty', async () => {
        listFunctionsStub({ responses: [clusterFunctionMetadata('cluster-func', 'demo', '')] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('cluster-func'));

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('cluster-func')).toBeInTheDocument();
        const row = screen.getByText('cluster-func').closest('tr')!;
        expect(row.querySelector('[data-label="Runtime"]')).toHaveTextContent('—');
      });

      it('hides namespace column in single-namespace view', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
        expect(screen.queryByText('Namespace')).not.toBeInTheDocument();
      });

      it('shows tooltip on secondary workflow-run-failure indicator', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));
        receiveWorkflowRunEventsStub({
          snapshot: {
            [`twoGiants/${funcName}`]: {
              status: 'Failed',
              url: 'https://github.com/twoGiants/my-func/actions/runs/1',
            },
          },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Success: Running')).toBeInTheDocument();
        const indicator = screen.getByRole('link', { name: 'Latest workflow run failed' });
        await userEvent.setup().hover(indicator);
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Latest workflow run failed');
      });
    });

    describe('Actions', () => {
      it('navigates to edit page using repoName, not display name', async () => {
        listFunctionsStub({
          responses: [functionMetadata({ repoName: 'my-repo', name: 'my-display-name' })],
        });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('my-display-name'));

        const EditPage = () => {
          const { name } = useParams();
          return <div>Editing: {name}</div>;
        };

        render(
          <MemoryRouter>
            <Routes>
              <Route path="/" element={<FunctionsListPage />} />
              <Route path="/faas/edit/:name" element={<EditPage />} />
            </Routes>
          </MemoryRouter>,
        );

        expect(await screen.findByText('my-display-name')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Edit' }));
        expect(screen.getByText('Editing: my-repo')).toBeInTheDocument();
      });

      it('edit button is disabled for cluster-only functions', async () => {
        listFunctionsStub({ responses: [clusterFunctionMetadata('cluster-func')] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('cluster-func'));

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('cluster-func')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute(
          'aria-disabled',
          'true',
        );
      });

      it('explains why edit is disabled on hover for cluster-only functions', async () => {
        listFunctionsStub({ responses: [clusterFunctionMetadata('cluster-func')] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('cluster-func'));

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('cluster-func')).toBeInTheDocument();
        await userEvent.setup().hover(screen.getByRole('button', { name: 'Edit' }));
        expect(await screen.findByText('No source repository to edit')).toBeInTheDocument();
      });

      it('disables delete button for functions without a cluster resource', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
      });

      it('launches undeploy modal when delete button is clicked', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Delete' }));
        expect(screen.getByRole('dialog')).toHaveTextContent('Undeploy');
      });
    });

    describe('Status column', () => {
      it('shows NotDeployed status for repos without cluster deployment', async () => {
        listFunctionsStub({
          responses: [
            functionMetadata({
              repoName: 'orphan-func',
              name: 'orphan-func',
              namespace: 'demo',
              runtime: 'node',
            }),
          ],
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: NotDeployed')).toBeInTheDocument();
      });

      it('shows ScaledToZero status and 0 replicas for a deployment with 0 desired and ready replicas', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
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

      it('shows Deploying status when there is a ksvc but no deployment yet', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({ knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'True')] });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: Deploying')).toBeInTheDocument();
      });

      it('shows Error status with error message tooltip when the ready condition is false', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
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
        await userEvent.setup().hover(screen.getByText('Error: Error'));
        expect(await screen.findByRole('tooltip')).toHaveTextContent(
          'Deployment error. Reason: Unknown.',
        );
      });

      it('shows Deploying when Ready condition is Unknown', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'Unknown')],
          deps: [sdkTestDoubles.deploymentFixture(funcName, 1, 0)],
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: Deploying')).toBeInTheDocument();
      });

      it('shows Deploying when no Ready condition exists', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        const ksvc = sdkTestDoubles.ksvcFixture(funcName, 'True');
        ksvc.status!.conditions[0].type = 'ConfigurationsReady';
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [ksvc],
          deps: [sdkTestDoubles.deploymentFixture(funcName, 1, 1)],
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: Deploying')).toBeInTheDocument();
      });

      it('falls back to function name label when no latestReadyRevisionName', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        const fixture = sdkTestDoubles.funcFixture(funcName);
        fixture.knSvcs![0].status!.latestReadyRevisionName = undefined;
        fixture.deps![0].metadata!.labels = { [FUNCTION_NAME_LABEL]: funcName };
        sdkTestDoubles.setWatchFixtures(fixture);

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Success: Running')).toBeInTheDocument();
      });

      it('picks latest revision deployment when multiple revisions exist', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        const ksvc = sdkTestDoubles.ksvcFixture(funcName, 'True');
        ksvc.status!.latestReadyRevisionName = 'my-func-00002';
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [ksvc],
          deps: [
            sdkTestDoubles.deploymentFixture(funcName, 0, 0, 'demo', 'my-func-00001'),
            sdkTestDoubles.deploymentFixture(funcName, 2, 2, 'demo', 'my-func-00002'),
          ],
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Success: Running')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
      });

      it('does not match deployments from a different namespace', async () => {
        sdkTestDoubles.setActiveNamespace('#ALL_NS#');
        listFunctionsStub({
          responses: [
            functionMetadata({ repoName: 'shared-func', name: 'shared-func', namespace: 'ns-a' }),
            functionMetadata({ repoName: 'shared-func', name: 'shared-func', namespace: 'ns-b' }),
          ],
        });
        const sharedRevision = 'shared-func-00001';
        const ksvcA = sdkTestDoubles.ksvcFixture('shared-func', 'True', 'ns-a');
        ksvcA.status!.latestReadyRevisionName = sharedRevision;
        const ksvcB = sdkTestDoubles.ksvcFixture('shared-func', 'True', 'ns-b');
        ksvcB.status!.latestReadyRevisionName = sharedRevision;
        const depB = sdkTestDoubles.deploymentFixture('shared-func', 1, 1, 'ns-b', sharedRevision);
        sdkTestDoubles.setWatchFixtures({ knSvcs: [ksvcA, ksvcB], deps: [depB] });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findAllByText('shared-func')).toHaveLength(2);
        const rows = screen.getAllByText('shared-func').map((el) => el.closest('tr')!);
        const rowA = rows.find((r) => r.textContent?.includes('ns-a'))!;
        const rowB = rows.find((r) => r.textContent?.includes('ns-b'))!;
        expect(rowA).toHaveTextContent('Info: Deploying');
        expect(rowB).toHaveTextContent('Success: Running');
      });

      it('shows empty route URL when ksvc has no status url', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        const ksvc = sdkTestDoubles.ksvcFixture(funcName, 'True');
        ksvc.status = {};
        sdkTestDoubles.setWatchFixtures({ knSvcs: [ksvc] });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
        const row = screen.getByText(funcName).closest('tr')!;
        expect(row.querySelector('[data-label="URL"]')).toHaveTextContent('—');
      });

      it('shows Undeploying when ksvc has a deletionTimestamp', async () => {
        const ksvc = sdkTestDoubles.ksvcFixture(funcName, 'True');
        ksvc.metadata!.deletionTimestamp = '2026-10-10T12:00:00Z';
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [ksvc],
          deps: [sdkTestDoubles.deploymentFixture(funcName, 1, 1)],
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: Undeploying')).toBeInTheDocument();
      });

      it('surfaces K8s watch errors', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({
          knError: new Error('ksvc watch failed'),
          depError: new Error('dep watch failed'),
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(/ksvc watch failed/)).toBeInTheDocument();
        expect(screen.getByText(/dep watch failed/)).toBeInTheDocument();
      });

      it('shows build-in-progress indicator as primary status when the function is not yet deployed', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        receiveWorkflowRunEventsStub({
          snapshot: { [`twoGiants/${funcName}`]: { status: 'Building' } },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: Building')).toBeInTheDocument();
        expect(screen.getByLabelText('Workflow run in progress')).toBeInTheDocument();
        expect(screen.queryByText('Info: NotDeployed')).not.toBeInTheDocument();
      });

      it('keeps Running with a build-in-progress indicator when the cluster is Running', async () => {
        // Non-destructive: a serving function keeps its green Running status while a
        // new revision builds; the build is surfaced only as a secondary spinner.
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));
        receiveWorkflowRunEventsStub({
          snapshot: { [`twoGiants/${funcName}`]: { status: 'Building' } },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Success: Running')).toBeInTheDocument();
        expect(screen.getByLabelText('Workflow run in progress')).toBeInTheDocument();
      });

      it('keeps Running with a build-failed indicator when the cluster is Running', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));
        receiveWorkflowRunEventsStub({
          snapshot: {
            [`twoGiants/${funcName}`]: {
              status: 'Failed',
              url: 'https://github.com/twoGiants/my-func/actions/runs/1',
            },
          },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Success: Running')).toBeInTheDocument();
        expect(screen.queryByText('Error: BuildFailed')).not.toBeInTheDocument();
        // The failed rebuild is surfaced as a secondary indicator linking to the run.
        expect(
          await screen.findByRole('link', { name: 'Latest workflow run failed' }),
        ).toHaveAttribute('href', 'https://github.com/twoGiants/my-func/actions/runs/1');
      });

      it('keeps ScaledToZero with a workflow-run-in-progress indicator when the cluster is scaled to zero', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'True')],
          deps: [sdkTestDoubles.deploymentFixture(funcName, 0, 0)],
        });
        receiveWorkflowRunEventsStub({
          snapshot: { [`twoGiants/${funcName}`]: { status: 'Building' } },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: ScaledToZero')).toBeInTheDocument();
        expect(screen.getByLabelText('Workflow run in progress')).toBeInTheDocument();
      });

      it('keeps ScaledToZero with a build-failed indicator when the cluster is scaled to zero', async () => {
        // A scaled-to-zero function is deployed and available (idle, cold-starts on
        // demand), so a failed rebuild must not overwrite it with BuildFailed.
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'True')],
          deps: [sdkTestDoubles.deploymentFixture(funcName, 0, 0)],
        });
        receiveWorkflowRunEventsStub({
          snapshot: {
            [`twoGiants/${funcName}`]: {
              status: 'Failed',
              url: 'https://github.com/twoGiants/my-func/actions/runs/1',
            },
          },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: ScaledToZero')).toBeInTheDocument();
        expect(screen.queryByText('Error: BuildFailed')).not.toBeInTheDocument();
        expect(
          await screen.findByRole('link', { name: 'Latest workflow run failed' }),
        ).toHaveAttribute('href', 'https://github.com/twoGiants/my-func/actions/runs/1');
      });

      it('keeps Deploying with a build-in-progress indicator while a new revision rolls out', async () => {
        // A live function reports Deploying for a moment when the build applies a new
        // revision. Overwriting that with Building flickered the row through a status
        // it had already passed on every redeploy.
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({ knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'True')] });
        receiveWorkflowRunEventsStub({
          snapshot: { [`twoGiants/${funcName}`]: { status: 'Building' } },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Info: Deploying')).toBeInTheDocument();
        expect(screen.getByLabelText('Workflow run in progress')).toBeInTheDocument();
      });

      it('keeps a cluster Error with a build-failed indicator when the Latest workflow run failed', async () => {
        // Ready=False means a deployed revision is broken, which matters more than
        // the failed rebuild, so the build drops to a secondary indicator.
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures({
          knSvcs: [sdkTestDoubles.ksvcFixture(funcName, 'False')],
          deps: [sdkTestDoubles.deploymentFixture(funcName, 1, 0)],
        });
        receiveWorkflowRunEventsStub({
          snapshot: {
            [`twoGiants/${funcName}`]: {
              status: 'Failed',
              url: 'https://github.com/twoGiants/my-func/actions/runs/1',
            },
          },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Error: Error')).toBeInTheDocument();
        expect(screen.queryByText('Error: BuildFailed')).not.toBeInTheDocument();
        expect(
          await screen.findByRole('link', { name: 'Latest workflow run failed' }),
        ).toHaveAttribute('href', 'https://github.com/twoGiants/my-func/actions/runs/1');
      });

      it('shows BuildFailed for a repo-level error with no cluster resource', async () => {
        listFunctionsStub({
          responses: [
            { ...functionMetadata({ repoName: funcName }), err: 'cannot read func.yaml' },
          ],
        });
        receiveWorkflowRunEventsStub({
          snapshot: {
            [`twoGiants/${funcName}`]: {
              status: 'Failed',
              url: 'https://github.com/twoGiants/my-func/actions/runs/1',
            },
          },
        });

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

      it('shows BuildFailed with a run link from the build stream', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        receiveWorkflowRunEventsStub({
          snapshot: {
            [`twoGiants/${funcName}`]: {
              status: 'Failed',
              url: 'https://github.com/twoGiants/my-func/actions/runs/1',
            },
          },
        });

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

      it('displays build watcher error alert with message when stream fails', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: 'my-repo' })] });
        receiveWorkflowRunEventsStub({
          errorResponse: { message: 'Service Unavailable', status: 503 },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        await waitFor(() => {
          expect(screen.getByText('Error')).toBeInTheDocument();
          expect(screen.getByText('Server error (503)')).toBeInTheDocument();
        });
      });

      it('clears build watcher error alert when stream recovers', async () => {
        using timer = timerFake();
        listFunctionsStub({ responses: [functionMetadata({ repoName: 'my-repo' })] });
        // Initial endpoint response is an error
        receiveWorkflowRunEventsStub({
          errorResponse: { message: 'Service Unavailable', status: 503 },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        // Verify error alert is displayed
        await waitFor(() => {
          expect(screen.getByText('Error')).toBeInTheDocument();
          expect(screen.getByText('Server error (503)')).toBeInTheDocument();
        });

        // Update MSW to return successful stream (reconnection will retry after 3000ms)
        receiveWorkflowRunEventsStub({
          snapshot: { 'twoGiants/my-repo': { status: 'Succeeded' } },
        });

        // Advance past reconnect delay (3000ms)
        await act(() => timer.advance(3500));

        // Error should clear after reconnection
        await waitFor(
          () => {
            expect(screen.queryByText('Server error (503)')).not.toBeInTheDocument();
          },
          { timeout: 500 },
        );
      });

      it('transitions build status from NotDeployed -> Building -> Succeeded', async () => {
        using stream = new AsyncQueue<WorkflowRunStreamEvent>();
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        receiveWorkflowRunEventsStub({ stream });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        // Initial state: NotDeployed with no build activity
        expect(await screen.findByText('Info: NotDeployed')).toBeInTheDocument();
        expect(screen.queryByLabelText('Workflow run in progress')).not.toBeInTheDocument();

        // Emit Building status
        stream.enqueue({
          type: 'build-status',
          runs: { [`twoGiants/${funcName}`]: { status: 'Building' } },
        });

        // Should show building indicator as primary, replaces NotDeployed
        await waitFor(() => {
          expect(screen.getByText('Info: Building')).toBeInTheDocument();
          expect(screen.getByLabelText('Workflow run in progress')).toBeInTheDocument();
          expect(screen.queryByText('Info: NotDeployed')).not.toBeInTheDocument();
        });

        // Emit Succeeded status
        stream.enqueue({
          type: 'build-status',
          runs: { [`twoGiants/${funcName}`]: { status: 'Succeeded' } },
        });

        // Succeeded on NotDeployed shows Deploying (build done, waiting for cluster)
        await waitFor(() => {
          expect(screen.queryByLabelText('Workflow run in progress')).not.toBeInTheDocument();
          expect(screen.getByText('Info: Deploying')).toBeInTheDocument();
        });
      });

      it('updates multiple functions with different status transitions', async () => {
        using stream = new AsyncQueue<WorkflowRunStreamEvent>();
        const func1 = 'func-alpha';
        const func2 = 'func-beta';
        listFunctionsStub({
          responses: [
            functionMetadata({ repoName: 'repo-alpha', name: func1 }),
            functionMetadata({ repoName: 'repo-beta', name: func2 }),
          ],
        });
        receiveWorkflowRunEventsStub({ stream });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        // Both functions render initially
        expect(await screen.findByText(func1)).toBeInTheDocument();
        expect(screen.getByText(func2)).toBeInTheDocument();

        // Snapshot: func-alpha Building
        stream.enqueue({
          type: 'build-status',
          runs: { [`twoGiants/repo-alpha`]: { status: 'Building' } },
        });
        await waitFor(() => {
          const row1 = screen.getByText(func1).closest('tr');
          const row2 = screen.getByText(func2).closest('tr');
          expect(
            row1?.querySelector('[aria-label="Workflow run in progress"]'),
          ).toBeInTheDocument();
          expect(
            row2?.querySelector('[aria-label="Workflow run in progress"]'),
          ).not.toBeInTheDocument();
        });

        // Snapshot: func-alpha Succeeded, func-beta Building
        stream.enqueue({
          type: 'build-status',
          runs: {
            [`twoGiants/repo-alpha`]: { status: 'Succeeded' },
            [`twoGiants/repo-beta`]: { status: 'Building' },
          },
        });
        await waitFor(() => {
          const row1 = screen.getByText(func1).closest('tr');
          const row2 = screen.getByText(func2).closest('tr');
          expect(
            row1?.querySelector('[aria-label="Workflow run in progress"]'),
          ).not.toBeInTheDocument();
          expect(
            row2?.querySelector('[aria-label="Workflow run in progress"]'),
          ).toBeInTheDocument();
        });

        // Snapshot: both Succeeded
        stream.enqueue({
          type: 'build-status',
          runs: {
            [`twoGiants/repo-alpha`]: { status: 'Succeeded' },
            [`twoGiants/repo-beta`]: { status: 'Succeeded' },
          },
        });
        await waitFor(() => {
          const row1 = screen.getByText(func1).closest('tr');
          const row2 = screen.getByText(func2).closest('tr');
          expect(
            row1?.querySelector('[aria-label="Workflow run in progress"]'),
          ).not.toBeInTheDocument();
          expect(
            row2?.querySelector('[aria-label="Workflow run in progress"]'),
          ).not.toBeInTheDocument();
        });
      });

      it('preserves functions while workflow error is present', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));
        receiveWorkflowRunEventsStub({
          errorResponse: { message: 'Service Unavailable', status: 503 },
        });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText('Success: Running')).toBeInTheDocument();
        expect(screen.getByText(/Server error/)).toBeInTheDocument();
      });

      it('preserves workflow status across stream reconnect (no flicker)', async () => {
        using stream = new AsyncQueue<WorkflowRunStreamEvent>();
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        receiveWorkflowRunEventsStub({ stream });

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();

        stream.enqueue({
          type: 'build-status',
          runs: { [`twoGiants/${funcName}`]: { status: 'Building' } },
        });
        await waitFor(() => {
          expect(screen.getByLabelText('Workflow run in progress')).toBeInTheDocument();
        });

        // Auth error closes the stream
        stream.enqueue({ type: 'app-error', message: 'auth expired', code: 401 });
        await waitFor(() => expect(screen.getByText(/Authentication expired/)).toBeInTheDocument());

        // Building indicator should still be visible (not cleared on error)
        expect(screen.getByLabelText('Workflow run in progress')).toBeInTheDocument();
      });

      it('shows the delete button as enabled when ksvc exists', async () => {
        listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });
        sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture(funcName));

        render(
          <MemoryRouter>
            <FunctionsListPage />
          </MemoryRouter>,
        );

        expect(await screen.findByText(funcName)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
      });
    });
  });

  describe('Refresh button behaviour', () => {
    it('re-fetch updates list after refresh if a repo was deleted', async () => {
      const salesFuncRepoItem = functionMetadata({
        repoName: 'sales-aggregator',
        name: 'sales-aggregator',
        namespace: 'demo',
        runtime: 'go',
      });
      const transcribeFuncRepoItem = functionMetadata({
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
      listFunctionsStub({ responses: [functionMetadata({ repoName: funcName })] });

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
        responses: [functionMetadata({ repoName: 'fn-a' })],
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
        responses: [functionMetadata({ repoName: 'fn-a' })],
        wait: new Promise<void>((r) => {
          continueWithRequest = r;
        }),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Refresh' });
        expect(btn.querySelector('[role="progressbar"]')).toBeInTheDocument();
      });

      continueWithRequest();
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Refresh' });
        expect(btn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
      });
    });

    it('keeps the table visible during refresh instead of showing the page spinner', async () => {
      listFunctionsStub({ responses: [functionMetadata({ repoName: 'fn-a' })] });

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText('fn-a')).toBeInTheDocument();

      let continueWithRequest = () => {};
      listFunctionsStub({
        responses: [functionMetadata({ repoName: 'fn-a' })],
        wait: new Promise<void>((r) => {
          continueWithRequest = r;
        }),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => {
        // Table row stays visible during refresh
        expect(screen.getByText('fn-a')).toBeInTheDocument();
        // Page spinner does not appear
        expect(screen.queryByRole('progressbar', { name: 'Loading' })).not.toBeInTheDocument();
      });

      continueWithRequest();
    });

    it('shows the button spinner on a second refresh after the first one completed', async () => {
      listFunctionsStub({ responses: [functionMetadata({ repoName: 'fn-a' })] });

      render(
        <MemoryRouter>
          <FunctionsListPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText('fn-a')).toBeInTheDocument();

      // First refresh: completes immediately
      listFunctionsStub({ responses: [functionMetadata({ repoName: 'fn-a' })] });
      await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Refresh' });
        expect(btn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
      });

      // Second refresh: blocked
      let continueWithRequest = () => {};
      listFunctionsStub({
        responses: [functionMetadata({ repoName: 'fn-a' })],
        wait: new Promise<void>((r) => {
          continueWithRequest = r;
        }),
      });

      await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Refresh' });
        expect(btn.querySelector('[role="progressbar"]')).toBeInTheDocument();
      });

      continueWithRequest();
      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Refresh' });
        expect(btn.querySelector('[role="progressbar"]')).not.toBeInTheDocument();
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
          clusterFunctionMetadata(salesFuncName, devNamespace),
          clusterFunctionMetadata(transcriberFuncName, prodNamespace),
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
        responses: [clusterFunctionMetadata(transcriberFuncName, prodNamespace)],
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
// Testing framework -----------------------------------------------------------
// -----------------------------------------------------------------------------

// Test data factories ---------------------------------------------------------
function clusterFunctionMetadata(
  name: string,
  namespace = 'demo',
  runtime = 'node',
): FunctionMetadata {
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
