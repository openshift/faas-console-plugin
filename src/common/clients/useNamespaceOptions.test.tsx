import { renderHook } from '@testing-library/react';
import {
  projectFixture,
  reset,
  setWatchFixtures,
  useAccessReviewStub,
  useK8sWatchResourceStub,
} from '../testing/sdkTestDoubles';
import { useNamespaceOptions } from './useNamespaceOptions';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  useAccessReview: useAccessReviewStub,
  useK8sWatchResource: useK8sWatchResourceStub,
}));

describe('useNamespaceOptions', () => {
  afterEach(() => {
    reset();
  });

  describe('canCreateNamespaces', () => {
    it('is true when the user can create namespaces', () => {
      setWatchFixtures({ canCreate: true });

      const { result } = renderHook(() => useNamespaceOptions());

      expect(result.current.canCreateNamespaces).toBe(true);
    });

    it('is false when the user cannot create namespaces', () => {
      setWatchFixtures({ canCreate: false, projects: [projectFixture('team-a')] });

      const { result } = renderHook(() => useNamespaceOptions());

      expect(result.current.canCreateNamespaces).toBe(false);
    });
  });

  describe('namespaces', () => {
    it('returns the accessible namespaces sorted', () => {
      setWatchFixtures({
        canCreate: false,
        projects: [projectFixture('team-b'), projectFixture('team-a')],
      });

      const { result } = renderHook(() => useNamespaceOptions());

      expect(result.current.namespaces).toEqual(['team-a', 'team-b']);
    });

    it('filters out system namespaces for a user who cannot create namespaces', () => {
      setWatchFixtures({
        canCreate: false,
        projects: [
          projectFixture('team-a'),
          projectFixture('openshift-monitoring'),
          projectFixture('kube-system'),
          projectFixture('default'),
        ],
      });

      const { result } = renderHook(() => useNamespaceOptions());

      expect(result.current.namespaces).toEqual(['team-a']);
    });

    it('keeps system namespaces for a user who can create namespaces', () => {
      setWatchFixtures({
        canCreate: true,
        projects: [projectFixture('team-a'), projectFixture('openshift-monitoring')],
      });

      const { result } = renderHook(() => useNamespaceOptions());

      expect(result.current.namespaces).toEqual(['openshift-monitoring', 'team-a']);
    });
  });

  describe('loaded', () => {
    it('is not loaded while the access review is pending', () => {
      setWatchFixtures({ accessLoading: true });

      const { result } = renderHook(() => useNamespaceOptions());

      expect(result.current.loaded).toBe(false);
    });

    it('is not loaded while the project watch is pending', () => {
      setWatchFixtures({ projectsLoaded: false });

      const { result } = renderHook(() => useNamespaceOptions());

      expect(result.current.loaded).toBe(false);
    });

    it('is loaded once the review and the project watch complete', () => {
      setWatchFixtures({ projects: [projectFixture('team-a')] });

      const { result } = renderHook(() => useNamespaceOptions());

      expect(result.current.loaded).toBe(true);
    });
  });
});
