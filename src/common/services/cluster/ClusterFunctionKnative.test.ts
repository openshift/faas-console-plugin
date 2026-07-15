import { listKnativeClusterFunctions } from './ClusterFunctionKnative';

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

describe('listKnativeClusterFunctions', () => {
  describe('pairing', () => {
    it('pairs ksvc with deployment by revision label', () => {
      const result = listKnativeClusterFunctions(
        [ksvcFixture('my-func', 'True')],
        [deploymentFixture('my-func', 1, 1)],
      );

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('my-func');
      expect(result[0].status).toBe('Running');
    });

    it('falls back to function name label when no latestReadyRevisionName', () => {
      const ksvcNoRevision = {
        ...ksvcFixture('my-func', 'True'),
        status: {
          url: 'https://my-func-demo.apps.example.com',
          latestReadyRevisionName: undefined,
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      };
      const depByName = {
        ...deploymentFixture('my-func', 1, 1),
        metadata: {
          ...deploymentFixture('my-func', 1, 1).metadata,
          labels: { 'function.knative.dev/name': 'my-func' },
        },
      };

      const result = listKnativeClusterFunctions([ksvcNoRevision], [depByName]);

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('Running');
    });

    it('picks latest revision deployment when multiple revisions exist', () => {
      const ksvcV2 = {
        ...ksvcFixture('my-func', 'True'),
        status: {
          ...ksvcFixture('my-func', 'True').status,
          latestReadyRevisionName: 'my-func-00002',
        },
      };
      const depV1 = deploymentFixture('my-func', 0, 0, 'my-func-00001');
      const depV2 = deploymentFixture('my-func', 1, 1, 'my-func-00002');

      const result = listKnativeClusterFunctions([ksvcV2], [depV1, depV2]);

      expect(result).toHaveLength(1);
      expect(result[0].replicas).toBe(1);
    });

    it('returns empty array when no ksvc resources', () => {
      expect(listKnativeClusterFunctions([], [])).toHaveLength(0);
    });
  });

  describe('name', () => {
    it('uses function.knative.dev/name label', () => {
      const [cf] = listKnativeClusterFunctions([ksvcFixture('my-func', 'True')], []);
      expect(cf.name).toBe('my-func');
    });

    it('falls back to metadata.name when label is missing', () => {
      const ksvc = { metadata: { name: 'fallback-name' } };
      const [cf] = listKnativeClusterFunctions([ksvc], []);
      expect(cf.name).toBe('fallback-name');
    });
  });

  describe('status', () => {
    it('returns Deploying when deployment is undefined', () => {
      const [cf] = listKnativeClusterFunctions([ksvcFixture('my-func', 'True')], []);
      expect(cf.status).toBe('Deploying');
    });

    it('returns Running when Ready=True and replicas > 0', () => {
      const [cf] = listKnativeClusterFunctions(
        [ksvcFixture('my-func', 'True')],
        [deploymentFixture('my-func', 1, 1)],
      );
      expect(cf.status).toBe('Running');
    });

    it('returns ScaledToZero when Ready=True and replicas are 0', () => {
      const [cf] = listKnativeClusterFunctions(
        [ksvcFixture('my-func', 'True')],
        [deploymentFixture('my-func', 0, 0)],
      );
      expect(cf.status).toBe('ScaledToZero');
    });

    it('returns Error when Ready=False', () => {
      const [cf] = listKnativeClusterFunctions(
        [ksvcFixture('my-func', 'False')],
        [deploymentFixture('my-func', 0, 0)],
      );
      expect(cf.status).toBe('Error');
    });

    it('returns Deploying when Ready=Unknown', () => {
      const [cf] = listKnativeClusterFunctions(
        [ksvcFixture('my-func', 'Unknown')],
        [deploymentFixture('my-func', 1, 0)],
      );
      expect(cf.status).toBe('Deploying');
    });

    it('returns Deploying when no Ready condition exists', () => {
      const ksvc = {
        metadata: { name: 'my-func', labels: { 'function.knative.dev/name': 'my-func' } },
        status: { conditions: [{ type: 'ConfigurationsReady', status: 'True' }] },
      };
      const [cf] = listKnativeClusterFunctions([ksvc], [deploymentFixture('my-func', 1, 0)]);
      expect(cf.status).toBe('Deploying');
    });
  });

  describe('url', () => {
    it('returns ksvc status url', () => {
      const [cf] = listKnativeClusterFunctions(
        [ksvcFixture('my-func', 'True')],
        [deploymentFixture('my-func', 1, 1)],
      );
      expect(cf.url).toBe('https://my-func-demo.apps.example.com');
    });

    it('returns undefined when ksvc has no status url', () => {
      const ksvc = { metadata: { name: 'my-func' }, status: {} };
      const [cf] = listKnativeClusterFunctions([ksvc], []);
      expect(cf.url).toBeUndefined();
    });
  });

  describe('replicas', () => {
    it('returns readyReplicas from deployment', () => {
      const [cf] = listKnativeClusterFunctions(
        [ksvcFixture('my-func', 'True')],
        [deploymentFixture('my-func', 2, 2)],
      );
      expect(cf.replicas).toBe(2);
    });

    it('returns 0 when deployment is undefined', () => {
      const [cf] = listKnativeClusterFunctions([ksvcFixture('my-func', 'True')], []);
      expect(cf.replicas).toBe(0);
    });
  });

  describe('mainResource', () => {
    it('returns the knative service', () => {
      const ksvc = ksvcFixture('my-func', 'True');
      const [cf] = listKnativeClusterFunctions([ksvc], []);
      expect(cf.mainResource).toBe(ksvc);
    });
  });
});
