import { K8sResourceKind, WatchK8sResource } from '@openshift-console/dynamic-plugin-sdk';
import { FUNCTION_NAME_LABEL, REVISION_LABEL } from '../types';
import { useSyncExternalStore } from 'react';

// START: global helpers -------------------------------------------------------
export function reset() {
  setWatchFixtures({});
  setActiveNamespace('demo');
}
// END: global helpers ---------------------------------------------------------

// START: useK8sWatchResourceStub ----------------------------------------------
type WatchFixtures = {
  knSvcs: K8sResourceKind[];
  deps: K8sResourceKind[];
  secrets: K8sResourceKind[];
  configMaps: K8sResourceKind[];
  knLoaded?: boolean;
  depLoaded?: boolean;
  secretLoaded?: boolean;
  cmLoaded?: boolean;
  knError?: Error;
  depError?: Error;
  secretError?: Error;
  cmError?: Error;
};

const watchFixtures: WatchFixtures = {
  knSvcs: [],
  deps: [],
  secrets: [],
  configMaps: [],
  knLoaded: true,
  depLoaded: true,
  secretLoaded: true,
  cmLoaded: true,
};

export function setWatchFixtures(opts: Partial<WatchFixtures>) {
  watchFixtures.knSvcs = opts.knSvcs ?? [];
  watchFixtures.deps = opts.deps ?? [];
  watchFixtures.secrets = opts.secrets ?? [];
  watchFixtures.configMaps = opts.configMaps ?? [];
  watchFixtures.knLoaded = opts.knLoaded ?? true;
  watchFixtures.depLoaded = opts.depLoaded ?? true;
  watchFixtures.secretLoaded = opts.secretLoaded ?? true;
  watchFixtures.cmLoaded = opts.cmLoaded ?? true;
  watchFixtures.knError = opts.knError;
  watchFixtures.depError = opts.depError;
  watchFixtures.secretError = opts.secretError;
  watchFixtures.cmError = opts.cmError;
}

export function funcFixture(name: string): Partial<WatchFixtures> {
  return {
    knSvcs: [ksvcFixture(name, 'True')],
    deps: [deploymentFixture(name, 1, 1)],
  };
}

export function ksvcFixture(
  name: string,
  readyStatus: string,
  namespace = 'demo',
  url = `https://${name}-${namespace}.apps.example.com`,
  revision = `${name}-00001`,
): K8sResourceKind {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name,
      namespace,
      labels: { [FUNCTION_NAME_LABEL]: name },
    },
    status: {
      url,
      latestReadyRevisionName: revision,
      conditions: [{ type: 'Ready', status: readyStatus }],
    },
  };
}

export function deploymentFixture(
  name: string,
  specReplicas: number,
  readyReplicas: number,
  namespace = 'demo',
  revision = `${name}-00001`,
): K8sResourceKind {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: `${revision}-deployment`,
      namespace,
      labels: {
        [FUNCTION_NAME_LABEL]: name,
        [REVISION_LABEL]: revision,
      },
    },
    spec: { replicas: specReplicas },
    status: { readyReplicas },
  };
}

export function secretFixture(
  name: string,
  data: {
    [key: string]: string;
  },
  namespace = 'demo',
): K8sResourceKind {
  return configFixture(name, namespace, data, 'Secret');
}

function configFixture(
  name: string,
  namespace: string,
  data: {
    [key: string]: string;
  },
  kind: 'Secret' | 'ConfigMap',
): K8sResourceKind {
  return {
    apiVersion: 'v1',
    kind,
    metadata: {
      name,
      namespace,
    },
    data,
  };
}

export function configMapFixture(
  name: string,
  data: {
    [key: string]: string;
  },
  namespace = 'demo',
): K8sResourceKind {
  return configFixture(name, namespace, data, 'ConfigMap');
}

export const useK8sWatchResourceStub = (config: WatchK8sResource) => {
  if (!config) return [[], true, null];

  const { group, kind } = config.groupVersionKind ?? {};

  if (group === 'serving.knative.dev' && kind === 'Service')
    return [
      filterBySelector(watchFixtures.knSvcs, config),
      watchFixtures.knLoaded,
      watchFixtures.knError,
    ];

  if (group === 'apps' && kind === 'Deployment')
    return [
      filterBySelector(watchFixtures.deps, config),
      watchFixtures.depLoaded,
      watchFixtures.depError,
    ];

  if (!group && kind === 'Secret') {
    return [
      filterByNamespace(watchFixtures.secrets, config.namespace),
      watchFixtures.secretLoaded,
      watchFixtures.secretError,
    ];
  }

  if (!group && kind === 'ConfigMap')
    return [
      filterByNamespace(watchFixtures.configMaps, config.namespace),
      watchFixtures.cmLoaded,
      watchFixtures.cmError,
    ];

  return [[], true, null];

  function filterBySelector(items: K8sResourceKind[], config: WatchK8sResource): K8sResourceKind[] {
    const expr = config?.selector?.matchExpressions?.find(
      (e) => e.key === FUNCTION_NAME_LABEL && e.operator === 'In',
    );

    if (!expr) return items;

    const filteredItems = items.filter((item) => {
      const name = item.metadata?.labels?.[FUNCTION_NAME_LABEL];
      return name != null && expr.values?.includes(name);
    });

    return filterByNamespace(filteredItems, config?.namespace);
  }

  function filterByNamespace(
    items: K8sResourceKind[],
    namespace: string | undefined,
  ): K8sResourceKind[] {
    // if namespace is provided it's filtering by it
    if (config?.namespace !== undefined)
      return items.filter((item) => item.metadata?.namespace === namespace);
    return items;
  }
};
// END: useK8sWatchResourceStub ------------------------------------------------

// START: useActiveNamespaceStub -----------------------------------------------
let namespaceFixture = 'demo';
const listeners = new Set<() => void>();

// Reactive stub for the SDK's useActiveNamespace hook. Uses
// useSyncExternalStore so that calling setActiveNamespace in a test
// triggers a React re-render, matching real console behavior.
export const useActiveNamespaceStub = () => {
  const result = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => namespaceFixture,
  );
  return [result, setActiveNamespace];
};

// Update the active namespace and notify React. Wrap in act() in tests.
export function setActiveNamespace(ns: string) {
  namespaceFixture = ns;
  listeners.forEach((listener) => listener());
}
// END: useActiveNamespaceStub -------------------------------------------------

// START: isAllNamespaceKeyFake ------------------------------------------------
export const isAllNamespaceKeyFake = (ns: string) => ns === '#ALL_NS#';
// END: isAllNamespaceKeyFake --------------------------------------------------
