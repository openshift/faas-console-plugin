import {
  ErrorStatus,
  InfoStatus,
  K8sResourceCommon,
  SuccessStatus,
  useDeleteModal,
} from '@openshift-console/dynamic-plugin-sdk';
import { ActionList, ActionListItem, Button, Flex, Icon, Tooltip } from '@patternfly/react-core';
import {
  ExclamationTriangleIcon,
  PencilAltIcon,
  RhUiSyncIcon,
  TrashIcon,
} from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FunctionSource } from '../../../common/types';
import { Function, FunctionStatus, functionKey } from '../types';

export function FunctionTable({
  functions,
  onEdit,
  showNamespace,
}: {
  functions: Function[];
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
          <Tr key={functionKey(fn)}>
            <Td dataLabel={t('Name')}>
              {fn.name && fn.namespace ? (
                <Link to={`/faas/functions/${fn.namespace}/${fn.name}`}>{fn.name}</Link>
              ) : (
                fn.repoName
              )}
            </Td>
            {showNamespace && (
              <Td dataLabel={t('Namespace')}>
                <TextOrDash value={fn.namespace} />
              </Td>
            )}
            <Td dataLabel={t('Runtime')}>
              <TextOrDash value={fn.runtime} />
            </Td>
            <Td dataLabel={t('Status')}>
              <StatusCell functionStatus={fn.status} repoError={fn.error} />
            </Td>
            <Td dataLabel={t('URL')}>
              <UrlCell url={fn.routeURL} />
            </Td>
            <Td dataLabel={t('Replicas')}>{fn.replicas ?? '—'}</Td>
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
  functionStatus,
  repoError,
}: {
  functionStatus: FunctionStatus;
  repoError?: string;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  // Repo-level error (e.g. broken func.yaml): error is primary, workflow is secondary.
  // Entries with error never have cluster data (no name to match against ksvc labels).
  if (repoError) {
    const repoErrorStatus = (
      <Tooltip content={repoError}>
        <span className="pf-v6-u-display-inline-flex">
          <ErrorStatus title={t('Error')} />
        </span>
      </Tooltip>
    );
    const workflow = workflowStatus();
    return workflow ? (
      <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
        {repoErrorStatus}
        {workflow}
      </Flex>
    ) : (
      repoErrorStatus
    );
  }
  const cluster = clusterStatus();
  const workflow = workflowStatus();
  return workflow ? (
    <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
      {cluster}
      {workflow}
    </Flex>
  ) : (
    cluster
  );
  function workflowStatus(): React.ReactNode {
    switch (functionStatus.workflow.status) {
      case 'None':
      case 'Succeeded':
        return null;
      case 'InProgress':
        return (
          <Tooltip content={t('Workflow run in progress')}>
            <Icon role="img" aria-label={t('Workflow run in progress')}>
              <RhUiSyncIcon className="co-spin" />
            </Icon>
          </Tooltip>
        );
      case 'Failed': {
        const icon = (
          <Icon status="danger">
            <ExclamationTriangleIcon />
          </Icon>
        );
        return (
          <Tooltip content={t('Latest workflow run failed')}>
            {functionStatus.workflow.url ? (
              <a
                href={functionStatus.workflow.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('Latest workflow run failed')}
              >
                {icon}
              </a>
            ) : (
              icon
            )}
          </Tooltip>
        );
      }
    }
  }
  function clusterStatus(): React.ReactNode {
    switch (functionStatus.cluster.status) {
      case 'NotDeployed':
        return <InfoStatus title={t('NotDeployed')} />;
      case 'Running':
        return <SuccessStatus title={t('Running')} />;
      case 'ScaledToZero':
        return <InfoStatus title={t('ScaledToZero')} />;
      case 'Deploying':
        return <InfoStatus title={t('Deploying')} />;
      case 'Undeploying':
        return <InfoStatus title={t('Undeploying')} />;
      case 'Error': {
        const status = <ErrorStatus title={t('Error')} />;
        return functionStatus.cluster.error ? (
          <Tooltip content={functionStatus.cluster.error.message}>
            <span className="pf-v6-u-display-inline-flex">{status}</span>
          </Tooltip>
        ) : (
          status
        );
      }
    }
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
  repoName?: string;
  onEdit: (name: string) => void;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const isDisabled = source === 'cluster';

  const button = (
    <Button
      variant="plain"
      aria-label={t('Edit')}
      icon={<PencilAltIcon />}
      // must use isAriaDisabled instead of isDisabled or the tooltip won't
      // show because for natively disabled buttons no mouse event on hover
      // is dispatched
      isAriaDisabled={isDisabled}
      onClick={() => {
        if (!isDisabled && repoName) onEdit(repoName);
      }}
    />
  );

  return isDisabled ? (
    <Tooltip content={t('No source repository to edit')}>{button}</Tooltip>
  ) : (
    button
  );
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
