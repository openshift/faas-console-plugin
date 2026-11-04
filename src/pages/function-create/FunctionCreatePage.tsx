import {
  DocumentTitle,
  K8sResourceKind,
  ListPageHeader,
  useK8sWatchResource,
  WatchK8sResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { Alert, Bullseye, PageSection, Spinner } from '@patternfly/react-core';
import { useContext, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { createFunction } from '../../common/clients/functionsClient';
import { useNamespaceOptions } from '../../common/clients/useNamespaceOptions';
import { UserAvatar } from '../../common/components/UserAvatar';
import { AuthContext, AuthProvider } from '../../common/context/AuthProvider';
import { errorMessage } from '../../common/errors';
import { EnvVar } from '../../common/types';
import { CreateFunctionForm } from './components/CreateFunctionForm';
import { CreateFunctionFormData, K8sKeyedResource, PlainEnvVar, ResourceEnvVar } from './types';

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
    isAuthenticated,
    secrets,
    configMaps,
    canCreateNamespaces,
    namespaces,
    setNamespaceWatchField,
    namespacesLoaded,
  } = useFunctionCreatePage();

  return (
    <>
      <DocumentTitle>{t('Create function')}</DocumentTitle>
      <ListPageHeader title={t('Create function')}>
        <UserAvatar />
      </ListPageHeader>
      <PageSection>
        {error && (
          <Alert variant="danger" title={t('Error creating function')} isInline>
            {error}
          </Alert>
        )}
        {isAuthenticated &&
          (!namespacesLoaded ? (
            <Bullseye>
              <Spinner aria-label={t('Loading')} size="lg" />
            </Bullseye>
          ) : (
            <CreateFunctionForm
              secrets={secrets}
              configMaps={configMaps}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              setNamespaceWatchField={setNamespaceWatchField}
              isSubmitting={isSubmitting}
              canCreateNamespaces={canCreateNamespaces}
              namespaces={namespaces}
            />
          ))}
      </PageSection>
    </>
  );
}

function useFunctionCreatePage(): {
  secrets: K8sKeyedResource[];
  configMaps: K8sKeyedResource[];
  isSubmitting: boolean;
  isAuthenticated: boolean;
  error: string | null;
  canCreateNamespaces: boolean;
  namespaces: string[];
  namespacesLoaded: boolean;
  handleSubmit: (data: CreateFunctionFormData) => Promise<void>;
  handleCancel: () => void;
  setNamespaceWatchField: (namespace: string) => void;
} {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const navigate = useNavigate();
  const isAuthenticated = useContext(AuthContext).isAuthenticated;

  const {
    canCreateNamespaces,
    namespaces,
    loaded: namespacesLoaded,
    error: namespacesError,
  } = useNamespaceOptions();

  const [namespaceWatchField, setNamespaceWatchField] = useState('');

  const {
    secrets,
    configMaps,
    error: clusterResourcesError,
  } = useSecretsAndConfigMaps(namespaceWatchField);

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
      setError(errorMessage(err));
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
    setNamespaceWatchField,
    isAuthenticated,
    secrets,
    configMaps,
    canCreateNamespaces,
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

function useSecretsAndConfigMaps(namespace?: string): {
  secrets: K8sKeyedResource[];
  configMaps: K8sKeyedResource[];
  error: Error | undefined;
} {
  const secretConfig = useMemo(() => newDataWatchConfig('Secret', namespace), [namespace]);
  const configMapConfig = useMemo(() => newDataWatchConfig('ConfigMap', namespace), [namespace]);

  const [rawSecrets, , secretsError] = useK8sWatchResource<K8sResourceKind[]>(secretConfig);
  const [rawConfigMaps, , configMapsError] =
    useK8sWatchResource<K8sResourceKind[]>(configMapConfig);

  const secrets = useMemo(() => toKeyedResources(rawSecrets), [rawSecrets]);
  const configMaps = useMemo(() => toKeyedResources(rawConfigMaps), [rawConfigMaps]);

  return { secrets, configMaps, error: secretsError || configMapsError };
}

function newDataWatchConfig(kind: string, namespace?: string): WatchK8sResource | null {
  return namespace ? { groupVersionKind: { version: 'v1', kind }, namespace, isList: true } : null;
}

function toKeyedResources(resources: K8sResourceKind[]): K8sKeyedResource[] {
  return (resources ?? [])
    .filter((r) => r.metadata?.name)
    .map((r) => ({
      name: r.metadata!.name!,
      keys: r.data ? Object.keys(r.data) : [],
    }));
}
