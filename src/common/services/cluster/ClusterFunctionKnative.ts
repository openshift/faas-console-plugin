import { K8sResourceKind } from '@openshift-console/dynamic-plugin-sdk';
import { FunctionStatus } from '../types';
import { ClusterFunction } from './ClusterFunction';

const FUNCTION_NAME_LABEL = 'function.knative.dev/name';
const REVISION_LABEL = 'serving.knative.dev/revision';

export function listKnativeClusterFunctions(
  knSvcs: K8sResourceKind[],
  deployments: K8sResourceKind[],
): ClusterFunction[] {
  return knSvcs.map((ksvc) => {
    const name = ksvc.metadata?.labels?.[FUNCTION_NAME_LABEL] ?? ksvc.metadata?.name ?? '';
    const latestRevision = ksvc.status?.latestReadyRevisionName;

    const deployment = latestRevision
      ? deployments.find((d) => d.metadata?.labels?.[REVISION_LABEL] === latestRevision)
      : deployments.find((d) => d.metadata?.labels?.[FUNCTION_NAME_LABEL] === name);

    return {
      name,
      status: deriveStatus(ksvc, deployment),
      url: ksvc.status?.url,
      replicas: deployment?.status?.readyReplicas ?? 0,
      mainResource: ksvc,
    };
  });
}

function deriveStatus(
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
