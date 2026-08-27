import {
  K8sResourceKind,
  useK8sWatchResource,
  WatchK8sResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { useMemo } from 'react';
import {
  ClusterFunction,
  FUNCTION_NAME_LABEL,
  FunctionStatus,
  K8sKeyedResource,
  REVISION_LABEL,
} from '../types';

export function useCluster(
  functionNames: string[] = [],
  namespace?: string,
): {
  functions: ReadonlyMap<string, ClusterFunction>;
  secrets: K8sKeyedResource[];
  configMaps: K8sKeyedResource[];
  loaded: boolean;
  error: Error;
} {
  const knSvcConfig = useMemo(
    () => newKsvcWatchConfig(functionNames, namespace),
    [functionNames, namespace],
  );
  const depConfig = useMemo(
    () => newDeploymentWatchConfig(functionNames, namespace),
    [functionNames, namespace],
  );

  const secretConfig = useMemo(() => newSecretConfig(namespace), [namespace]);
  const configMapConfig = useMemo(() => newConfigMapConfig(namespace), [namespace]);

  const [knSvcs, knLoaded, knError] = useK8sWatchResource<K8sResourceKind[]>(knSvcConfig);
  const [deps, depLoaded, depError] = useK8sWatchResource<K8sResourceKind[]>(depConfig);
  const [rawSecrets, secretLoaded, secretError] =
    useK8sWatchResource<K8sResourceKind[]>(secretConfig);
  const [rawConfigMaps, cmLoaded, cmError] =
    useK8sWatchResource<K8sResourceKind[]>(configMapConfig);

  const functions = useMemo(() => {
    const safeKnSvcs = knLoaded ? (knSvcs ?? []) : [];
    const safeDeps = depLoaded ? (deps ?? []) : [];
    return listKnativeClusterFunctions(safeKnSvcs, safeDeps);
  }, [knSvcs, knLoaded, deps, depLoaded]);

  const secrets = useMemo(() => toKeyedResources(rawSecrets), [rawSecrets]);
  const configMaps = useMemo(() => toKeyedResources(rawConfigMaps), [rawConfigMaps]);

  let loaded = knLoaded && depLoaded;
  if (namespace) loaded = loaded && secretLoaded && cmLoaded;

  return {
    functions,
    secrets,
    configMaps,
    loaded,
    error: knError || depError || secretError || cmError,
  };
}

function newKsvcWatchConfig(functionNames: string[], namespace?: string): WatchK8sResource | null {
  return functionNames.length > 0
    ? newWatchConfigWithSelector(functionNames, 'serving.knative.dev', 'Service', namespace)
    : null;
}

function newWatchConfigWithSelector(
  functionNames: string[],
  group: string,
  kind: string,
  namespace?: string,
): WatchK8sResource {
  return {
    groupVersionKind: { group, version: 'v1', kind },
    isList: true,
    namespace,
    selector: {
      matchExpressions: [{ key: FUNCTION_NAME_LABEL, operator: 'In', values: functionNames }],
    },
  };
}

function newDeploymentWatchConfig(
  functionNames: string[],
  namespace?: string,
): WatchK8sResource | null {
  return functionNames.length > 0
    ? newWatchConfigWithSelector(functionNames, 'apps', 'Deployment', namespace)
    : null;
}

function newSecretConfig(namespace?: string): WatchK8sResource | null {
  return namespace ? newDataWatchConfig('Secret', namespace) : null;
}

function newConfigMapConfig(namespace?: string): WatchK8sResource | null {
  return namespace ? newDataWatchConfig('ConfigMap', namespace) : null;
}

function newDataWatchConfig(kind: string, namespace?: string): WatchK8sResource {
  return {
    groupVersionKind: { version: 'v1', kind },
    namespace,
    isList: true,
  };
}

function listKnativeClusterFunctions(
  knSvcs: K8sResourceKind[],
  deployments: K8sResourceKind[],
): ReadonlyMap<string, ClusterFunction> {
  const entries = knSvcs.map((ksvc): [string, ClusterFunction] => {
    const name = ksvc.metadata?.labels?.[FUNCTION_NAME_LABEL] ?? ksvc.metadata?.name ?? '';
    const namespace = ksvc.metadata?.namespace ?? '';
    const latestRevision = ksvc.status?.latestReadyRevisionName;

    const nsDeployments = deployments.filter((d) => d.metadata?.namespace === namespace);
    const deployment = latestRevision
      ? nsDeployments.find((d) => d.metadata?.labels?.[REVISION_LABEL] === latestRevision)
      : nsDeployments.find((d) => d.metadata?.labels?.[FUNCTION_NAME_LABEL] === name);

    return [
      `${namespace}/${name}`,
      {
        name,
        namespace,
        status: deriveKnativeStatus(ksvc, deployment),
        url: ksvc.status?.url ?? '',
        replicas: deployment?.status?.readyReplicas ?? 0,
        mainResource: ksvc,
      },
    ];
  });

  return new Map(entries);
}

function deriveKnativeStatus(
  ksvc: K8sResourceKind,
  deployment: K8sResourceKind | undefined,
): FunctionStatus {
  if (!deployment) return 'Deploying';

  const conditions = ksvc.status?.conditions ?? [];
  const ready = conditions.find((c: { type: string }) => c.type === 'Ready');
  if (!ready) return 'Deploying';

  if (ready.status === 'True') {
    const desired = deployment.spec?.replicas ?? 0;
    const readyReplicas = deployment.status?.readyReplicas ?? 0;
    if (desired === 0 && readyReplicas === 0) return 'ScaledToZero';
    return 'Running';
  }

  if (ready.status === 'False') return 'Error';

  return 'Deploying';
}

function toKeyedResources(resources: K8sResourceKind[]): K8sKeyedResource[] {
  return (resources ?? [])
    .filter((r) => r.metadata?.name)
    .map((r) => ({
      name: r.metadata!.name!,
      keys: r.data ? Object.keys(r.data) : [],
    }));
}
