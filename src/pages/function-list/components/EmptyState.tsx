import {
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
} from '@patternfly/react-core';
import { CubesIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { SetupGuide } from './SetupGuide';

interface FunctionsEmptyStateProps {
  isCreateDisabled?: boolean;
}

export function FunctionsEmptyState({ isCreateDisabled }: FunctionsEmptyStateProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  return (
    <EmptyState headingLevel="h2" icon={CubesIcon} titleText={t('No functions found')}>
      <EmptyStateBody>
        {isCreateDisabled
          ? t(
              "A GitHub Personal Access Token is required to create functions. Click 'Connect to GitHub' in the top-right corner to connect. Once connected, the create button will be enabled.",
            )
          : t('Create a serverless function to get started.')}
        <SetupGuide className="pf-v6-u-display-block pf-v6-u-mx-auto pf-v6-u-mt-sm" />
      </EmptyStateBody>
      <EmptyStateFooter>
        <EmptyStateActions>
          {isCreateDisabled ? (
            <Button variant="primary" isDisabled>
              {t('Create function')}
            </Button>
          ) : (
            <Button variant="primary" component={(props) => <Link {...props} to="/faas/create" />}>
              {t('Create function')}
            </Button>
          )}
        </EmptyStateActions>
      </EmptyStateFooter>
    </EmptyState>
  );
}
