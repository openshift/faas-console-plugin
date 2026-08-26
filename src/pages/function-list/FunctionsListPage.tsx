import {
  DocumentTitle,
  isAllNamespacesKey,
  ListPageHeader,
  NamespaceBar,
  useActiveNamespace,
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
import { FunctionsEmptyState } from './components/EmptyState';
import { FunctionTable, FunctionTableItem } from './components/FunctionTable';
import { SetupGuide } from './components/SetupGuide';
import { UserAvatar } from '../../common/components/UserAvatar';
import { AuthContext, AuthProvider } from '../../common/context/AuthProvider';
import { BuildStatus, ClusterFunction, FunctionListItem } from '../../common/types';
import { useCluster } from '../../common/clients/useCluster';
import { useBuildStatus } from '../../common/clients/useBuildStatus';
import { listFunctions } from '../../common/clients/functionsClient';
import { errorMessage } from '../../common/utils/utils';

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
    error,
    showNamespace,
  } = useFunctionListPage();

  return (
    <>
      <DocumentTitle>{t('Functions')}</DocumentTitle>
      <NamespaceBar />
      <ListPageHeader title={t('Functions')}>
        <UserAvatar enableReconnect />
      </ListPageHeader>
      <PageSection>
        {error && (
          <Alert variant="danger" title={t('Error listing functions')} isInline>
            {error}
          </Alert>
        )}
        {!loaded && (
          <Spinner aria-label={t('Loading')} style={{ display: 'block', margin: '4rem auto' }} />
        )}
        {loaded && functions.length === 0 && (
          <FunctionsEmptyState isCreateDisabled={!isAuthenticated} />
        )}
        {loaded && functions.length > 0 && (
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
  functions: FunctionTableItem[];
  loaded: boolean;
  refreshing: boolean;
  onEdit: (name: string) => void;
  onRefresh: () => void;
  isAuthenticated: boolean;
  error: string;
  showNamespace: boolean;
} {
  const { isAuthenticated, connectionId } = useContext(AuthContext);
  const navigate = useNavigate();

  const [namespace] = useActiveNamespace();

  const [functionItems, setFunctionItems] = useState<FunctionTableItem[]>([]);
  const [namespaceLoaded, setNamespaceLoaded] = useState(isAuthenticated ? false : true);
  const [prevNamespace, setPrevNamespace] = useState(namespace);

  const [prevConnectionId, setPrevConnectionId] = useState(connectionId);

  const [error, setError] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);

  // Reset state when connection changes (initial connect or user switch)
  if (connectionId !== prevConnectionId) {
    setPrevConnectionId(connectionId);
    setFunctionItems([]);
    setError('');
    setNamespaceLoaded(false);
  }

  // Reset state when namespace changes
  if (namespace !== prevNamespace) {
    setPrevNamespace(namespace);
    setFunctionItems([]);
    setError('');
    setNamespaceLoaded(false);
  }

  async function onRefresh() {
    if (!isAuthenticated) return;
    setRefreshing(true);

    try {
      const items = await loadFunctionTableItems(namespace);
      setFunctionItems(items);
      setNamespaceLoaded(true);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!isAuthenticated) return;

    let ignore = false;

    async function doLoad() {
      let items: FunctionTableItem[];

      try {
        items = await loadFunctionTableItems(namespace);
      } catch (err) {
        if (!ignore) {
          setNamespaceLoaded(true);
          setError(errorMessage(err));
        }
        return;
      }
      if (ignore) return;

      setFunctionItems(items);
      setNamespaceLoaded(true);
      setError('');
    }

    doLoad();
    return () => {
      ignore = true;
    };
  }, [isAuthenticated, connectionId, namespace]);

  const functionNames = useMemo(() => functionItems.map((item) => item.name), [functionItems]);

  const { functions: clusterFunctions, loaded: clusterLoaded } = useCluster(
    functionNames,
    // if namespace === #ALL_NS# then we pass 'undefined' to watcher which equals
    // to 'get resources from all namespaces'
    isAllNamespacesKey(namespace) ? undefined : namespace,
  );
  const buildStatuses = useBuildStatus();

  const functions = useMemo(
    () =>
      functionItems.map((item) => {
        // keyed by namespace/name - the same function name can exist in multiple namespaces
        const cf = clusterFunctions.get(`${item.namespace}/${item.name}`);
        const enriched = cf ? enrichItem(item, cf) : item;
        const build = buildStatuses.get(`${item.owner}/${item.repoName}`);
        return build ? mergeBuild(enriched, build) : enriched;
      }),
    [functionItems, clusterFunctions, buildStatuses],
  );

  const reposLoaded = !isAuthenticated || (namespaceLoaded && prevNamespace === namespace);
  const loaded = reposLoaded && clusterLoaded;

  const onEdit = (name: string) => navigate(`/faas/edit/${name}`);

  return {
    functions,
    loaded,
    refreshing,
    onEdit,
    onRefresh,
    isAuthenticated,
    error,
    showNamespace: isAllNamespacesKey(namespace),
  };
}

async function loadFunctionTableItems(namespace: string): Promise<FunctionTableItem[]> {
  const items = await listFunctions(namespace);
  return items.map((item) => newItem(item));
}

function newItem(item: FunctionListItem): FunctionTableItem {
  return {
    name: item.name || item.repoName,
    repoName: item.repoName,
    owner: item.owner,
    namespace: item.namespace,
    runtime: item.runtime,
    status: item.err ? 'Error' : 'NotDeployed',
    url: '',
    replicas: 0,
    source: item.source,
  };
}

function enrichItem(item: FunctionTableItem, cf: ClusterFunction): FunctionTableItem {
  return {
    ...item,
    status: cf.status,
    url: cf.url,
    replicas: cf.replicas,
    mainResource: cf.mainResource,
  };
}

function mergeBuild(item: FunctionTableItem, build: BuildStatus): FunctionTableItem {
  if (build.buildStatus === 'Building') {
    return { ...item, status: 'Building' };
  }
  if (build.buildStatus === 'Failed' && item.status !== 'Running') {
    return {
      ...item,
      status: 'BuildFailed',
      buildRunURL: build.runURL,
      failureReason: build.failureReason,
    };
  }
  // Succeeded / None: fall through to the cluster-derived status.
  return item;
}
