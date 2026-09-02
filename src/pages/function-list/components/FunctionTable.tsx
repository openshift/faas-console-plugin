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
  failureReason?: string;
  // buildActivity is set only when the primary status is a serving `Running`
  // that the build status must not overwrite (non-destructive build indicator).
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
                failureReason={fn.failureReason}
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
  failureReason,
  buildRunURL,
  buildActivity,
}: {
  status: FunctionStatus;
  failureReason?: string;
  buildRunURL?: string;
  buildActivity?: 'Building' | 'Failed';
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  switch (status) {
    // Non-destructive build indicator: a function that is deployed and available
    // (serving `Running` or idle `ScaledToZero`) keeps its cluster status; any
    // in-progress or failed rebuild is shown only as a small secondary indicator
    // so availability is never misrepresented.
    case 'Running':
      return withBuildActivity(
        <SuccessStatus title={status} />,
        buildActivity,
        failureReason,
        buildRunURL,
      );
    case 'ScaledToZero':
      return withBuildActivity(
        <InfoStatus title={status} />,
        buildActivity,
        failureReason,
        buildRunURL,
      );
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
      const withLink = buildRunURL ? <RunLink url={buildRunURL}>{badge}</RunLink> : badge;
      return <Tooltip content={failureReason || t('Build failed')}>{withLink}</Tooltip>;
    }
    case 'NotDeployed':
      return <InfoStatus title={status} />;
    case 'Unknown':
      return <StatusIconAndText title={status} icon={<ExclamationTriangleIcon />} />;
  }
}

// RunLink wraps content in an external link to a GitHub Actions run. Pass
// ariaLabel when the content has no visible text of its own (e.g. an icon) so
// the link still has an accessible name.
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

// withBuildActivity renders a primary status badge and, when a rebuild is in
// progress or failed for an available function, appends the secondary build
// indicator next to it.
function withBuildActivity(
  badge: React.ReactNode,
  buildActivity?: 'Building' | 'Failed',
  failureReason?: string,
  buildRunURL?: string,
) {
  if (!buildActivity) return <>{badge}</>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      {badge}
      <BuildActivityIndicator
        buildActivity={buildActivity}
        failureReason={failureReason}
        buildRunURL={buildRunURL}
      />
    </span>
  );
}

// BuildActivityIndicator is the small secondary indicator shown next to an
// available status (`Running` or `ScaledToZero`) while a new revision builds or a rebuild fails: a
// spinner (tooltip "Build in progress") for an in-progress build, or a warning
// icon (tooltip "Latest build failed: <reason>", link to the run) for a failed
// one. On a serving function the tooltip is phrased to make clear the function
// is still running and only the latest rebuild failed, not the function itself.
function BuildActivityIndicator({
  buildActivity,
  failureReason,
  buildRunURL,
}: {
  buildActivity?: 'Building' | 'Failed';
  failureReason?: string;
  buildRunURL?: string;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  if (buildActivity === 'Building') {
    return (
      <Tooltip content={t('Build in progress')}>
        <Spinner size="sm" aria-label={t('Build in progress')} />
      </Tooltip>
    );
  }
  if (buildActivity === 'Failed') {
    // status="danger" colors the icon red even inside the run link, which would
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
    const tooltip = failureReason
      ? t('Latest build failed: {{reason}}', { reason: failureReason })
      : t('Latest build failed');
    return <Tooltip content={tooltip}>{withLink}</Tooltip>;
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
