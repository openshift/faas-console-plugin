import { DocumentTitle, ListPageHeader } from '@openshift-console/dynamic-plugin-sdk';
import { Alert, PageSection } from '@patternfly/react-core';
import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { createFunction } from '../../common/clients/functionsClient';
import { useCluster } from '../../common/clients/useCluster';
import { useNamespaceOptions } from '../../common/clients/useNamespaceOptions';
import { UserAvatar } from '../../common/components/UserAvatar';
import { AuthContext, AuthProvider } from '../../common/context/AuthProvider';
import { EnvVar, K8sKeyedResource, PlainEnvVar, ResourceEnvVar } from '../../common/types';
import { handleErrorMessage } from '../../common/utils/utils';
import { CreateFunctionForm, CreateFunctionFormData } from './components/CreateFunctionForm';

export default function FunctionCreatePage() {
  return (
    <AuthProvider>
      <FunctionCreatePageContent />
    </AuthProvider>
  );
}

function FunctionCreatePageContent() {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const {
    isSubmitting,
    error,
    handleSubmit,
    handleCancel,
    isConnectedToForge,
    secrets,
    configMaps,
    canCreateNamespaces,
    namespaces,
    onNamespaceChange,
    namespacesLoaded,
  } = useFunctionCreatePage();

  return (
    <>
      <DocumentTitle>{t('Create function')}</DocumentTitle>
      <ListPageHeader title={t('Create function')}>
        <UserAvatar enableReconnect={false} />
      </ListPageHeader>
      <PageSection>
        {!isConnectedToForge && (
          <Alert
            variant="warning"
            title={t(
              "A GitHub Personal Access Token is required to create functions. Go to the Functions page and click 'Connect to GitHub' to connect.",
            )}
            isInline
          />
        )}
        {error && (
          <Alert variant="danger" title={t('Error creating function')} isInline>
            {error}
          </Alert>
        )}
        {isConnectedToForge && (
          <CreateFunctionForm
            secrets={secrets}
            configMaps={configMaps}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            onNamespaceChange={onNamespaceChange}
            isSubmitting={isSubmitting}
            canCreateNamespaces={canCreateNamespaces}
            namespaces={namespaces}
            namespacesLoaded={namespacesLoaded}
          />
        )}
      </PageSection>
    </>
  );
}

function useFunctionCreatePage(): {
  secrets: K8sKeyedResource[];
  configMaps: K8sKeyedResource[];
  isSubmitting: boolean;
  isConnectedToForge: boolean;
  error: string | null;
  canCreateNamespaces: boolean;
  namespaces: string[];
  namespacesLoaded: boolean;
  inputNamespace: string;
  handleSubmit: (data: CreateFunctionFormData) => Promise<void>;
  handleCancel: () => void;
  onNamespaceChange: (namespace: string) => void;
} {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const navigate = useNavigate();
  const isConnectedToForge = useContext(AuthContext).isAuthenticated;

  const {
    canCreateNamespaces,
    namespaces,
    loaded: namespacesLoaded,
    error: namespacesError,
  } = useNamespaceOptions();

  const [inputNamespace, setInputNamespace] = useState('');

  // //input namespace is debounced before being used to watch for secrets and configmaps
  // const watchedNamespace = useDebouncedValue(inputNamespace, 500);

  const {
    secrets,
    configMaps,
    error: clusterResourcesError,
  } = useCluster({
    functionNames: [],
    namespace: inputNamespace,
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clusterResourcesErrorMessage =
    namespacesError || clusterResourcesError ? t('Error loading cluster resources') : null;

  const handleSubmit = async (data: CreateFunctionFormData) => {
    setIsSubmitting(true);
    setError(null);

    try {
      await createFunction({
        name: data.name,
        runtime: data.runtime,
        registry: data.registry,
        namespace: data.namespace,
        branch: data.branch,
        owner: data.owner,
        repo: data.repo,
        envVars: toEnvVars(data.plainEnvVars, data.secretEnvVars, data.configMapEnvVars),
      });

      navigate('/faas');
    } catch (err) {
      setError(handleErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    navigate('/faas');
  };

  return {
    isSubmitting,
    error: error || clusterResourcesErrorMessage,
    handleSubmit,
    handleCancel,
    isConnectedToForge,
    secrets,
    configMaps,
    canCreateNamespaces,
    inputNamespace,
    onNamespaceChange: setInputNamespace,
    namespaces,
    namespacesLoaded,
  };
}

function toEnvVars(
  plain: PlainEnvVar[],
  secrets: ResourceEnvVar[],
  configMaps: ResourceEnvVar[],
): EnvVar[] | undefined {
  const result = [
    ...plain
      .filter((e) => e.name && e.value)
      .map((e) => ({
        name: e.name,
        source: 'value' as const,
        value: e.value,
        resourceName: '',
        resourceKey: '',
      })),
    ...secrets
      .filter((e) => e.name && e.resourceName && e.resourceKey)
      .map((e) => ({
        name: e.name,
        source: 'secret' as const,
        value: '',
        resourceName: e.resourceName,
        resourceKey: e.resourceKey,
      })),
    ...configMaps
      .filter((e) => e.name && e.resourceName && e.resourceKey)
      .map((e) => ({
        name: e.name,
        source: 'configMap' as const,
        value: '',
        resourceName: e.resourceName,
        resourceKey: e.resourceKey,
      })),
  ];
  return result.length > 0 ? result : undefined;
}
