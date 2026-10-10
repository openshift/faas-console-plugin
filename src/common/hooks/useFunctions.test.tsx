import { renderHook, waitFor } from '@testing-library/react';
import { listFunctionsStub } from '../testing/functionsClientStub';
import { server } from '../testing/mswServer';
import { repoListItem } from '../testing/testData';
import { FUNCTION_NAME_LABEL } from '../types';
import { useFunctions } from './useFunctions';

// vi.mock is hoisted above imports, so regular imports aren't available in the factory.
// vi.hoisted runs before vi.mock, making the sdkTestDoubles available to the factory.
// https://vitest.dev/api/vi.html#vi-hoisted
const sdkTestDoubles = await vi.hoisted(async () => import('../../common/testing/sdkTestDoubles'));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: sdkTestDoubles.consoleFetchFake,
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONFake,
  useK8sWatchResource: sdkTestDoubles.useK8sWatchResourceStub,
  isAllNamespacesKey: sdkTestDoubles.isAllNamespaceKeyFake,
}));

describe('useFunctions', () => {
  const namespace = 'demo';

  afterEach(() => {
    sdkTestDoubles.reset();
    server.resetHandlers();
  });

  describe('Function[] after fetching metadata (source 1)', () => {
    it('builds initial Function[] from function metadata list', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: 'my-func' })] });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.functions).toHaveLength(1);

      const fn = result.current.functions[0];
      expect(fn.name).toBe('my-func');
      expect(fn.namespace).toBe(namespace);
      expect(fn.status.cluster.status).toBe('NotDeployed');
      expect(fn.status.workflow.status).toBe('None');
      expect(fn.routeURL).toBeFalsy();
      expect(fn.replicas).toBeUndefined();
      expect(fn.mainResource).toBeUndefined();
    });

    it('builds multiple functions from function metadata list', async () => {
      listFunctionsStub({
        responses: [
          repoListItem({ repoName: 'func-a', name: 'func-a', namespace, runtime: 'node' }),
          repoListItem({ repoName: 'func-b', name: 'func-b', namespace, runtime: 'go' }),
        ],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.functions).toHaveLength(2);
      expect(result.current.functions[0].name).toBe('func-a');
      expect(result.current.functions[1].name).toBe('func-b');
    });

    it('reports loaded when list fetch completes', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: 'my-func' })] });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.functions).toHaveLength(1);
    });

    it('reports loaded with empty functions when connectionId is undefined', () => {
      const { result } = renderHook(() => useFunctions(namespace, undefined));

      expect(result.current.loaded).toBe(true);
      expect(result.current.functions).toHaveLength(0);
    });

    it('surfaces list fetch error', async () => {
      listFunctionsStub({
        errorResponse: { message: 'server error', status: 500 },
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.errors).toHaveLength(1);
      expect(result.current.errors![0]).toContain('server error');
    });

    it('returns empty errors when list fetch succeeds', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: 'my-func' })] });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.errors).toHaveLength(0);
    });

    it('resets functions when namespace changes', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: 'my-func' })] });

      const { result, rerender } = renderHook(({ ns, connId }) => useFunctions(ns, connId), {
        initialProps: { ns: namespace, connId: 0 },
      });

      await waitFor(() => expect(result.current.functions).toHaveLength(1));

      listFunctionsStub({
        responses: [
          repoListItem({ repoName: 'other-func', name: 'other-func', namespace: 'prod' }),
        ],
      });
      rerender({ ns: 'prod', connId: 0 });

      await waitFor(() => {
        expect(result.current.functions).toHaveLength(1);
        expect(result.current.functions[0].name).toBe('other-func');
      });
    });

    it('resets functions when connectionId changes', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: 'my-func' })] });

      const { result, rerender } = renderHook(({ ns, connId }) => useFunctions(ns, connId), {
        initialProps: { ns: namespace, connId: 0 },
      });

      await waitFor(() => expect(result.current.functions).toHaveLength(1));

      listFunctionsStub({ responses: [] });
      rerender({ ns: namespace, connId: 1 });

      await waitFor(() => expect(result.current.functions).toHaveLength(0));
    });

    it('does not fetch when connectionId is undefined', () => {
      const { result } = renderHook(() => useFunctions(namespace, undefined));

      expect(result.current.loaded).toBe(true);
      expect(result.current.functions).toHaveLength(0);
      expect(result.current.errors).toHaveLength(0);
    });

    it('re-fetches functions when refreshKey changes', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: 'my-func' })] });

      const { result, rerender } = renderHook(
        ({ ns, connId, refresh }) => useFunctions(ns, connId, refresh),
        { initialProps: { ns: namespace, connId: 0, refresh: 0 } },
      );

      await waitFor(() => expect(result.current.functions).toHaveLength(1));

      listFunctionsStub({
        responses: [repoListItem({ repoName: 'my-func' }), repoListItem({ repoName: 'new-func' })],
      });
      rerender({ ns: namespace, connId: 0, refresh: 1 });

      await waitFor(() => expect(result.current.functions).toHaveLength(2));
      expect(result.current.functions[1].name).toBe('new-func');
    });

    it('does not reset state when refreshKey changes', async () => {
      listFunctionsStub({ responses: [repoListItem({ repoName: 'my-func' })] });

      const { result, rerender } = renderHook(
        ({ ns, connId, refresh }) => useFunctions(ns, connId, refresh),
        { initialProps: { ns: namespace, connId: 0, refresh: 0 } },
      );

      await waitFor(() => expect(result.current.functions).toHaveLength(1));

      let continueWithRequest = () => {};
      listFunctionsStub({
        responses: [repoListItem({ repoName: 'my-func' }), repoListItem({ repoName: 'new-func' })],
        wait: new Promise<void>((r) => {
          continueWithRequest = r;
        }),
      });

      rerender({ ns: namespace, connId: 0, refresh: 1 });

      // Functions should still be visible while re-fetch is in flight (no reset to empty)
      expect(result.current.functions).toHaveLength(1);

      continueWithRequest();
      await waitFor(() => expect(result.current.functions).toHaveLength(2));
    });
  });

  describe('cluster status derivation (source 2)', () => {
    it('Deploying when deployment is undefined', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures({
        knSvcs: [sdkTestDoubles.ksvcFixture('my-func', 'True')],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].status.cluster.status).toBe('Deploying');
    });

    it('Running when Ready=True and replicas > 0', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('my-func'));

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].status.cluster.status).toBe('Running');
    });

    it('ScaledToZero when Ready=True and replicas are 0', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures({
        knSvcs: [sdkTestDoubles.ksvcFixture('my-func', 'True')],
        deps: [sdkTestDoubles.deploymentFixture('my-func', 0, 0)],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].status.cluster.status).toBe('ScaledToZero');
    });

    it('Error when Ready=False', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures({
        knSvcs: [sdkTestDoubles.ksvcFixture('my-func', 'False')],
        deps: [sdkTestDoubles.deploymentFixture('my-func', 0, 0)],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].status.cluster.status).toBe('Error');
      expect(result.current.functions[0].status.cluster.errorMessage).toBeDefined();
    });

    it('Deploying when Ready=Unknown', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures({
        knSvcs: [sdkTestDoubles.ksvcFixture('my-func', 'Unknown')],
        deps: [sdkTestDoubles.deploymentFixture('my-func', 1, 0)],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].status.cluster.status).toBe('Deploying');
    });

    it('Deploying when no Ready condition exists', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      const ksvc = sdkTestDoubles.ksvcFixture('my-func', 'True');
      ksvc.status!.conditions[0].type = 'ConfigurationsReady';
      sdkTestDoubles.setWatchFixtures({
        knSvcs: [ksvc],
        deps: [sdkTestDoubles.deploymentFixture('my-func', 1, 1)],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].status.cluster.status).toBe('Deploying');
    });
  });

  describe('ksvc and deployment pairing (source 2)', () => {
    it('falls back to function name label when no latestReadyRevisionName', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      const fixture = sdkTestDoubles.funcFixture('my-func');
      fixture.knSvcs![0].status!.latestReadyRevisionName = undefined;
      fixture.deps![0].metadata!.labels = { [FUNCTION_NAME_LABEL]: 'my-func' };
      sdkTestDoubles.setWatchFixtures(fixture);

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].status.cluster.status).toBe('Running');
    });

    it('picks latest revision deployment when multiple revisions exist', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      const ksvc = sdkTestDoubles.ksvcFixture('my-func', 'True');
      ksvc.status!.latestReadyRevisionName = 'my-func-00002';
      sdkTestDoubles.setWatchFixtures({
        knSvcs: [ksvc],
        deps: [
          sdkTestDoubles.deploymentFixture('my-func', 0, 0, 'demo', 'my-func-00001'),
          sdkTestDoubles.deploymentFixture('my-func', 1, 1, 'demo', 'my-func-00002'),
        ],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].replicas).toBe(1);
    });

    it('returns NotDeployed when no ksvc resources exist', async () => {
      listFunctionsStub({ responses: [repoListItem()] });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].status.cluster.status).toBe('NotDeployed');
    });

    it('handles multiple functions independently', async () => {
      listFunctionsStub({
        responses: [
          repoListItem({ repoName: 'func-a', name: 'func-a' }),
          repoListItem({ repoName: 'func-b', name: 'func-b' }),
        ],
      });
      sdkTestDoubles.setWatchFixtures({
        knSvcs: [
          sdkTestDoubles.ksvcFixture('func-a', 'True'),
          sdkTestDoubles.ksvcFixture('func-b', 'False'),
        ],
        deps: [
          sdkTestDoubles.deploymentFixture('func-a', 1, 1),
          sdkTestDoubles.deploymentFixture('func-b', 0, 0),
        ],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(2));

      const funcA = result.current.functions.find((f) => f.name === 'func-a');
      expect(funcA?.status.cluster.status).toBe('Running');
      expect(funcA?.replicas).toBe(1);

      const funcB = result.current.functions.find((f) => f.name === 'func-b');
      expect(funcB?.status.cluster.status).toBe('Error');
      expect(funcB?.replicas).toBe(0);
    });

    // The same function deployed to two namespaces. Both ksvc's share the same
    // revision name, but only ns-b has a deployment. Without namespace filtering
    // the code would incorrectly pair ns-a's ksvc with ns-b's deployment
    // (matching revision label, wrong namespace) and show Running for both.
    it('does not match deployments from a different namespace', async () => {
      const nsA = 'ns-a';
      const nsB = 'ns-b';
      listFunctionsStub({
        responses: [
          repoListItem({ repoName: 'shared-func', name: 'shared-func', namespace: nsA }),
          repoListItem({ repoName: 'shared-func', name: 'shared-func', namespace: nsB }),
        ],
      });
      const sharedRevision = 'shared-func-00001';
      const ksvcA = sdkTestDoubles.ksvcFixture('shared-func', 'True', nsA);
      ksvcA.status!.latestReadyRevisionName = sharedRevision;
      const ksvcB = sdkTestDoubles.ksvcFixture('shared-func', 'True', nsB);
      ksvcB.status!.latestReadyRevisionName = sharedRevision;
      const depB = sdkTestDoubles.deploymentFixture('shared-func', 1, 1, nsB, sharedRevision);
      sdkTestDoubles.setWatchFixtures({ knSvcs: [ksvcA, ksvcB], deps: [depB] });

      const { result } = renderHook(() => useFunctions('#ALL_NS#', 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(2));

      const fnA = result.current.functions.find((f) => f.namespace === nsA);
      expect(fnA?.status.cluster.status).toBe('Deploying');

      const fnB = result.current.functions.find((f) => f.namespace === nsB);
      expect(fnB?.status.cluster.status).toBe('Running');
    });
  });

  describe('cluster data on Function (source 2)', () => {
    it('function route is set from  ksvc status url', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('my-func'));

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].routeURL).toBe('https://my-func-demo.apps.example.com');
    });

    it('function route is empty url when ksvc has no status url', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      const ksvc = sdkTestDoubles.ksvcFixture('my-func', 'True');
      ksvc.status = {};
      sdkTestDoubles.setWatchFixtures({ knSvcs: [ksvc] });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].routeURL).toBe('');
    });

    it('function replicase are derived from deployment', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures({
        knSvcs: [sdkTestDoubles.ksvcFixture('my-func', 'True')],
        deps: [sdkTestDoubles.deploymentFixture('my-func', 2, 2)],
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].replicas).toBe(2);
    });

    it('function replicas are undefined when deployment is undefined', async () => {
      listFunctionsStub({ responses: [repoListItem()] });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].replicas).toBeUndefined();
    });

    it('function mainResource is the knative service', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures(sdkTestDoubles.funcFixture('my-func'));

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.functions).toHaveLength(1));
      expect(result.current.functions[0].mainResource?.apiVersion).toBe('serving.knative.dev/v1');
    });
  });

  describe('loading and errors (source 2)', () => {
    it('reports loaded even while watches are pending', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures({ knLoaded: false, depLoaded: false });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.functions).toHaveLength(1);
      expect(result.current.functions[0].status.cluster.status).toBe('NotDeployed');
    });

    it('surfaces watch errors', async () => {
      listFunctionsStub({ responses: [repoListItem()] });
      sdkTestDoubles.setWatchFixtures({
        knError: new Error('ksvc watch failed'),
        depError: new Error('dep watch failed'),
      });

      const { result } = renderHook(() => useFunctions(namespace, 0));

      await waitFor(() => expect(result.current.errors).toHaveLength(2));
      expect(result.current.errors![0]).toBe('ksvc watch failed');
      expect(result.current.errors![1]).toBe('dep watch failed');
    });
  });
});
