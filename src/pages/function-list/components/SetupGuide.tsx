import {
  Button,
  Content,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@patternfly/react-core';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface SetupGuideProps {
  className?: string;
}

export function SetupGuide({ className }: SetupGuideProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button variant="link" isInline onClick={() => setIsOpen(true)} className={className}>
        {t('View setup guide.')}
      </Button>
      <SetupGuideModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}

interface SetupGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function SetupGuideModal({ isOpen, onClose }: SetupGuideModalProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  return (
    <Modal isOpen={isOpen} onClose={onClose} variant="medium">
      <ModalHeader title={t('Set up guide')} />
      <ModalBody>
        <Content component="p">
          {t('Follow these steps to create and deploy your serverless function.')}
        </Content>
        <Content component="ol" className="pf-v6-u-mt-md">
          {steps(t).map((step) => (
            <Content component="li" key={step.title}>
              <Content component="p" className="pf-v6-u-font-weight-bold">
                {step.title}
              </Content>
              <Content component="p">{step.body}</Content>
            </Content>
          ))}
        </Content>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onClose}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

interface Step {
  title: string;
  body: ReactNode;
}

function steps(t: (key: string) => string): Step[] {
  return [
    {
      title: t('Connect GitHub'),
      body: t(
        "Create a GitHub Personal Access Token with the 'repo' and 'workflow' scopes, then click 'Connect to GitHub' in the header and paste the token.",
      ),
    },
    {
      title: t('Create a namespace and secret'),
      body: t(
        'Create or select a project for your function. If it needs credentials such as an API key, create a secret in that namespace so you can reference it as an environment variable.',
      ),
    },
    {
      title: t('Create a function'),
      body: t(
        'Click "Create new function", choose a runtime, and add any environment variables (plain values or from a secret). Submitting creates a GitHub repository, pushes the function scaffold, and starts a GitHub Actions workflow that deploys the function to your cluster. It appears here as "NotDeployed" until the workflow finishes, then the status changes to "Running".',
      ),
    },
    {
      title: t('Edit and redeploy'),
      body: t(
        'Open the function from the list to edit its files, then click "Save & Deploy". This pushes your changes to GitHub, which runs the same workflow again to redeploy the function.',
      ),
    },
  ];
}
