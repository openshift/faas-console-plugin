import { DocumentTitle, ListPageHeader } from '@openshift-console/dynamic-plugin-sdk';
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
import { UserAvatar } from '../../common/components/UserAvatar';
import { AuthContext, AuthProvider } from '../../common/context/AuthProvider';
import { ClusterFunction, FunctionListItem } from '../../common/services/types';
import { useClusterService } from '../../common/services/cluster/useClusterService';
import { useFunctionService } from '../../common/services/function/useFunctionService';
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
  const { functions, loaded, refreshing, onEdit, onRefresh, isConnectedToForge, error } =
    useFunctionListPage();

  return (
    <>
      <DocumentTitle>{t('Functions')}</DocumentTitle>
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
          <FunctionsEmptyState isCreateDisabled={!isConnectedToForge} />
        )}
        {loaded && functions.length > 0 && (
          <>
            <Content component={ContentVariants.p}>
              {t(
                'Serverless functions in your repository and deployed to your cluster. Manage lifecycle, monitor status, and scale on demand.',
              )}
            </Content>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  {!isConnectedToForge ? (
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
            <FunctionTable functions={functions} onEdit={onEdit} />
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
  isConnectedToForge: boolean;
  error: string;
} {
  const { isAuthenticated: isConnectedToForge, connectionId } = useContext(AuthContext);
  const functionService = useFunctionService();
  const navigate = useNavigate();

  const [functionItems, setFunctionItems] = useState<FunctionTableItem[]>([]);
  const [reposLoaded, setReposLoaded] = useState(!isConnectedToForge);
  const [prevConnectionId, setPrevConnectionId] = useState(connectionId);

  const [error, setError] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);

  // Reset state when connection changes (initial connect or user switch)
  if (connectionId !== prevConnectionId) {
    setPrevConnectionId(connectionId);
    setFunctionItems([]);
    setError('');
    setReposLoaded(false);
  }

  async function onRefresh() {
    if (!isConnectedToForge) return;
    setRefreshing(true);

    try {
      const items = await loadFunctionTableItems(functionService);
      setFunctionItems(items);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReposLoaded(true);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!isConnectedToForge) return;

    let ignore = false;

    async function doLoad() {
      let items: FunctionTableItem[];

      try {
        items = await loadFunctionTableItems(functionService);
      } catch (err) {
        if (!ignore) {
          setReposLoaded(true);
          setError(errorMessage(err));
        }
        return;
      }
      if (ignore) return;

      setFunctionItems(items);
      setReposLoaded(true);
      setError('');
    }

    doLoad();
    return () => {
      ignore = true;
    };
  }, [functionService, isConnectedToForge, connectionId]);

  const functionNames = useMemo(() => functionItems.map((item) => item.name), [functionItems]);

  const { functions: clusterFunctions, loaded: clusterLoaded } = useClusterService(functionNames);

  const functions = useMemo(
    () =>
      functionItems.map((item) => {
        const cf = clusterFunctions.get(item.name);
        return cf ? enrichItem(item, cf) : item;
      }),
    [functionItems, clusterFunctions],
  );

  const loaded = reposLoaded && clusterLoaded;

  const onEdit = (name: string) => navigate(`/faas/edit/${name}`);
  return {
    functions,
    loaded,
    refreshing,
    onEdit,
    onRefresh,
    isConnectedToForge,
    error,
  };
}

interface FunctionServiceLike {
  listFunctions(): Promise<FunctionListItem[]>;
}

async function loadFunctionTableItems(svc: FunctionServiceLike): Promise<FunctionTableItem[]> {
  const items = await svc.listFunctions();
  return items.map((item) =>
    newItem(item.name || item.repoName, item.repoName, item.namespace, item.runtime),
  );
}

function newItem(
  name: string,
  repoName: string,
  namespace: string,
  runtime: string,
): FunctionTableItem {
  return {
    name,
    repoName,
    namespace,
    runtime,
    status: 'NotDeployed' as const,
    url: '',
    replicas: 0,
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
