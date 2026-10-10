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
import { Function, FunctionSource, FunctionStatusV2 } from '../../../common/types';

export function FunctionTableV2({
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
              <StatusCell functionStatus={fn.status} />
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

function StatusCell({ functionStatus }: { functionStatus: FunctionStatusV2 }) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  const cluster = (() => {
    switch (functionStatus.cluster.status) {
      case 'None':
        return null;
      case 'Running':
        return <SuccessStatus title={t('Running')} />;
      case 'ScaledToZero':
        return <InfoStatus title={t('ScaledToZero')} />;
      case 'Deploying':
        return <InfoStatus title={t('Deploying')} />;
      case 'Undeploying':
        return <InfoStatus title={t('Undeploying')} />;
      case 'NotDeployed':
        return <InfoStatus title={t('NotDeployed')} />;
      case 'Error': {
        const badge = <ErrorStatus title={t('Error')} />;
        return functionStatus.cluster.errorMessage ? (
          <Tooltip content={functionStatus.cluster.errorMessage}>{badge}</Tooltip>
        ) : (
          badge
        );
      }
    }
  })();

  const workflow = (() => {
    switch (functionStatus.workflow.status) {
      case 'None':
      case 'Succeeded':
        return null;
      case 'Building':
        return (
          <Tooltip content={t('Build in progress')}>
            <Icon role="img" aria-label={t('Build in progress')}>
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
        return functionStatus.workflow.url ? (
          <Tooltip content={t('Latest build failed')}>
            <RunLink url={functionStatus.workflow.url} ariaLabel={t('Latest build failed')}>
              {icon}
            </RunLink>
          </Tooltip>
        ) : (
          <Tooltip content={t('Latest build failed')}>{icon}</Tooltip>
        );
      }
    }
  })();

  return (
    <>
      {!cluster && !workflow && <TextOrDash />}
      {!cluster && workflow}
      {cluster && !workflow && cluster}
      {cluster && workflow && (
        <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
          {cluster}
          {workflow}
        </Flex>
      )}
    </>
  );
}

function RunLink({
  url,
  ariaLabel,
  children,
}: {
  url: string;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label={ariaLabel}>
      {children}
    </a>
  );
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
