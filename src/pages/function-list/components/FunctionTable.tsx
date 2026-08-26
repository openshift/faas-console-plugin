import {
  ErrorStatus,
  InfoStatus,
  K8sResourceCommon,
  ProgressStatus,
  StatusIconAndText,
  SuccessStatus,
  useDeleteModal,
} from '@openshift-console/dynamic-plugin-sdk';
import { ActionList, ActionListItem, Button, Tooltip } from '@patternfly/react-core';
import { ExclamationTriangleIcon, PencilAltIcon, TrashIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useTranslation } from 'react-i18next';
import { FunctionSource, FunctionStatus } from '../../../common/types';

export interface FunctionTableItem {
  name: string;
  repoName: string;
  owner: string;
  runtime: string;
  status: FunctionStatus;
  url: string;
  replicas: number;
  namespace: string;
  source: FunctionSource;
  mainResource?: K8sResourceCommon;
  buildRunURL?: string;
  failureReason?: string;
}

export function FunctionTable({
  functions,
  onEdit,
  showNamespace,
}: {
  functions: FunctionTableItem[];
  onEdit: (name: string) => void;
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
              <StatusCell
                status={fn.status}
                failureReason={fn.failureReason}
                buildRunURL={fn.buildRunURL}
              />
            </Td>
            <Td dataLabel={t('URL')}>
              <UrlCell url={fn.url} />
            </Td>
            <Td dataLabel={t('Replicas')}>{fn.replicas}</Td>
            <Td dataLabel={t('Actions')} isActionCell>
              <ActionList isIconList>
                <ActionListItem>
                  <EditActionButton source={fn.source} repoName={fn.repoName} onEdit={onEdit} />
                </ActionListItem>
                <ActionListItem>
                  <DeleteActionButton mainResource={fn.mainResource} />
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

function StatusCell({
  status,
  failureReason,
  buildRunURL,
}: {
  status: FunctionStatus;
  failureReason?: string;
  buildRunURL?: string;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  switch (status) {
    case 'Running':
      return <SuccessStatus title={status} />;
    case 'Building':
    case 'Deploying':
    case 'CreatingRepo':
    case 'Pushing':
    case 'PushedToGitHub':
      return <ProgressStatus title={status} />;
    case 'Error':
      return <ErrorStatus title={status} />;
    case 'BuildFailed': {
      const badge = <ErrorStatus title={status} />;
      const withLink = buildRunURL ? (
        <a href={buildRunURL} target="_blank" rel="noopener noreferrer">
          {badge}
        </a>
      ) : (
        badge
      );
      return <Tooltip content={failureReason || t('Build failed')}>{withLink}</Tooltip>;
    }
    case 'ScaledToZero':
    case 'NotDeployed':
      return <InfoStatus title={status} />;
    case 'Unknown':
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
      variant="plain"
      aria-label={t('Edit')}
      icon={<PencilAltIcon />}
      isAriaDisabled={isDisabled}
      onClick={() => {
        if (!isDisabled) onEdit(repoName);
      }}
    />
  );

  if (!isDisabled) return button;

  return <Tooltip content={t('No source repository to edit')}>{button}</Tooltip>;
}

function DeleteActionButton({ mainResource }: { mainResource?: K8sResourceCommon }) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const launchDelete = useDeleteModal(
    mainResource as K8sResourceCommon,
    undefined,
    undefined,
    t('Undeploy'),
  );

  return (
    <Button
      variant="plain"
      aria-label={t('Delete')}
      icon={<TrashIcon />}
      isDisabled={!mainResource}
      onClick={() => launchDelete()}
    />
  );
}
