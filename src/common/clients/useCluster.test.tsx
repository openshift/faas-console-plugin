import { renderHook } from '@testing-library/react';
import {
  configMapFixture,
  deploymentFixture,
  funcFixture,
  ksvcFixture,
  secretFixture,
  setFixtures,
  useK8sWatchResourceStub,
} from '../testing/useK8sWatchResourceStub';
import { FUNCTION_NAME_LABEL } from '../types';
import { useCluster } from './useCluster';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  useK8sWatchResource: useK8sWatchResourceStub,
}));

describe('useCluster', () => {
  const namespace = 'demo';
  const funcName = 'my-func';

  afterEach(() => {
    setFixtures({});
  });

  describe('loading', () => {
    it('reports not loaded while watches are pending', () => {
      setFixtures({ knLoaded: false, depLoaded: false });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.loaded).toBe(false);
      expect(result.current.functions.size).toBe(0);
    });

    it('reports loaded when all watches complete', () => {
      const { result } = renderHook(() => useCluster([funcName], namespace));

      expect(result.current.loaded).toBe(true);
      expect(result.current.functions.size).toBe(0);
    });

    it('reports not loaded when secret watch is pending', () => {
      setFixtures({ secretLoaded: false });

      const { result } = renderHook(() => useCluster([funcName], namespace));

      expect(result.current.loaded).toBe(false);
    });

    it('reports not loaded when configmap watch is pending', () => {
      setFixtures({ cmLoaded: false });

      const { result } = renderHook(() => useCluster([funcName], namespace));

      expect(result.current.loaded).toBe(false);
    });
  });

  describe('error', () => {
    it('surfaces knative service watch error', () => {
      const errMsg = 'ksvc watch failed';
      setFixtures({ knError: new Error(errMsg) });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.error.message).toBe(errMsg);
    });

    it('surfaces deployment watch error', () => {
      const errMsg = 'deployment watch failed';
      setFixtures({ depError: new Error(errMsg) });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.error.message).toBe(errMsg);
    });

    it('surfaces secret watch error', () => {
      const errMsg = 'secret watch failed';
      setFixtures({ secretError: new Error(errMsg) });

      const { result } = renderHook(() => useCluster([funcName], namespace));

      expect(result.current.error.message).toBe(errMsg);
    });

    it('surfaces configmap watch error', () => {
      const errMsg = 'cm watch failed';
      setFixtures({ cmError: new Error(errMsg) });

      const { result } = renderHook(() => useCluster([funcName], namespace));

      expect(result.current.error.message).toBe(errMsg);
    });

    it('reports no error when watches succeed', () => {
      setFixtures(funcFixture(funcName));

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.error).toBeNull();
    });
  });

  describe('pairing', () => {
    it('pairs ksvc with deployment by revision label', () => {
      setFixtures(funcFixture(funcName));

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.size).toBe(1);
      expect(result.current.functions.get(`${namespace}/${funcName}`)?.status).toBe('Running');
    });

    it('falls back to function name label when no latestReadyRevisionName', () => {
      const func = funcFixture(funcName);
      func.knSvcs![0].status!.latestReadyRevisionName = undefined;
      func.deps![0].metadata!.labels = { [FUNCTION_NAME_LABEL]: funcName };
      setFixtures(func);

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.size).toBe(1);
      expect(result.current.functions.get(`${namespace}/${funcName}`)?.status).toBe('Running');
    });

    it('picks latest revision deployment when multiple revisions exist', () => {
      const ksvcV2 = ksvcFixture(funcName, 'True');
      ksvcV2.status!.latestReadyRevisionName = 'my-func-00002';

      setFixtures({
        knSvcs: [ksvcV2],
        deps: [
          deploymentFixture(funcName, 0, 0, 'my-func-00001'),
          deploymentFixture(funcName, 1, 1, 'my-func-00002'),
        ],
      });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.size).toBe(1);
      expect(result.current.functions.get(`${namespace}/${funcName}`)?.replicas).toBe(1);
    });

    it('returns empty map when no ksvc resources', () => {
      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.size).toBe(0);
    });

    it('handles multiple functions independently', () => {
      const funcAName = 'func-a';
      const funcBName = 'func-b';
      setFixtures({
        knSvcs: [ksvcFixture(funcAName, 'True'), ksvcFixture(funcBName, 'False')],
        deps: [deploymentFixture(funcAName, 1, 1), deploymentFixture(funcBName, 0, 0)],
      });

      const { result } = renderHook(() => useCluster([funcAName, funcBName]));

      expect(result.current.functions.size).toBe(2);

      const funcA = result.current.functions.get(`${namespace}/${funcAName}`);
      expect(funcA?.status).toBe('Running');
      expect(funcA?.replicas).toBe(1);

      const funcB = result.current.functions.get(`${namespace}/${funcBName}`);
      expect(funcB?.status).toBe('Error');
      expect(funcB?.replicas).toBe(0);
    });

    it('does not match deployments from a different namespace', () => {
      const nsA = 'ns-a';
      const nsB = 'ns-b';
      const sharedRevision = 'shared-func-00001';

      const ksvcA = ksvcFixture('shared-func', 'True');
      ksvcA.metadata!.namespace = nsA;
      ksvcA.status!.latestReadyRevisionName = sharedRevision;

      const ksvcB = ksvcFixture('shared-func', 'True');
      ksvcB.metadata!.namespace = nsB;
      ksvcB.status!.latestReadyRevisionName = sharedRevision;

      // Only ns-b has a deployment for the shared revision
      const depB = deploymentFixture('shared-func', 1, 1, sharedRevision);
      depB.metadata!.namespace = nsB;

      setFixtures({ knSvcs: [ksvcA, ksvcB], deps: [depB] });

      const { result } = renderHook(() => useCluster(['shared-func']));

      // ns-a function has no deployment in its namespace → Deploying
      expect(result.current.functions.get(`${nsA}/shared-func`)?.status).toBe('Deploying');
      // ns-b function correctly pairs with its deployment → Running
      expect(result.current.functions.get(`${nsB}/shared-func`)?.status).toBe('Running');
    });
  });

  describe('name', () => {
    it('uses function.knative.dev/name label', () => {
      setFixtures({ knSvcs: [ksvcFixture(funcName, 'True')] });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.name).toBe(funcName);
    });
  });

  describe('status', () => {
    it('returns Deploying when deployment is undefined', () => {
      setFixtures({ knSvcs: [ksvcFixture(funcName, 'True')] });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.status).toBe('Deploying');
    });

    it('returns Running when Ready=True and replicas > 0', () => {
      setFixtures(funcFixture(funcName));

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.status).toBe('Running');
    });

    it('returns ScaledToZero when Ready=True and replicas are 0', () => {
      setFixtures({
        knSvcs: [ksvcFixture(funcName, 'True')],
        deps: [deploymentFixture(funcName, 0, 0)],
      });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.status).toBe('ScaledToZero');
    });

    it('returns Error when Ready=False', () => {
      setFixtures({
        knSvcs: [ksvcFixture(funcName, 'False')],
        deps: [deploymentFixture(funcName, 0, 0)],
      });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.status).toBe('Error');
    });

    it('returns Deploying when Ready=Unknown', () => {
      setFixtures({
        knSvcs: [ksvcFixture(funcName, 'Unknown')],
        deps: [deploymentFixture(funcName, 1, 0)],
      });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.status).toBe('Deploying');
    });

    it('returns Deploying when no Ready condition exists', () => {
      const func = funcFixture(funcName);
      func.knSvcs![0].status!.conditions[0].type = 'ConfigurationsReady';
      setFixtures(func);

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.status).toBe('Deploying');
    });
  });

  describe('url', () => {
    it('returns ksvc status url', () => {
      setFixtures(funcFixture(funcName));

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.url).toBe(
        'https://my-func-demo.apps.example.com',
      );
    });

    it('returns empty url when ksvc has no status url', () => {
      const ksvc = ksvcFixture(funcName, 'True');
      ksvc.status = {};
      setFixtures({ knSvcs: [ksvc] });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.url).toBe('');
    });
  });

  describe('replicas', () => {
    it('returns readyReplicas from deployment', () => {
      setFixtures({
        knSvcs: [ksvcFixture(funcName, 'True')],
        deps: [deploymentFixture(funcName, 2, 2)],
      });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.replicas).toBe(2);
    });

    it('returns 0 when deployment is undefined', () => {
      setFixtures({ knSvcs: [ksvcFixture(funcName, 'True')] });

      const { result } = renderHook(() => useCluster([funcName]));

      expect(result.current.functions.get(`${namespace}/${funcName}`)?.replicas).toBe(0);
    });
  });

  describe('mainResource', () => {
    it('returns the knative service', () => {
      setFixtures(funcFixture(funcName));

      const { result } = renderHook(() => useCluster([funcName]));

      expect(
        result.current.functions.get(`${namespace}/${funcName}`)?.mainResource.apiVersion,
      ).toBe('serving.knative.dev/v1');
    });
  });

  describe('secrets', () => {
    const dbCreds = 'db-creds';
    const secretData = { username: 'dXNlcg==', password: 'cGFzcw==' };
    it('watches Secrets in the given namespace', () => {
      const apiKey = 'api-key';
      setFixtures({
        secrets: [secretFixture(dbCreds, secretData), secretFixture(apiKey, { key: 'c2VjcmV0' })],
      });

      const { result } = renderHook(() => useCluster([], namespace));

      const secrets = result.current.secrets;
      expect(secrets[0].name).toBe(dbCreds);
      expect(secrets[1].name).toBe(apiKey);
    });

    it('returns data keys for secrets', () => {
      setFixtures({
        secrets: [secretFixture(dbCreds, secretData)],
      });

      const { result } = renderHook(() => useCluster([], namespace));

      const secretKeys = result.current.secrets[0].keys;
      expect(secretKeys[0]).toBe('username');
      expect(secretKeys[1]).toBe('password');
    });

    it('returns empty when no namespace provided', () => {
      const { result } = renderHook(() => useCluster([]));

      expect(result.current.secrets.length).toBe(0);
    });
  });

  describe('configMaps', () => {
    const appConfig = 'app-config';
    const configData = { 'log-level': 'info', region: 'us-east-1' };
    it('watches ConfigMaps in the given namespace', () => {
      setFixtures({
        configMaps: [configMapFixture(appConfig, configData)],
      });

      const { result } = renderHook(() => useCluster([], namespace));

      expect(result.current.configMaps[0].name).toBe(appConfig);
    });

    it('returns data keys for configmaps', () => {
      setFixtures({
        configMaps: [configMapFixture(appConfig, configData)],
      });

      const { result } = renderHook(() => useCluster([], namespace));

      const configMapKeys = result.current.configMaps[0].keys;
      expect(configMapKeys[0]).toBe('log-level');
      expect(configMapKeys[1]).toBe('region');
    });

    it('returns empty when no namespace provided', () => {
      const { result } = renderHook(() => useCluster([]));

      expect(result.current.configMaps.length).toBe(0);
    });
  });
});
