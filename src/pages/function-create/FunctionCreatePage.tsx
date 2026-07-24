import { DocumentTitle, ListPageHeader } from '@openshift-console/dynamic-plugin-sdk';
import { Alert, PageSection } from '@patternfly/react-core';
import { useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { CreateFunctionForm, CreateFunctionFormData } from './components/CreateFunctionForm';
import { UserAvatar } from '../../common/components/UserAvatar';
import {
  ForgeConnectionContext,
  ForgeConnectionProvider,
} from '../../common/context/ForgeConnectionProvider';
import { useClusterService } from '../../common/services/cluster/useClusterService';
import { useFunctionService } from '../../common/services/function/useFunctionService';
import { useSourceControlService } from '../../common/services/source-control/useSourceControlService';
import { EnvVar, K8sKeyedResource, PlainEnvVar, ResourceEnvVar } from '../../common/services/types';
import { errorMessage } from '../../common/utils/utils';

export default function FunctionCreatePage() {
  return (
    <ForgeConnectionProvider>
      <FunctionCreatePageContent />
    </ForgeConnectionProvider>
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
    onNamespaceChange,
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
  handleSubmit: (data: CreateFunctionFormData) => Promise<void>;
  handleCancel: () => void;
  onNamespaceChange: (namespace: string) => void;
} {
  const navigate = useNavigate();
  const isConnectedToForge = useContext(ForgeConnectionContext).isActive;
  const functionService = useFunctionService();
  const sourceControl = useSourceControlService();
  const [namespace, setNamespace] = useState('');
  const debouncedNamespace = useDebouncedValue(namespace, 300);
  const { secrets, configMaps, generateKubeconfig } = useClusterService([], debouncedNamespace);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (data: CreateFunctionFormData) => {
    setIsSubmitting(true);
    setError(null);

    try {
      const files = await functionService.generateFunction({
        name: data.name,
        runtime: data.runtime,
        registry: data.registry,
        namespace: data.namespace,
        branch: data.branch,
        envVars: toEnvVars(data.plainEnvVars, data.secretEnvVars, data.configMapEnvVars),
      });

      const repo = { owner: data.owner, name: data.repo, url: '', defaultBranch: data.branch };

      const kubeconfig = await generateKubeconfig(data.namespace);
      await sourceControl.createRepoWithSecret(repo, files, 'Initialize Knative function project', {
        name: 'KUBECONFIG',
        value: kubeconfig,
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
    onNamespaceChange: setNamespace,
  };
}

function toEnvVars(
  plain: PlainEnvVar[],
  secrets: ResourceEnvVar[],
  configMaps: ResourceEnvVar[],
): EnvVar[] | undefined {
  const result = [
    ...plain.map((e) => ({
      name: e.name,
      source: 'value' as const,
      value: e.value,
      resourceName: '',
      resourceKey: '',
    })),
    ...secrets.map((e) => ({
      name: e.name,
      source: 'secret' as const,
      value: '',
      resourceName: e.resourceName,
      resourceKey: e.resourceKey,
    })),
    ...configMaps.map((e) => ({
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
