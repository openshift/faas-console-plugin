import {
  K8sResourceKind,
  SuccessStatus,
  ProgressStatus,
  ErrorStatus,
  InfoStatus,
  StatusIconAndText,
  useDeleteModal,
} from '@openshift-console/dynamic-plugin-sdk';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import { ExclamationTriangleIcon, PencilAltIcon, TrashIcon } from '@patternfly/react-icons';
import { ActionList, ActionListItem, Button } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';

export interface FunctionTableItem {
  name: string;
  repoName: string;
  runtime: string;
  status: FunctionStatus;
  url?: string;
  replicas: number;
  namespace: string;
  deployment?: K8sResourceKind;
}

export type FunctionStatus =
  | 'CreatingRepo'
  | 'Pushing'
  | 'PushedToGitHub'
  | 'Deploying'
  | 'Running'
  | 'ScaledToZero'
  | 'Error'
  | 'Unknown'
  | 'NotDeployed';

export function FunctionTable({
  functions,
  onEdit,
}: {
  functions: FunctionTableItem[];
  onEdit: (name: string) => void;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  const columns = [
    t('Name'),
    t('Namespace'),
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
          <Tr key={fn.name}>
            <Td dataLabel={t('Name')}>{fn.name}</Td>
            <Td dataLabel={t('Namespace')}>
              <TextOrDash value={fn.namespace} />
            </Td>
            <Td dataLabel={t('Runtime')}>{fn.runtime}</Td>
            <Td dataLabel={t('Status')}>
              <StatusCell status={fn.status} />
            </Td>
            <Td dataLabel={t('URL')}>
              <UrlCell url={fn.url} />
            </Td>
            <Td dataLabel={t('Replicas')}>{fn.replicas}</Td>
            <Td dataLabel={t('Actions')} isActionCell>
              <ActionList isIconList>
                <ActionListItem>
                  <Button
                    variant="plain"
                    aria-label={t('Edit')}
                    icon={<PencilAltIcon />}
                    onClick={() => onEdit(fn.repoName)}
                  />
                </ActionListItem>
                <ActionListItem>
                  <DeleteActionButton deployment={fn.deployment} />
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
      return <SuccessStatus title={status} />;
    case 'Deploying':
    case 'CreatingRepo':
    case 'Pushing':
    case 'PushedToGitHub':
      return <ProgressStatus title={status} />;
    case 'Error':
      return <ErrorStatus title={status} />;
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

function DeleteActionButton({ deployment }: { deployment?: K8sResourceKind }) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const launchDelete = useDeleteModal(
    deployment as K8sResourceKind,
    undefined,
    undefined,
    t('Undeploy'),
  );

  return (
    <Button
      variant="plain"
      aria-label={t('Delete')}
      icon={<TrashIcon />}
      isDisabled={!deployment}
      onClick={() => launchDelete()}
    />
  );
}
