import { render, screen } from '@testing-library/react';
import { useClusterService } from './useClusterService';
import { ClusterFunction } from './ClusterFunction';

const mockUseK8sWatchResource = vi.fn();

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  useK8sWatchResource: (...args: unknown[]) => mockUseK8sWatchResource(...args),
}));

vi.mock('./ClusterFunctionKnative', () => ({
  listKnativeClusterFunctions: (knSvcs: unknown[]) =>
    (knSvcs as { metadata?: { labels?: Record<string, string>; name?: string } }[]).map((ksvc) => ({
      name: ksvc.metadata?.labels?.['function.knative.dev/name'] ?? ksvc.metadata?.name ?? '',
      status: 'Running' as const,
      url: undefined,
      replicas: 0,
      mainResource: ksvc,
    })),
}));

function TestConsumer({ functionNames = [] }: { functionNames?: string[] }) {
  const { functions, loaded, error } = useClusterService(functionNames);
  return (
    <>
      <span data-testid="loaded">{String(loaded)}</span>
      <span data-testid="error">{String(error)}</span>
      <span data-testid="fn-count">{functions.size}</span>
      {[...functions.values()].map((fn: ClusterFunction) => (
        <div key={fn.name} data-testid="cluster-fn">
          <span data-testid="fn-name">{fn.name}</span>
        </div>
      ))}
    </>
  );
}

const mockKsvc = {
  apiVersion: 'serving.knative.dev/v1',
  kind: 'Service',
  metadata: {
    name: 'my-func',
    namespace: 'demo',
    labels: { 'function.knative.dev/name': 'my-func' },
  },
};

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
      .mockReturnValueOnce([[], true, null]);

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
      .mockReturnValueOnce([[], true, null]);

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

  it('returns empty functions array when no resources match', () => {
    mockUseK8sWatchResource
      .mockReturnValueOnce([[], true, null])
      .mockReturnValueOnce([[], true, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(screen.getByTestId('loaded')).toHaveTextContent('true');
    expect(screen.getByTestId('fn-count')).toHaveTextContent('0');
  });

  it('delegates to listKnativeClusterFunctions and returns results', () => {
    mockUseK8sWatchResource
      .mockReturnValueOnce([[mockKsvc], true, null])
      .mockReturnValueOnce([[], true, null]);

    render(<TestConsumer functionNames={['my-func']} />);

    expect(screen.getByTestId('fn-count')).toHaveTextContent('1');
    expect(screen.getByTestId('fn-name')).toHaveTextContent('my-func');
  });
});
