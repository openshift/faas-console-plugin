import {
  DocumentTitle,
  ListPageHeader,
  useActiveNamespace,
} from '@openshift-console/dynamic-plugin-sdk';
import { Alert, Bullseye, PageSection, Spinner } from '@patternfly/react-core';
import { useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  createFunction,
  getConfigMaps,
  getNamespaces,
  getSecrets,
} from '../../common/clients/functionsClient';
import { UserAvatar } from '../../common/components/UserAvatar';
import { AuthContext, AuthProvider } from '../../common/context/AuthProvider';
import { errorMessage } from '../../common/errors';
import { EnvVar, K8sKeyedResource, NamespaceOptions } from '../../common/types';
import { CreateFunctionForm } from './components/CreateFunctionForm';
import { CreateFunctionFormData, PlainEnvVar, ResourceEnvVar } from './types';

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
    submitError,
    namespacesError,
    resourcesError,
    handleSubmit,
    handleCancel,
    isAuthenticated,
    secrets,
    configMaps,
    resourcesNamespace,
    canCreateNamespaces,
    namespaces,
    systemNamespaces,
    initialNamespace,
    onPickNamespace,
    namespacesLoaded,
  } = useFunctionCreatePage();

  const renderContent = () => {
    if (!isAuthenticated || namespacesError) return null;

    if (!namespacesLoaded) {
      return (
        <Bullseye>
          <Spinner aria-label={t('Loading')} size="lg" />
        </Bullseye>
      );
    }
    return (
      <CreateFunctionForm
        secrets={secrets}
        configMaps={configMaps}
        resourcesNamespace={resourcesNamespace}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        onPickNamespace={onPickNamespace}
        isSubmitting={isSubmitting}
        canCreateNamespaces={canCreateNamespaces}
        namespaces={namespaces}
        systemNamespaces={systemNamespaces}
        initialNamespace={initialNamespace}
      />
    );
  };

  return (
    <>
      <DocumentTitle>{t('Create function')}</DocumentTitle>
      <ListPageHeader title={t('Create function')}>
        <UserAvatar />
      </ListPageHeader>
      <PageSection>
        {submitError && (
          <Alert variant="danger" title={t('Error creating function')} isInline>
            {submitError}
          </Alert>
        )}
        {namespacesError && (
          <Alert variant="danger" title={t('Error loading namespaces')} isInline>
            {namespacesError}
          </Alert>
        )}
        {resourcesError && (
          <Alert variant="danger" title={t('Error loading Secrets and ConfigMaps')} isInline>
            {resourcesError}
          </Alert>
        )}
        {renderContent()}
      </PageSection>
    </>
  );
}

function useFunctionCreatePage() {
  const navigate = useNavigate();
  const isAuthenticated = useContext(AuthContext).isAuthenticated;

  const {
    canCreateNamespaces,
    namespaces,
    systemNamespaces,
    loaded: namespacesLoaded,
    error: namespacesError,
  } = useNamespaceOptions();

  const [activeNamespace] = useActiveNamespace();
  const initialNamespace = resolveInitialNamespace(
    canCreateNamespaces,
    namespaces,
    systemNamespaces,
    activeNamespace,
  );

  // null until the user picks a namespace; until then the field shows the prefill.
  const [pickedNamespace, setPickedNamespace] = useState<string | null>(null);

  const {
    namespace: resourcesNamespace,
    secrets,
    configMaps,
    error: resourcesError,
  } = useSecretsAndConfigMaps(pickedNamespace ?? initialNamespace);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async (data: CreateFunctionFormData) => {
    setIsSubmitting(true);
    setSubmitError(null);

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
      setSubmitError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    navigate('/faas');
  };

  return {
    isSubmitting,
    submitError,
    namespacesError,
    resourcesError,
    handleSubmit,
    handleCancel,
    onPickNamespace: setPickedNamespace,
    isAuthenticated,
    secrets,
    configMaps,
    resourcesNamespace,
    canCreateNamespaces,
    namespaces,
    systemNamespaces,
    initialNamespace,
    namespacesLoaded,
  };
}

function resolveInitialNamespace(
  canCreateNamespaces: boolean,
  namespaces: string[],
  systemNamespaces: string[],
  activeNamespace: string,
): string {
  // The backend has already left out the namespaces this user may not pick. A system
  // namespace is never suggested, even to a user who may pick it.
  if (
    activeNamespace &&
    namespaces.includes(activeNamespace) &&
    !systemNamespaces.includes(activeNamespace)
  )
    return activeNamespace;
  if (!canCreateNamespaces && namespaces.length === 1) return namespaces[0];
  return '';
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

// The namespace choices a user is allowed to deploy into, as decided by the backend.
function useNamespaceOptions() {
  const [options, setOptions] = useState<NamespaceOptions>({
    namespaces: [],
    systemNamespaces: [],
    canCreateNamespaces: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        setOptions(await getNamespaces());
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  return { ...options, loaded, error };
}

interface NamespaceResources {
  namespace: string;
  secrets: K8sKeyedResource[];
  configMaps: K8sKeyedResource[];
  error?: string;
}

// The Secrets and ConfigMaps of namespace. The returned namespace says which namespace the
// lists belong to; it is empty until the current namespace has answered.
function useSecretsAndConfigMaps(namespace: string) {
  const [result, setResult] = useState<NamespaceResources>();

  useEffect(() => {
    if (!namespace) return;
    // The namespace changes as the user types, so a slow answer for an earlier
    // namespace must not land after the answer for the current one.
    let stale = false;

    (async () => {
      try {
        const [secrets, configMaps] = await Promise.all([
          getSecrets(namespace),
          getConfigMaps(namespace),
        ]);
        if (!stale) setResult({ namespace, secrets, configMaps });
      } catch (err) {
        if (!stale) setResult({ namespace, secrets: [], configMaps: [], error: errorMessage(err) });
      }
    })();

    return () => {
      stale = true;
    };
  }, [namespace]);

  if (result?.namespace !== namespace) return { namespace: '', secrets: [], configMaps: [] };
  return result;
}
