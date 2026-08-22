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
import { ClusterFunction, FunctionListItem } from '../../common/types';
import { useCluster } from '../../common/clients/useCluster';
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
  const { functions, loaded, refreshing, onEdit, onRefresh, isAuthenticated, error } =
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
          <FunctionsEmptyState isCreateDisabled={!isAuthenticated} />
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
  isAuthenticated: boolean;
  error: string;
} {
  const { isAuthenticated, connectionId } = useContext(AuthContext);
  const navigate = useNavigate();

  const [functionItems, setFunctionItems] = useState<FunctionTableItem[]>([]);
  const [reposLoaded, setReposLoaded] = useState(!isAuthenticated);
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
    if (!isAuthenticated) return;
    setRefreshing(true);

    try {
      const items = await loadFunctionTableItems();
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
    if (!isAuthenticated) return;

    let ignore = false;

    async function doLoad() {
      let items: FunctionTableItem[];

      try {
        items = await loadFunctionTableItems();
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
  }, [isAuthenticated, connectionId]);

  const functionNames = useMemo(() => functionItems.map((item) => item.name), [functionItems]);

  const { functions: clusterFunctions, loaded: clusterLoaded } = useCluster(functionNames);

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
    isAuthenticated,
    error,
  };
}

async function loadFunctionTableItems(): Promise<FunctionTableItem[]> {
  const items = await listFunctions();
  return items.map((item) => newItem(item));
}

function newItem(item: FunctionListItem): FunctionTableItem {
  return {
    name: item.name || item.repoName,
    repoName: item.repoName,
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
