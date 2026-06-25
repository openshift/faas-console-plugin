import { render, screen } from '@testing-library/react';
import { useClusterService, ClusterFunction } from './useClusterService';

const mockUseK8sWatchResource = vi.fn();

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  useK8sWatchResource: (...args: unknown[]) => mockUseK8sWatchResource(...args),
}));

const mockKsvc = {
  apiVersion: 'serving.knative.dev/v1',
  kind: 'Service',
  metadata: {
    name: 'my-func',
    namespace: 'demo',
    labels: { 'function.knative.dev/name': 'my-func' },
  },
  status: {
    url: 'https://my-func-demo.apps.example.com',
    latestReadyRevisionName: 'my-func-00001',
    conditions: [{ type: 'Ready', status: 'True' }],
  },
};

const mockDeployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'my-func-00001-deployment',
    namespace: 'demo',
    labels: {
      'function.knative.dev/name': 'my-func',
      'serving.knative.dev/revision': 'my-func-00001',
    },
  },
  spec: { replicas: 1 },
  status: { readyReplicas: 1 },
};

function TestConsumer({ functionNames = [] }: { functionNames?: string[] }) {
  const { functions, loaded, error } = useClusterService(functionNames);
  return (
    <>
      <span data-testid="loaded">{String(loaded)}</span>
      <span data-testid="error">{String(error)}</span>
      <span data-testid="fn-count">{functions.length}</span>
      {functions.map((fn: ClusterFunction) => (
        <div key={fn.name} data-testid="cluster-fn">
          <span data-testid="fn-name">{fn.name}</span>
          <span data-testid="has-ksvc">{String(!!fn.knativeService)}</span>
          <span data-testid="has-dep">{String(!!fn.deployment)}</span>
        </div>
      ))}
    </>
  );
}

describe('useClusterService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes null config when function names are empty', () => {
    mockUseK8sWatchResource.mockReturnValue([[], true, null]);

    render(<TestConsumer />);

    expect(mockUseK8sWatchResource).toHaveBeenCalledWith(null);
    expect(screen.getByTestId('loaded')).toHaveTextContent('true');
    expect(screen.getByTestId('fn-count')).toHaveTextContent('0');
  });

  it('watches Knative Services with In selector for given function names', () => {
    mockUseK8sWatchResource
      .mockReturnValueOnce([[mockKsvc], true, null])
      .mockReturnValueOnce([[mockDeployment], true, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(mockUseK8sWatchResource).toHaveBeenCalledWith({
      groupVersionKind: { group: 'serving.knative.dev', version: 'v1', kind: 'Service' },
      isList: true,
      selector: {
        matchExpressions: [
          { key: 'function.knative.dev/name', operator: 'In', values: ['my-func'] },
        ],
      },
    });
  });

  it('watches Deployments with In selector for given function names', () => {
    mockUseK8sWatchResource
      .mockReturnValueOnce([[mockKsvc], true, null])
      .mockReturnValueOnce([[mockDeployment], true, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(mockUseK8sWatchResource).toHaveBeenCalledWith({
      groupVersionKind: { group: 'apps', version: 'v1', kind: 'Deployment' },
      isList: true,
      selector: {
        matchExpressions: [
          { key: 'function.knative.dev/name', operator: 'In', values: ['my-func'] },
        ],
      },
    });
  });

  it('returns empty functions array when not loaded', () => {
    mockUseK8sWatchResource
      .mockReturnValueOnce([[], false, null])
      .mockReturnValueOnce([[], false, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(screen.getByTestId('loaded')).toHaveTextContent('false');
    expect(screen.getByTestId('fn-count')).toHaveTextContent('0');
  });

  it('pairs ksvc with deployment by revision label', () => {
    mockUseK8sWatchResource
      .mockReturnValueOnce([[mockKsvc], true, null])
      .mockReturnValueOnce([[mockDeployment], true, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(screen.getByTestId('fn-count')).toHaveTextContent('1');
    expect(screen.getByTestId('fn-name')).toHaveTextContent('my-func');
    expect(screen.getByTestId('has-ksvc')).toHaveTextContent('true');
    expect(screen.getByTestId('has-dep')).toHaveTextContent('true');
  });

  it('falls back to function name label when no latestReadyRevisionName', () => {
    const ksvcNoRevision = {
      ...mockKsvc,
      status: { ...mockKsvc.status, latestReadyRevisionName: undefined },
    };
    const depByName = {
      ...mockDeployment,
      metadata: {
        ...mockDeployment.metadata,
        labels: { 'function.knative.dev/name': 'my-func' },
      },
    };

    mockUseK8sWatchResource
      .mockReturnValueOnce([[ksvcNoRevision], true, null])
      .mockReturnValueOnce([[depByName], true, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(screen.getByTestId('fn-count')).toHaveTextContent('1');
    expect(screen.getByTestId('has-dep')).toHaveTextContent('true');
  });

  it('picks latest revision deployment when multiple revisions exist', () => {
    const ksvcV2 = {
      ...mockKsvc,
      status: { ...mockKsvc.status, latestReadyRevisionName: 'my-func-00002' },
    };
    const depV1 = {
      ...mockDeployment,
      metadata: {
        ...mockDeployment.metadata,
        name: 'my-func-00001-deployment',
        labels: {
          'function.knative.dev/name': 'my-func',
          'serving.knative.dev/revision': 'my-func-00001',
        },
      },
      spec: { replicas: 0 },
      status: { readyReplicas: 0 },
    };
    const depV2 = {
      ...mockDeployment,
      metadata: {
        ...mockDeployment.metadata,
        name: 'my-func-00002-deployment',
        labels: {
          'function.knative.dev/name': 'my-func',
          'serving.knative.dev/revision': 'my-func-00002',
        },
      },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    };

    mockUseK8sWatchResource
      .mockReturnValueOnce([[ksvcV2], true, null])
      .mockReturnValueOnce([[depV1, depV2], true, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(screen.getByTestId('fn-count')).toHaveTextContent('1');
    expect(screen.getByTestId('has-dep')).toHaveTextContent('true');
  });

  it('returns empty functions array when no resources match', () => {
    mockUseK8sWatchResource
      .mockReturnValueOnce([[], true, null])
      .mockReturnValueOnce([[], true, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(screen.getByTestId('loaded')).toHaveTextContent('true');
    expect(screen.getByTestId('fn-count')).toHaveTextContent('0');
  });
});
