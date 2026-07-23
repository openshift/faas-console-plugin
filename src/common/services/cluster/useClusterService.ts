import { K8sResourceKind, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useMemo } from 'react';
import { ClusterFunction, FunctionStatus } from '../types';
import { OcpClusterService } from './OcpClusterService';

const instance = new OcpClusterService();

const FUNCTION_NAME_LABEL = 'function.knative.dev/name';
const REVISION_LABEL = 'serving.knative.dev/revision';

interface ClusterService {
  functions: ReadonlyMap<string, ClusterFunction>;
  loaded: boolean;
  error: unknown;
  generateKubeconfig: (namespace: string) => Promise<string>;
}

export function useClusterService(functionNames: string[] = []): ClusterService {
  const knSvcConfig = useMemo(
    () =>
      functionNames.length > 0
        ? {
            groupVersionKind: { group: 'serving.knative.dev', version: 'v1', kind: 'Service' },
            isList: true,
            selector: {
              matchExpressions: [
                { key: FUNCTION_NAME_LABEL, operator: 'In', values: functionNames },
              ],
            },
          }
        : null,
    [functionNames],
  );

  const depConfig = useMemo(
    () =>
      functionNames.length > 0
        ? {
            groupVersionKind: { group: 'apps', version: 'v1', kind: 'Deployment' },
            isList: true,
            selector: {
              matchExpressions: [
                { key: FUNCTION_NAME_LABEL, operator: 'In', values: functionNames },
              ],
            },
          }
        : null,
    [functionNames],
  );

  const [knSvcs, knLoaded, knError] = useK8sWatchResource<K8sResourceKind[]>(knSvcConfig);
  const [deps, depLoaded, depError] = useK8sWatchResource<K8sResourceKind[]>(depConfig);

  const functions = useMemo(() => {
    const safeKnSvcs = knLoaded ? (knSvcs ?? []) : [];
    const safeDeps = depLoaded ? (deps ?? []) : [];
    return listKnativeClusterFunctions(safeKnSvcs, safeDeps);
  }, [knSvcs, knLoaded, deps, depLoaded]);

  return {
    functions,
    loaded: knLoaded && depLoaded,
    error: knError || depError,
    generateKubeconfig: instance.generateKubeconfig.bind(instance),
  };
}

function listKnativeClusterFunctions(
  knSvcs: K8sResourceKind[],
  deployments: K8sResourceKind[],
): ReadonlyMap<string, ClusterFunction> {
  const entries = knSvcs.map((ksvc): [string, ClusterFunction] => {
    const name = ksvc.metadata?.labels?.[FUNCTION_NAME_LABEL] ?? ksvc.metadata?.name ?? '';
    const latestRevision = ksvc.status?.latestReadyRevisionName;

    const deployment = latestRevision
      ? deployments.find((d) => d.metadata?.labels?.[REVISION_LABEL] === latestRevision)
      : deployments.find((d) => d.metadata?.labels?.[FUNCTION_NAME_LABEL] === name);

    return [
      name,
      {
        name,
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
