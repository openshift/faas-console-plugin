import {
  DocumentTitle,
  isAllNamespacesKey,
  ListPageHeader,
  NamespaceBar,
  useActiveNamespace,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  AlertActionCloseButton,
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
import { ClusterFunction, FunctionListItem } from '../../common/types';
import { useCluster } from '../../common/clients/useCluster';
import { deployFunction, listFunctions } from '../../common/clients/functionsClient';
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
    onDeploy,
    onRefresh,
    isAuthenticated,
    alert,
    onAlertClose,
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
        {alert && (
          <Alert
            variant={alert.variant}
            title={alert.title}
            isInline
            className="pf-v6-u-mb-md"
            timeout={alert.variant === 'success' ? 5000 : false}
            onTimeout={onAlertClose}
            actionClose={
              <AlertActionCloseButton onClose={onAlertClose} aria-label={t('Close alert')} />
            }
          />
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
            <FunctionTable
              functions={functions}
              onEdit={onEdit}
              onDeploy={onDeploy}
              showNamespace={showNamespace}
            />
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
  onDeploy: (item: FunctionTableItem) => void;
  onRefresh: () => void;
  isAuthenticated: boolean;
  alert: { variant: 'success' | 'danger'; title: string } | null;
  onAlertClose: () => void;
  showNamespace: boolean;
} {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { isAuthenticated, connectionId } = useContext(AuthContext);
  const navigate = useNavigate();

  const [namespace] = useActiveNamespace();

  const [functionItems, setFunctionItems] = useState<FunctionTableItem[]>([]);
  const [namespaceLoaded, setNamespaceLoaded] = useState(isAuthenticated ? false : true);
  const [prevNamespace, setPrevNamespace] = useState(namespace);

  const [prevConnectionId, setPrevConnectionId] = useState(connectionId);

  const [alert, setAlert] = useState<{ variant: 'success' | 'danger'; title: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Reset state when connection changes (initial connect or user switch)
  if (connectionId !== prevConnectionId) {
    setPrevConnectionId(connectionId);
    setFunctionItems([]);
    setAlert(null);
    setNamespaceLoaded(false);
  }

  // Reset state when namespace changes
  if (namespace !== prevNamespace) {
    setPrevNamespace(namespace);
    setFunctionItems([]);
    setAlert(null);
    setNamespaceLoaded(false);
  }

  async function onRefresh() {
    if (!isAuthenticated) return;
    setRefreshing(true);

    try {
      const items = await loadFunctionTableItems(namespace);
      setFunctionItems(items);
      setNamespaceLoaded(true);
      setAlert(null);
    } catch (err) {
      setAlert({ variant: 'danger', title: errorMessage(err) });
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
          setAlert({ variant: 'danger', title: errorMessage(err) });
        }
        return;
      }
      if (ignore) return;

      setFunctionItems(items);
      setNamespaceLoaded(true);
      setAlert(null);
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

  const functions = useMemo(
    () =>
      functionItems.map((item) => {
        // keyed by namespace/name - the same function name can exist in multiple namespaces
        const cf = clusterFunctions.get(`${item.namespace}/${item.name}`);
        return cf ? enrichItem(item, cf) : item;
      }),
    [functionItems, clusterFunctions],
  );

  const reposLoaded = !isAuthenticated || (namespaceLoaded && prevNamespace === namespace);
  const loaded = reposLoaded && clusterLoaded;

  const onEdit = (name: string) => navigate(`/faas/edit/${name}`);

  const onAlertClose = () => setAlert(null);

  const onDeploy = async (item: FunctionTableItem) => {
    try {
      await deployFunction(item.owner, item.repoName, item.branch);
      setAlert({
        variant: 'success',
        title: t('Deploy started for {{name}}. It can take a few minutes.', {
          name: item.name,
        }),
      });
    } catch (err) {
      setAlert({
        variant: 'danger',
        title: t('Failed to deploy {{name}}: {{error}}', {
          name: item.name,
          error: errorMessage(err),
        }),
      });
    }
  };

  return {
    functions,
    loaded,
    refreshing,
    onEdit,
    onDeploy,
    onRefresh,
    isAuthenticated,
    alert,
    onAlertClose,
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
    branch: item.defaultBranch,
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
