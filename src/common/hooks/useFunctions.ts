import { useEffect, useMemo, useState } from 'react';
import { listFunctions as getFunctionMetadataList } from '../clients/functionsClient';
import {
  ClusterStatus,
  Function,
  FUNCTION_NAME_LABEL,
  FunctionListItem as FunctionMetadata,
  REVISION_LABEL,
} from '../types';
import { errorMessage } from '../utils/utils';
import {
  isAllNamespacesKey,
  useK8sWatchResource,
  K8sResourceKind,
  WatchK8sResource,
} from '@openshift-console/dynamic-plugin-sdk';

export function useFunctions(
  namespace: string,
  connectionId?: number,
  refreshKey?: number,
): {
  functions: Function[];
  loaded: boolean;
  errors?: string[];
} {
  // Source 1: fetch function metadata list from backend
  const [functionMetadataList, setFunctionMetadataList] = useState<FunctionMetadata[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState<string>();
  const [prevNamespace, setPrevNamespace] = useState(namespace);
  const [prevConnectionId, setPrevConnectionId] = useState(connectionId);

  if (namespace !== prevNamespace || connectionId !== prevConnectionId) {
    setPrevNamespace(namespace);
    setPrevConnectionId(connectionId);
    setFunctionMetadataList([]);
    setListLoaded(false);
    setListError(undefined);
  }

  useEffect(() => {
    let ignore = false;

    (async () => {
      if (connectionId === undefined) {
        setListLoaded(true);
        return;
      }

      try {
        const list = await getFunctionMetadataList(namespace);
        if (!ignore) {
          setFunctionMetadataList(list);
          setListLoaded(true);
          setListError(undefined);
        }
      } catch (err) {
        if (!ignore) {
          setListLoaded(true);
          setListError(errorMessage(err));
        }
      }
    })();

    return () => {
      ignore = true;
    };
  }, [connectionId, namespace, refreshKey]);

  const initialFunctions: Map<string, Function> = useMemo(() => {
    const result = new Map<string, Function>();

    functionMetadataList.forEach((item) => {
      result.set(`${item.namespace}/${item.name}`, {
        owner: item.owner,
        repoName: item.repoName,
        runtime: item.runtime,
        source: item.source,
        name: item.name,
        namespace: item.namespace,
        repoURL: item.repoURL,
        routeURL: '',
        status: { cluster: { status: 'NotDeployed' }, workflow: { status: 'None' } },
      });
    });

    return result;
  }, [functionMetadataList]);

  // Source 2: K8s watch for function cluster resources, ksvc + deployments
  const functionNames = useMemo(
    () => functionMetadataList.map((item) => item.name).filter(Boolean),
    [functionMetadataList],
  );

  const ksvcConfig = useMemo(
    () => newKsvcWatchConfig(functionNames, isAllNamespacesKey(namespace) ? undefined : namespace),
    [functionNames, namespace],
  );
  const depConfig = useMemo(
    () =>
      newDeploymentWatchConfig(
        functionNames,
        isAllNamespacesKey(namespace) ? undefined : namespace,
      ),
    [functionNames, namespace],
  );

  const [knSvcs, knLoaded, knError] = useK8sWatchResource<K8sResourceKind[]>(ksvcConfig);
  const [deps, depLoaded, depError] = useK8sWatchResource<K8sResourceKind[]>(depConfig);

  const functionsWithClusterData = useMemo(() => {
    const safeKnSvcs = knLoaded ? (knSvcs ?? []) : [];
    const safeDeps = depLoaded ? (deps ?? []) : [];
    return withClusterData(initialFunctions, safeKnSvcs, safeDeps);
  }, [initialFunctions, knSvcs, knLoaded, deps, depLoaded]);


  const errors: string[] = useMemo(
    () =>
      [listError, knError?.message, depError?.message].filter(
        (errMsg): errMsg is string => !!errMsg,
      ),
    [listError, knError, depError],
  );

  return { functions: functionsWithClusterData, loaded: listLoaded, errors };
}

function withClusterData(
  functions: Map<string, Function>,
  knSvcs: K8sResourceKind[],
  deployments: K8sResourceKind[],
): Function[] {
  const fnsCopy = new Map(functions);
  knSvcs.forEach((ksvc) => {
    const name = ksvc.metadata?.labels?.[FUNCTION_NAME_LABEL] ?? ksvc.metadata?.name ?? '';
    const namespace = ksvc.metadata?.namespace ?? '';
    const key = `${namespace}/${name}`;
    const latestRevision = ksvc.status?.latestReadyRevisionName;

    const nsDeployments = deployments.filter((d) => d.metadata?.namespace === namespace);
    const deployment = latestRevision
      ? nsDeployments.find((d) => d.metadata?.labels?.[REVISION_LABEL] === latestRevision)
      : nsDeployments.find((d) => d.metadata?.labels?.[FUNCTION_NAME_LABEL] === name);

    // Every ksvc is scoped by functionNames from the function metadata list,
    // so a match must exist.
    const fn = fnsCopy.get(key)!;
    fnsCopy.set(key, {
      ...fn,
      status: {
        cluster: deriveClusterStatus(ksvc, deployment),
        workflow: fn.status.workflow,
      },
      routeURL: ksvc.status?.url ?? '',
      replicas: deployment?.status?.readyReplicas ?? 0,
      mainResource: ksvc,
    });
  });

  return Array.from(fnsCopy.values());

  function deriveClusterStatus(
    ksvc: K8sResourceKind,
    deployment: K8sResourceKind | undefined,
  ): ClusterStatus {
    if (ksvc.metadata?.deletionTimestamp) {
      return { status: 'Undeploying' };
    }

    if (!deployment) return { status: 'Deploying' };

    const conditions = ksvc.status?.conditions ?? [];
    const ready = conditions.find((c: { type: string }) => c.type === 'Ready');
    if (!ready) return { status: 'Deploying' };

    if (ready.status === 'True') {
      const desired = deployment.spec?.replicas ?? 0;
      const readyReplicas = deployment.status?.readyReplicas ?? 0;
      if (desired === 0 && readyReplicas === 0) return { status: 'ScaledToZero' };
      return { status: 'Running' };
    }

    if (ready.status === 'False') {
      return {
        status: 'Error',
        errorMessage: ready.message ?? 'Ready condition is False',
      };
    }

    // when Ready=Unknown it's deploying
    return { status: 'Deploying' };
  }
}

// --- K8s watch configs ---

function newKsvcWatchConfig(functionNames: string[], namespace?: string): WatchK8sResource | null {
  return functionNames.length > 0
    ? {
        groupVersionKind: { group: 'serving.knative.dev', version: 'v1', kind: 'Service' },
        isList: true,
        namespace,
        selector: {
          matchExpressions: [{ key: FUNCTION_NAME_LABEL, operator: 'In', values: functionNames }],
        },
      }
    : null;
}

function newDeploymentWatchConfig(
  functionNames: string[],
  namespace?: string,
): WatchK8sResource | null {
  return functionNames.length > 0
    ? {
        groupVersionKind: { group: 'apps', version: 'v1', kind: 'Deployment' },
        isList: true,
        namespace,
        selector: {
          matchExpressions: [{ key: FUNCTION_NAME_LABEL, operator: 'In', values: functionNames }],
        },
      }
    : null;
}
