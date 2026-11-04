import { renderHook, waitFor } from '@testing-library/react';
import { getNamespacesStub } from '../testing/functionsClientStub';
import { useNamespaceOptions } from './useNamespaceOptions';

const sdkTestDoubles = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  HttpError: sdkTestDoubles.HttpError,
  consoleFetch: sdkTestDoubles.consoleFetchStub,
  consoleFetchJSON: sdkTestDoubles.consoleFetchJSONStub,
}));

describe('useNamespaceOptions', () => {
  it('is not loaded while the backend has not answered', () => {
    getNamespacesStub({ wait: new Promise(() => {}) });

    const { result } = renderHook(() => useNamespaceOptions());

    expect(result.current.loaded).toBe(false);
    expect(result.current.namespaces).toEqual([]);
  });

  it('returns the namespaces and access the backend reports', async () => {
    getNamespacesStub({ namespaces: ['team-a', 'team-b'], canCreateNamespaces: true });

    const { result } = renderHook(() => useNamespaceOptions());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.namespaces).toEqual(['team-a', 'team-b']);
    expect(result.current.canCreateNamespaces).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it('reports an error and no namespaces when the backend fails', async () => {
    getNamespacesStub({ errorResponse: { message: 'failed to list namespaces', status: 502 } });

    const { result } = renderHook(() => useNamespaceOptions());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBe('failed to list namespaces');
    expect(result.current.namespaces).toEqual([]);
    expect(result.current.canCreateNamespaces).toBe(false);
  });
});
