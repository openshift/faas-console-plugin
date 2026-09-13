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

// START: consoleFetchStreamStub -----------------------------------------------
// Test double for the SSE stream consumed by useBuildStatus. Mirrors the
// setFixtures pattern above: module-level fixtures that tests set, and a stub
// function wired into the mocked consoleFetch.
//
// Each element of `frames` is enqueued as a separate ReadableStream chunk, so
// tests can split a single SSE frame across chunk boundaries to exercise the
// hook's cross-read buffering.

let frames: string[] = [];
let streamError: unknown = null;
let streamCalls = 0;
let nullBodyCalls = 0;
let lastStreamArgs: unknown[] = [];

export function setStreamFrames(newFrames: string[]) {
  frames = newFrames;
  streamError = null;
}

// setNullBodyForNext makes the next n consoleFetch calls resolve 2xx with a null
// body, simulating a body-less response the hook must recover from.
export function setNullBodyForNext(n: number) {
  nullBodyCalls = n;
}

// setStreamError makes the next consoleFetch reject, simulating an HTTP or
// network failure. Attach a `code` (HTTP status) to simulate an auth failure.
export function setStreamError(err: unknown) {
  streamError = err;
}

export function resetStreamFrames() {
  frames = [];
  streamError = null;
  streamCalls = 0;
  nullBodyCalls = 0;
  lastStreamArgs = [];
}

// streamFetchCalls reports how many times the stubbed consoleFetch was invoked,
// so tests can assert reconnect versus stop behaviour.
export function streamFetchCalls(): number {
  return streamCalls;
}

// streamFetchLastArgs reports the arguments of the most recent consoleFetch call
// (url, options, timeout), so tests can assert how the request was configured.
export function streamFetchLastArgs(): unknown[] {
  return lastStreamArgs;
}

// buildStatusFrame formats a single SSE build-status event. functions is keyed
// by "owner/repo", matching the backend wire shape.
export function buildStatusFrame(functions: Record<string, unknown>): string {
  return `event: build-status\ndata: ${JSON.stringify({ functions })}\n\n`;
}

// consoleFetchStub stands in for consoleFetch(url, options, timeout): it records
// its arguments and serves the configured frames (or error) as the response body.
export const consoleFetchStub = (...args: unknown[]): Promise<Response> => {
  streamCalls++;
  lastStreamArgs = args;
  if (streamError) return Promise.reject(streamError);
  if (nullBodyCalls > 0) {
    nullBodyCalls--;
    return Promise.resolve(new Response(null, { status: 200 }));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of frames) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return Promise.resolve(new Response(stream, { status: 200 }));
};
// END: consoleFetchStreamStub -------------------------------------------------
