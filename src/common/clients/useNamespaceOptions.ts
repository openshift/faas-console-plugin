import {
  K8sResourceKind,
  useAccessReview,
  useK8sWatchResource,
  WatchK8sResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { useMemo } from 'react';
import { isSystemNamespace } from '../utils/utils';

const PROJECT_CONFIG: WatchK8sResource = {
  groupVersionKind: { group: 'project.openshift.io', version: 'v1', kind: 'Project' },
  isList: true,
};

interface UseNamespaceOptionsResult {
  canCreateNamespaces: boolean;
  namespaces: string[];
  loaded: boolean;
  error: Error;
}

// The namespace choices a user is allowed to deploy into. This is deliberately separate
// from useCluster: a caller has to resolve its target namespace from these options before
// it can open a namespace-scoped watch, so the two cannot be one hook.
export function useNamespaceOptions(): UseNamespaceOptionsResult {
  const [canCreateNamespaces, accessLoading] = useAccessReview({
    group: '',
    resource: 'namespaces',
    verb: 'create',
  });

  const [projects, projectsLoaded, projectsError] =
    useK8sWatchResource<K8sResourceKind[]>(PROJECT_CONFIG);

  // A user who cannot create namespaces should never be offered a system namespace, so
  // those are filtered out of their choices; an admin keeps the full list.
  const namespaces = useMemo(() => {
    const all = (projects ?? [])
      .map((p) => p.metadata?.name)
      .filter((name): name is string => Boolean(name))
      .sort();
    return canCreateNamespaces ? all : all.filter((name) => !isSystemNamespace(name));
  }, [projects, canCreateNamespaces]);

  return {
    canCreateNamespaces,
    namespaces,
    loaded: !accessLoading && projectsLoaded,
    error: projectsError,
  };
}
