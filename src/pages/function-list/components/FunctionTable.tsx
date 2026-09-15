import {
  ErrorStatus,
  InfoStatus,
  K8sResourceCommon,
  ProgressStatus,
  StatusIconAndText,
  SuccessStatus,
  useDeleteModal,
} from '@openshift-console/dynamic-plugin-sdk';
import { ActionList, ActionListItem, Button, Icon, Spinner, Tooltip } from '@patternfly/react-core';
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
  // Set only when the primary status is one the build status must not overwrite.
  buildActivity?: 'Building' | 'Failed';
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
                buildRunURL={fn.buildRunURL}
                buildActivity={fn.buildActivity}
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
  buildRunURL,
  buildActivity,
}: {
  status: FunctionStatus;
  buildRunURL?: string;
  buildActivity?: 'Building' | 'Failed';
}) {
  switch (status) {
    // A function the cluster knows about keeps its cluster status; a rebuild
    // only ever adds a secondary indicator, so the cluster state is never
    // misrepresented.
    case 'Running':
      return withBuildActivity(<SuccessStatus title={status} />, buildActivity, buildRunURL);
    case 'ScaledToZero':
      return withBuildActivity(<InfoStatus title={status} />, buildActivity, buildRunURL);
    case 'Deploying':
      return withBuildActivity(<ProgressStatus title={status} />, buildActivity, buildRunURL);
    case 'Error':
      return withBuildActivity(<ErrorStatus title={status} />, buildActivity, buildRunURL);
    // Only reached when the cluster knows nothing about the function, so there
    // is never a secondary indicator to add.
    case 'Building':
      return <ProgressStatus title={status} />;
    case 'BuildFailed': {
      // The badge is a block-level flex box that would otherwise fill the cell
      // and make the whole width clickable. Inline-flex shrink-wraps it.
      const badge = <ErrorStatus title={status} className="pf-v6-u-display-inline-flex" />;
      return buildRunURL ? <RunLink url={buildRunURL}>{badge}</RunLink> : badge;
    }
    case 'NotDeployed':
      return <InfoStatus title={status} />;
    case 'Unknown':
      return <StatusIconAndText title={status} icon={<ExclamationTriangleIcon />} />;
  }
}

// Pass ariaLabel when the content has no visible text of its own (e.g. an icon)
// so the link still has an accessible name.
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

function withBuildActivity(
  badge: React.ReactNode,
  buildActivity?: 'Building' | 'Failed',
  buildRunURL?: string,
) {
  if (!buildActivity) return <>{badge}</>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      {badge}
      <BuildActivityIndicator buildActivity={buildActivity} buildRunURL={buildRunURL} />
    </span>
  );
}

// The tooltips say "latest build" so it stays clear the function itself is
// still running and only the rebuild is affected.
function BuildActivityIndicator({
  buildActivity,
  buildRunURL,
}: {
  buildActivity?: 'Building' | 'Failed';
  buildRunURL?: string;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  if (buildActivity === 'Building') {
    // The tooltip triggers off the wrapper, not the spinner: it attaches a focus
    // listener to its trigger, and Blink makes an <svg> with focus listeners
    // focusable, so clicking the bare spinner drew a focus ring that then
    // rotated along with it. A span with the same listener stays unfocusable.
    return (
      <Tooltip content={t('Build in progress')}>
        <span className="pf-v6-u-display-inline-flex">
          <Spinner size="sm" aria-label={t('Build in progress')} />
        </span>
      </Tooltip>
    );
  }
  if (buildActivity === 'Failed') {
    // status="danger" keeps the icon red inside the run link, which would
    // otherwise tint it link-blue via inherited anchor color.
    const icon = (
      <Icon status="danger">
        <ExclamationTriangleIcon />
      </Icon>
    );
    const withLink = buildRunURL ? (
      <RunLink url={buildRunURL} ariaLabel={t('Latest build failed')}>
        {icon}
      </RunLink>
    ) : (
      icon
    );
    return <Tooltip content={t('Latest build failed')}>{withLink}</Tooltip>;
  }
  return null;
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
