import { render, screen, within } from '@testing-library/react';
import { useClusterService } from './useClusterService';

type WatchConfig = {
  groupVersionKind?: { group: string; kind: string };
  selector?: {
    matchExpressions?: { key: string; operator: string; values: string[] }[];
  };
} | null;

const FUNCTION_NAME_LABEL = 'function.knative.dev/name';

const fixtures = vi.hoisted(() => ({
  knSvcs: [] as unknown[],
  deps: [] as unknown[],
  knLoaded: true,
  depLoaded: true,
  knError: null as unknown,
  depError: null as unknown,
}));

function filterBySelector(items: unknown[], config: WatchConfig): unknown[] {
  const expr = config?.selector?.matchExpressions?.find(
    (e) => e.key === FUNCTION_NAME_LABEL && e.operator === 'In',
  );
  if (!expr) return items;
  return items.filter((item) => {
    const labels = (item as { metadata?: { labels?: Record<string, string> } }).metadata?.labels;
    const name = labels?.[FUNCTION_NAME_LABEL];
    return name != null && expr.values.includes(name);
  });
}

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  useK8sWatchResource: (config: WatchConfig) => {
    if (!config) return [[], true, null];
    const { group, kind } = config.groupVersionKind ?? {};
    if (group === 'serving.knative.dev' && kind === 'Service')
      return [filterBySelector(fixtures.knSvcs, config), fixtures.knLoaded, fixtures.knError];
    if (group === 'apps' && kind === 'Deployment')
      return [filterBySelector(fixtures.deps, config), fixtures.depLoaded, fixtures.depError];
    return [[], true, null];
  },
}));

function setFixtures(opts: {
  knSvcs?: unknown[];
  deps?: unknown[];
  knLoaded?: boolean;
  depLoaded?: boolean;
  knError?: unknown;
  depError?: unknown;
}) {
  fixtures.knSvcs = opts.knSvcs ?? [];
  fixtures.deps = opts.deps ?? [];
  fixtures.knLoaded = opts.knLoaded ?? true;
  fixtures.depLoaded = opts.depLoaded ?? true;
  fixtures.knError = opts.knError ?? null;
  fixtures.depError = opts.depError ?? null;
}

function TestConsumer({ functionNames = [] }: { functionNames?: string[] }) {
  const { functions, loaded, error } = useClusterService(functionNames);
  return (
    <>
      <span data-testid="loaded">{String(loaded)}</span>
      <span data-testid="error">{error ? String(error) : ''}</span>
      <span data-testid="fn-count">{functions.size}</span>
      {[...functions.values()].map((fn) => (
        <div key={fn.name} data-testid={fn.name}>
          <span data-testid="name">{fn.name}</span>
          <span data-testid="status">{fn.status}</span>
          <span data-testid="url">{fn.url}</span>
          <span data-testid="replicas">{fn.replicas}</span>
          <span data-testid="has-resource">{String(!!fn.mainResource)}</span>
        </div>
      ))}
    </>
  );
}

