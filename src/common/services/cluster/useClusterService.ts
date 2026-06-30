import { K8sResourceKind, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useMemo } from 'react';
import { OcpClusterService } from './OcpClusterService';

const instance = new OcpClusterService();

const FUNCTION_NAME_LABEL = 'function.knative.dev/name';
const REVISION_LABEL = 'serving.knative.dev/revision';

export interface ClusterFunction {
  name: string;
  knativeService?: K8sResourceKind;
  deployment?: K8sResourceKind;
}

interface ClusterService {
  functions: ClusterFunction[];
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
    return pairResources(safeKnSvcs, safeDeps);
  }, [knSvcs, knLoaded, deps, depLoaded]);

  return {
    functions,
    loaded: knLoaded && depLoaded,
    error: knError || depError,
    generateKubeconfig: instance.generateKubeconfig.bind(instance),
  };
}

function pairResources(
  knSvcs: K8sResourceKind[],
  deployments: K8sResourceKind[],
): ClusterFunction[] {
  return knSvcs.map((ksvc) => {
    const name = ksvc.metadata?.labels?.[FUNCTION_NAME_LABEL] ?? ksvc.metadata?.name ?? '';
    const latestRevision = ksvc.status?.latestReadyRevisionName;

    const deployment = latestRevision
      ? deployments.find((d) => d.metadata?.labels?.[REVISION_LABEL] === latestRevision)
      : deployments.find((d) => d.metadata?.labels?.[FUNCTION_NAME_LABEL] === name);

    return { name, knativeService: ksvc, deployment: deployment ?? undefined };
  });
}
