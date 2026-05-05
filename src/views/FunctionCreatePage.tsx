import { DocumentTitle, ListPageHeader } from '@openshift-console/dynamic-plugin-sdk';
import { Alert, PageSection } from '@patternfly/react-core';
import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom-v5-compat';
import { CreateFunctionForm, CreateFunctionFormData } from '../components/CreateFunctionForm';
import { UserAvatar } from '../components/UserAvatar';
import {
  ForgeConnectionContext,
  ForgeConnectionProvider,
} from '../context/ForgeConnectionProvider';
import { useClusterService } from '../services/cluster/useClusterService';
import { useFunctionService } from '../services/function/useFunctionService';
import { useSourceControlService } from '../services/source-control/useSourceControlService';
import { errorMessage } from '../utils/utils';

export default function FunctionCreatePage() {
  return (
    <ForgeConnectionProvider>
      <FunctionCreatePageContent />
    </ForgeConnectionProvider>
  );
}

function FunctionCreatePageContent() {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { isSubmitting, error, handleSubmit, handleCancel, isConnectedToForge } =
    useFunctionCreatePage();

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
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            isSubmitting={isSubmitting}
          />
        )}
      </PageSection>
    </>
  );
}

function useFunctionCreatePage(): {
  isSubmitting: boolean;
  error: string | null;
  handleSubmit: (data: CreateFunctionFormData) => Promise<void>;
  handleCancel: () => void;
  isConnectedToForge: boolean;
} {
  const navigate = useNavigate();
  const isConnectedToForge = useContext(ForgeConnectionContext).isActive;
  const functionService = useFunctionService();
  const sourceControl = useSourceControlService();
  const { generateKubeconfig } = useClusterService();

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

  return { isSubmitting, error, handleSubmit, handleCancel, isConnectedToForge };
}
