import { DocumentTitle, ListPageHeader } from '@openshift-console/dynamic-plugin-sdk';
import { Alert, PageSection } from '@patternfly/react-core';
import { useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { createFunction } from '../../common/clients/functionsClient';
import { useCluster } from '../../common/clients/useCluster';
import { useNamespaceOptions } from '../../common/clients/useNamespaceOptions';
import { UserAvatar } from '../../common/components/UserAvatar';
import { AuthContext, AuthProvider } from '../../common/context/AuthProvider';
import { EnvVar, K8sKeyedResource, PlainEnvVar, ResourceEnvVar } from '../../common/types';
import { errorMessage } from '../../common/utils/utils';
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
    namespaceMissing,
    onNamespaceChange,
    inputNamespace,
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
            inputNamespace={inputNamespace}
            isSubmitting={isSubmitting}
            canCreateNamespaces={canCreateNamespaces}
            namespaces={namespaces}
            namespaceMissing={namespaceMissing}
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
  namespaceMissing: boolean;
  inputNamespace: string;
  handleSubmit: (data: CreateFunctionFormData) => Promise<void>;
  handleCancel: () => void;
  onNamespaceChange: (namespace: string) => void;
} {
  const navigate = useNavigate();
  const isConnectedToForge = useContext(AuthContext).isAuthenticated;

  const { canCreateNamespaces, namespaces } = useNamespaceOptions();

  // The only namespace state on the page. Everything below it is derived, and the form and
  // the namespace field are fully controlled from here; neither keeps a copy.
  const [inputNamespace, setInputNamespace] = useState('');

  // A developer with a single accessible namespace gets a disabled input, so there is no
  // edit to react to; their namespace is derived from the list rather than typed.
  const effectiveNamespace =
    !canCreateNamespaces && namespaces.length === 1 ? namespaces[0] : inputNamespace;

  // Only the namespace-scoped watch is debounced. The value handed to the form is always
  // the live one, so the input never lags behind or reverts what the user typed.
  const debouncedNamespace = useDebouncedValue(effectiveNamespace, 500);

  const { secrets, configMaps } = useCluster({
    functionNames: [],
    namespace: debouncedNamespace,
  });

  const trimmed = debouncedNamespace.trim();
  const namespaceMissing =
    canCreateNamespaces && !!trimmed && namespaces.length > 0 && !namespaces.includes(trimmed);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    error,
    handleSubmit,
    handleCancel,
    isConnectedToForge,
    secrets,
    configMaps,
    canCreateNamespaces,
    inputNamespace: effectiveNamespace,
    onNamespaceChange: setInputNamespace,
    namespaces,
    namespaceMissing,
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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