function fn(name: string) {
  return within(screen.getByTestId(name));
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

describe('useClusterService', () => {
  afterEach(() => {
    setFixtures({});
  });

  describe('loading', () => {
    it('reports not loaded while watches are pending', () => {
      setFixtures({ knLoaded: false, depLoaded: false });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('loaded')).toHaveTextContent('false');
      expect(screen.getByTestId('fn-count')).toHaveTextContent('0');
    });

    it('reports loaded when both watches complete', () => {
      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('loaded')).toHaveTextContent('true');
      expect(screen.getByTestId('fn-count')).toHaveTextContent('0');
    });
  });

  describe('error', () => {
    it('surfaces knative service watch error', () => {
      setFixtures({ knError: 'ksvc watch failed' });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('error')).toHaveTextContent('ksvc watch failed');
    });

    it('surfaces deployment watch error', () => {
      setFixtures({ depError: 'deployment watch failed' });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('error')).toHaveTextContent('deployment watch failed');
    });

    it('reports no error when watches succeed', () => {
      setFixtures({
        knSvcs: [ksvcFixture('my-func', 'True')],
        deps: [deploymentFixture('my-func', 1, 1)],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('error')).toHaveTextContent('');
    });
  });

  describe('pairing', () => {
    it('pairs ksvc with deployment by revision label', () => {
      setFixtures({
        knSvcs: [ksvcFixture('my-func', 'True')],
        deps: [deploymentFixture('my-func', 1, 1)],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('fn-count')).toHaveTextContent('1');
      expect(fn('my-func').getByTestId('status')).toHaveTextContent('Running');
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

      setFixtures({ knSvcs: [ksvcNoRevision], deps: [depByName] });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('fn-count')).toHaveTextContent('1');
      expect(fn('my-func').getByTestId('status')).toHaveTextContent('Running');
    });

    it('picks latest revision deployment when multiple revisions exist', () => {
      const ksvcV2 = {
        ...ksvcFixture('my-func', 'True'),
        status: {
          ...ksvcFixture('my-func', 'True').status,
          latestReadyRevisionName: 'my-func-00002',
        },
      };

      setFixtures({
        knSvcs: [ksvcV2],
        deps: [
          deploymentFixture('my-func', 0, 0, 'my-func-00001'),
          deploymentFixture('my-func', 1, 1, 'my-func-00002'),
        ],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('fn-count')).toHaveTextContent('1');
      expect(fn('my-func').getByTestId('replicas')).toHaveTextContent('1');
    });

    it('returns empty map when no ksvc resources', () => {
      render(<TestConsumer functionNames={['my-func']} />);

      expect(screen.getByTestId('fn-count')).toHaveTextContent('0');
    });

    it('handles multiple functions independently', () => {
      setFixtures({
        knSvcs: [ksvcFixture('func-a', 'True'), ksvcFixture('func-b', 'False')],
        deps: [deploymentFixture('func-a', 1, 1), deploymentFixture('func-b', 0, 0)],
      });

      render(<TestConsumer functionNames={['func-a', 'func-b']} />);

      expect(screen.getByTestId('fn-count')).toHaveTextContent('2');
      expect(fn('func-a').getByTestId('status')).toHaveTextContent('Running');
      expect(fn('func-a').getByTestId('replicas')).toHaveTextContent('1');
      expect(fn('func-b').getByTestId('status')).toHaveTextContent('Error');
      expect(fn('func-b').getByTestId('replicas')).toHaveTextContent('0');
    });
  });

  describe('name', () => {
    it('uses function.knative.dev/name label', () => {
      setFixtures({ knSvcs: [ksvcFixture('my-func', 'True')] });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('name')).toHaveTextContent('my-func');
    });
  });

  describe('status', () => {
    it('returns Deploying when deployment is undefined', () => {
      setFixtures({ knSvcs: [ksvcFixture('my-func', 'True')] });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('status')).toHaveTextContent('Deploying');
    });

    it('returns Running when Ready=True and replicas > 0', () => {
      setFixtures({
        knSvcs: [ksvcFixture('my-func', 'True')],
        deps: [deploymentFixture('my-func', 1, 1)],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('status')).toHaveTextContent('Running');
    });

    it('returns ScaledToZero when Ready=True and replicas are 0', () => {
      setFixtures({
        knSvcs: [ksvcFixture('my-func', 'True')],
        deps: [deploymentFixture('my-func', 0, 0)],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('status')).toHaveTextContent('ScaledToZero');
    });

    it('returns Error when Ready=False', () => {
      setFixtures({
        knSvcs: [ksvcFixture('my-func', 'False')],
        deps: [deploymentFixture('my-func', 0, 0)],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('status')).toHaveTextContent('Error');
    });

    it('returns Deploying when Ready=Unknown', () => {
      setFixtures({
        knSvcs: [ksvcFixture('my-func', 'Unknown')],
        deps: [deploymentFixture('my-func', 1, 0)],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('status')).toHaveTextContent('Deploying');
    });

    it('returns Deploying when no Ready condition exists', () => {
      const ksvc = {
        metadata: { name: 'my-func', labels: { 'function.knative.dev/name': 'my-func' } },
        status: { conditions: [{ type: 'ConfigurationsReady', status: 'True' }] },
      };

      setFixtures({ knSvcs: [ksvc], deps: [deploymentFixture('my-func', 1, 0)] });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('status')).toHaveTextContent('Deploying');
    });
  });

  describe('url', () => {
    it('returns ksvc status url', () => {
      setFixtures({
        knSvcs: [ksvcFixture('my-func', 'True')],
        deps: [deploymentFixture('my-func', 1, 1)],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('url')).toHaveTextContent(
        'https://my-func-demo.apps.example.com',
      );
    });

    it('returns undefined when ksvc has no status url', () => {
      setFixtures({
        knSvcs: [
          {
            metadata: { name: 'my-func', labels: { [FUNCTION_NAME_LABEL]: 'my-func' } },
            status: {},
          },
        ],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('url')).toHaveTextContent('');
    });
  });

  describe('replicas', () => {
    it('returns readyReplicas from deployment', () => {
      setFixtures({
        knSvcs: [ksvcFixture('my-func', 'True')],
        deps: [deploymentFixture('my-func', 2, 2)],
      });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('replicas')).toHaveTextContent('2');
    });

    it('returns 0 when deployment is undefined', () => {
      setFixtures({ knSvcs: [ksvcFixture('my-func', 'True')] });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('replicas')).toHaveTextContent('0');
    });
  });

  describe('mainResource', () => {
    it('returns the knative service', () => {
      setFixtures({ knSvcs: [ksvcFixture('my-func', 'True')] });

      render(<TestConsumer functionNames={['my-func']} />);

      expect(fn('my-func').getByTestId('has-resource')).toHaveTextContent('true');
    });
  });
});
