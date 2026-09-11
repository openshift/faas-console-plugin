import {
  ErrorStatus,
  InfoStatus,
  K8sResourceCommon,
  ProgressStatus,
  StatusIconAndText,
  SuccessStatus,
  useDeleteModal,
} from '@openshift-console/dynamic-plugin-sdk';
import { ActionList, ActionListItem, Button, Content, Tooltip } from '@patternfly/react-core';
import {
  ExclamationTriangleIcon,
  PencilAltIcon,
  PlayIcon,
  PowerOffIcon,
} from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useTranslation } from 'react-i18next';
import { FunctionSource, FunctionStatus } from '../../../common/types';

export interface FunctionTableItem {
  name: string;
  repoName: string;
  owner: string;
  branch: string;
  runtime: string;
  status: FunctionStatus;
  url: string;
  replicas: number;
  namespace: string;
  source: FunctionSource;
  mainResource?: K8sResourceCommon;
}

export function FunctionTable({
  functions,
  onEdit,
  onDeploy,
  showNamespace,
}: {
  functions: FunctionTableItem[];
  onEdit: (name: string) => void;
  onDeploy: (item: FunctionTableItem) => void;
  showNamespace: boolean;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  const columns = [
    t('Name'),
    ...(showNamespace ? [t('Namespace')] : []),
    t('Runtime'),
    t('Status'),
    t('URL'),
    t('Replicas'),
    t('Actions'),
  ];

  return (
    <Table aria-label={t('Functions')} isStriped>
      <Thead>
        <Tr>
          {columns.map((col) => (
            <Th key={col}>{col}</Th>
          ))}
        </Tr>
      </Thead>
      <Tbody>
        {functions.map((fn) => (
          <Tr key={`${fn.namespace}/${fn.name}`}>
            <Td dataLabel={t('Name')}>{fn.name}</Td>
            {showNamespace && (
              <Td dataLabel={t('Namespace')}>
                <TextOrDash value={fn.namespace} />
              </Td>
            )}
            <Td dataLabel={t('Runtime')}>
              <TextOrDash value={fn.runtime} />
            </Td>
            <Td dataLabel={t('Status')}>
              <StatusCell status={fn.status} />
            </Td>
            <Td dataLabel={t('URL')}>
              <UrlCell url={fn.url} />
            </Td>
            <Td dataLabel={t('Replicas')}>{fn.replicas}</Td>
            <Td dataLabel={t('Actions')} isActionCell style={{ verticalAlign: 'middle' }}>
              <ActionList isIconList>
                <ActionListItem>
                  <EditActionButton source={fn.source} repoName={fn.repoName} onEdit={onEdit} />
                </ActionListItem>
                <ActionListItem>
                  <DeployToggleButton item={fn} onDeploy={onDeploy} />
                </ActionListItem>
              </ActionList>
            </Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}

function TextOrDash({ value }: { value?: string }) {
  return <>{value || '—'}</>;
}

function StatusCell({ status }: { status: FunctionStatus }) {
  switch (status) {
    case 'Running':
    case 'ScaledToZero':
      return <SuccessStatus title={status} />;
    case 'Deploying':
    case 'CreatingRepo':
    case 'Pushing':
    case 'PushedToGitHub':
      return <ProgressStatus title={status} />;
    case 'Error':
      return <ErrorStatus title={status} />;
    case 'NotDeployed':
      return <InfoStatus title={status} />;
    case 'Unknown':
    default:
      return <StatusIconAndText title={status} icon={<ExclamationTriangleIcon />} />;
  }
}

function UrlCell({ url }: { url?: string }) {
  if (!url) return <TextOrDash />;

  const hostname = new URL(url).hostname.split('.')[0];
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {hostname}
    </a>
  );
}

function EditActionButton({
  source,
  repoName,
  onEdit,
}: {
  source: FunctionSource;
  repoName: string;
  onEdit: (name: string) => void;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const isDisabled = source === 'cluster';

  const button = (
    <Button
      variant="secondary"
      aria-label={t('Edit')}
      icon={<PencilAltIcon />}
      isAriaDisabled={isDisabled}
      size="sm"
      onClick={() => {
        if (!isDisabled) onEdit(repoName);
      }}
      isCircle
    />
  );

  if (!isDisabled) return button;

  return <Tooltip content={t('No source repository to edit')}>{button}</Tooltip>;
}

function DeployToggleButton({
  item,
  onDeploy,
}: {
  item: FunctionTableItem;
  onDeploy: (item: FunctionTableItem) => void;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  const launchUndeploy = useDeleteModal(
    item.mainResource as K8sResourceCommon,
    undefined,
    <Content component="p">
      {t(
        'Undeploying removes the running function and its Knative Service from the cluster. The GitHub repository and its code remain, so you can redeploy it later.',
      )}
    </Content>,
    t('Undeploy'),
  );

  const deployed = item.status === 'Running' || item.status === 'ScaledToZero';
  const hasRepo = item.source !== 'cluster' && item.repoName !== '';
  const deployable = (item.status === 'NotDeployed' || item.status === 'Error') && hasRepo;

  if (deployed) {
    return (
      <Button
        variant="secondary"
        isDanger
        aria-label={t('Undeploy')}
        icon={<PowerOffIcon />}
        onClick={() => launchUndeploy()}
        size="sm"
        isCircle
      />
    );
  }

  if (deployable) {
    return (
      <Button
        variant="secondary"
        aria-label={t('Deploy')}
        icon={<PlayIcon />}
        onClick={() => onDeploy(item)}
        size="sm"
        isCircle
      />
    );
  }

  const disabledTooltip =
    (item.status === 'NotDeployed' || item.status === 'Error') && !hasRepo
      ? t('No source repository to deploy')
      : t('Function is not ready to deploy yet');

  return (
    <Tooltip content={disabledTooltip}>
      <Button
        variant="secondary"
        aria-label={t('Deploy')}
        icon={<PlayIcon />}
        isAriaDisabled
        size="sm"
        isCircle
      />
    </Tooltip>
  );
}
