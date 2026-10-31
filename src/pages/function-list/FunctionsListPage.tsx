import {
  DocumentTitle,
  isAllNamespacesKey,
  K8sResourceKind,
  ListPageHeader,
  NamespaceBar,
  useActiveNamespace,
  useK8sWatchResource,
  WatchK8sResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Content,
  ContentVariants,
  PageSection,
  Spinner,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { SyncAltIcon } from '@patternfly/react-icons';
import { useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { UserAvatar } from '../../common/components/UserAvatar';
import { AuthContext, AuthProvider } from '../../common/context/AuthProvider';
import {
  listFunctions as getFunctionMetadataList,
  receiveWorkflowRunEvents,
} from '../../common/clients/functionsClient';
import { ClusterError } from '../../common/errors';
import {
  FUNCTION_NAME_LABEL,
  FunctionMetadata,
  REVISION_LABEL,
  WorkflowRunRecord,
} from '../../common/types';
import { ClusterStatus, Function, functionKey } from './types';
import { errorMessage } from '../../common/utils/utils';
import { FunctionsEmptyState } from './components/EmptyState';
import { FunctionTable } from './components/FunctionTable';
import { SetupGuide } from './components/SetupGuide';

export default function FunctionsListPage() {
  return (
    <AuthProvider>
      <FunctionsListPageContent />
    </AuthProvider>
  );
}

function FunctionsListPageContent() {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const {
    functions,
    loaded,
    refreshing,
    onEdit,
    onRefresh,
    isAuthenticated,
    errors,
    showNamespace,
  } = useFunctionListPage();

  return (
    <>
      <DocumentTitle>{t('Functions')}</DocumentTitle>
      <NamespaceBar />
      <ListPageHeader title={t('Functions')}>
        <UserAvatar />
      </ListPageHeader>
      <PageSection>
        {errors.length > 0 &&
          errors.map((err, i) => (
            <Alert key={i} variant="danger" title={t('Error')} isInline>
              {err}
            </Alert>
          ))}
        {!loaded && !refreshing && (
          <Spinner aria-label={t('Loading')} style={{ display: 'block', margin: '4rem auto' }} />
        )}
        {loaded && functions.length === 0 && (
          <FunctionsEmptyState isCreateDisabled={!isAuthenticated} />
        )}
        {(loaded || refreshing) && functions.length > 0 && (
          <>
            <Content component={ContentVariants.p}>
              {t(
                'Serverless functions in your repository and deployed to your cluster. Manage lifecycle, monitor status, and scale on demand.',
              )}{' '}
              <SetupGuide />
            </Content>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  {!isAuthenticated ? (
                    <Button variant="primary" isDisabled>
                      {t('Create new function')}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      component={(props) => <Link {...props} to="/faas/create" />}
                    >
                      {t('Create new function')}
                    </Button>
                  )}
                </ToolbarItem>
                <ToolbarItem variant="separator" />
                <ToolbarItem>
                  <Button
                    variant="plain"
                    aria-label={t('Refresh')}
                    onClick={onRefresh}
                    isLoading={refreshing}
                    spinnerAriaLabel={t('Refreshing')}
                    isDisabled={refreshing}
                    icon={<SyncAltIcon />}
                  />
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
            <FunctionTable functions={functions} onEdit={onEdit} showNamespace={showNamespace} />
          </>
        )}
      </PageSection>
    </>
  );
}

function useFunctionListPage(): {
  functions: Function[];
  loaded: boolean;
  refreshing: boolean;
  onEdit: (name: string) => void;
  onRefresh: () => void;
  isAuthenticated: boolean;
  errors: string[];
  showNamespace: boolean;
} {
  const { isAuthenticated, user } = useContext(AuthContext);
  const navigate = useNavigate();
  const [namespace] = useActiveNamespace();
  const [refreshKey, setRefreshKey] = useState(0);

  const { functions, loaded, refreshing, errors } = useFunctions(
    namespace,
    isAuthenticated ? user?.name : undefined,
    refreshKey,
  );

  function onRefresh() {
    if (!isAuthenticated) return;
    setRefreshKey((k) => k + 1);
  }

  const onEdit = (name: string) => navigate(`/faas/edit/${name}`);

  return {
    functions,
    loaded,
    refreshing,
    onEdit,
    onRefresh,
    isAuthenticated,
    errors: errors ?? [],
    showNamespace: isAllNamespacesKey(namespace),
  };
}

function useFunctions(
  namespace: string,
  authUserName?: string,
  refreshKey?: number,
): {
  functions: Function[];
  loaded: boolean;
  refreshing: boolean;
  errors?: string[];
} {
  // Source 1: function metadata list from the backend. Provides repo identity
  // (owner, repoName), func.yaml fields (name, namespace, runtime), and
  // repo-level errors (broken func.yaml). This is the foundation that cluster
  // and workflow data enrich.
  const [functionMetadataList, setFunctionMetadataList] = useState<FunctionMetadata[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState<string>();
  const [prevNamespace, setPrevNamespace] = useState(namespace);
  const [prevAuthUserName, setPrevAuthUserName] = useState(authUserName);
  const [prevRefreshKey, setPrevRefreshKey] = useState(refreshKey);
  const [refreshing, setRefreshing] = useState(false);

  if (namespace !== prevNamespace || authUserName !== prevAuthUserName) {
    setPrevNamespace(namespace);
    setPrevAuthUserName(authUserName);
    setFunctionMetadataList([]);
    setListLoaded(false);
    setListError(undefined);
    setRefreshing(false);
  }

  if (refreshKey !== prevRefreshKey) {
    setPrevRefreshKey(refreshKey);
    setListLoaded(false);
    setRefreshing(true);
  }

  useEffect(() => {
    let ignore = false;

    (async () => {
      if (authUserName === undefined) {
        setListLoaded(true);
        return;
      }

      try {
        const list = await getFunctionMetadataList(namespace);
        if (!ignore) {
          setFunctionMetadataList(list);
          setListLoaded(true);
          setListError(undefined);
          setRefreshing(false);
        }
      } catch (err) {
        if (!ignore) {
          setListLoaded(true);
          setListError(errorMessage(err));
          setRefreshing(false);
        }
      }
    })();

    return () => {
      ignore = true;
    };
  }, [authUserName, namespace, refreshKey]);

  const initialFunctions: Map<string, Function> = useMemo(() => {
    const result = new Map<string, Function>();
    functionMetadataList.forEach((item) => {
      result.set(functionKey(item), {
        owner: item.owner,
        repoName: item.repoName,
        name: item.name,
        namespace: item.namespace,
        runtime: item.runtime,
        source: item.source,
        status: { cluster: { status: 'NotDeployed' }, workflow: { status: 'None' } },
        error: item.error,
      });
    });
    return result;
  }, [functionMetadataList]);

  // Source 2: K8s watch for cluster resources (ksvc + deployments). Enriches
  // functions with cluster status (Running, ScaledToZero, Error, etc.), route
  // URL, replica count, and the ksvc as mainResource. Only healthy functions
  // (with a name) participate in cluster matching.
  const functionNames = useMemo(
    () => functionMetadataList.map((item) => item.name).filter((n): n is string => !!n),
    [functionMetadataList],
  );

  const [ksvcConfig, depConfig] = useMemo(() => {
    const ns = isAllNamespacesKey(namespace) ? undefined : namespace;
    return [newKsvcWatchConfig(functionNames, ns), newDeploymentWatchConfig(functionNames, ns)];
  }, [functionNames, namespace]);

  const [knSvcs, knLoaded, knError] = useK8sWatchResource<K8sResourceKind[]>(ksvcConfig);
  const [deps, depLoaded, depError] = useK8sWatchResource<K8sResourceKind[]>(depConfig);

  const functionsWithClusterData = useMemo(() => {
    const safeKnSvcs = knLoaded ? (knSvcs ?? []) : [];
    const safeDeps = depLoaded ? (deps ?? []) : [];
    return withClusterData(initialFunctions, safeKnSvcs, safeDeps);
  }, [initialFunctions, knSvcs, knLoaded, deps, depLoaded]);

  // Source 3: workflow status via SSE. Enriches functions with GitHub Actions
  // workflow run status (InProgress, Succeeded, Failed) streamed from the backend.
  // Keyed by owner/repoName, so it works for both healthy and broken entries.
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunRecord>({});
  const [receiveError, setReceiveError] = useState<string>();

  useEffect(() => {
    if (authUserName === undefined) return;

    const close = receiveWorkflowRunEvents(
      (runs) => {
        setWorkflowRuns(runs);
        setReceiveError(undefined);
      },
      (errMessage) => {
        setReceiveError(errMessage);
      },
    );

    return () => close();
  }, [authUserName, refreshKey]);

  // Compose the final function list from all three sources.
  const functions = useMemo(
    () => withWorkflowRunData(functionsWithClusterData, workflowRuns),
    [functionsWithClusterData, workflowRuns],
  );

  const errors: string[] = useMemo(
    () =>
      [listError, knError?.message, depError?.message, receiveError].filter(
        (errMsg): errMsg is string => !!errMsg,
      ),
    [listError, knError, depError, receiveError],
  );

  return { functions: Array.from(functions.values()), loaded: listLoaded, refreshing, errors };
}

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

function withClusterData(
  functions: Map<string, Function>,
  knSvcs: K8sResourceKind[],
  deployments: K8sResourceKind[],
): Map<string, Function> {
  const result = new Map(functions);
  knSvcs.forEach((ksvc) => {
    const name = ksvc.metadata?.labels?.[FUNCTION_NAME_LABEL] ?? ksvc.metadata?.name ?? '';
    const namespace = ksvc.metadata?.namespace ?? '';
    const key = `${namespace}/${name}`;
    const latestRevision = ksvc.status?.latestReadyRevisionName;

    const nsDeployments = deployments.filter((d) => d.metadata?.namespace === namespace);
    const deployment = latestRevision
      ? nsDeployments.find((d) => d.metadata?.labels?.[REVISION_LABEL] === latestRevision)
      : nsDeployments.find((d) => d.metadata?.labels?.[FUNCTION_NAME_LABEL] === name);
    const common = {
      routeURL: ksvc.status?.url || undefined,
      replicas: deployment?.status?.readyReplicas ?? 0,
      mainResource: ksvc,
    };

    const fn = result.get(key);
    const value = fn
      ? {
          ...fn,
          ...common,
          status: {
            cluster: deriveClusterStatus(ksvc, deployment),
            workflow: fn.status.workflow,
          },
        }
      : // A ksvc with a matching function name appeared in the watch without a
        // metadata entry (e.g. deployed to another namespace via CLI while the
        // page was open). Create a cluster-only entry.
        {
          ...common,
          name,
          namespace,
          source: 'cluster' as const,
          status: {
            cluster: deriveClusterStatus(ksvc, deployment),
            workflow: { status: 'None' as const },
          },
        };
    result.set(key, value);
  });

  return result;

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
        error: new ClusterError(
          ready.reason ?? 'Unknown',
          ready.message ?? 'Deployment error. See cluster events.',
        ),
      };
    }

    return { status: 'Deploying' };
  }
}

function withWorkflowRunData(
  functions: Map<string, Function>,
  workflowRuns: WorkflowRunRecord,
): Map<string, Function> {
  const result = new Map(functions);
  result.forEach((fn, key) => {
    // cluster-only functions have no workflow run
    if (!fn.owner || !fn.repoName) return;
    const workflowRun = workflowRuns[`${fn.owner}/${fn.repoName}`];
    if (workflowRun)
      result.set(key, {
        ...fn,
        status: { cluster: fn.status.cluster, workflow: workflowRun },
      });
  });
  return result;
}
