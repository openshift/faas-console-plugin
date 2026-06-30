import {
  Alert,
  Button,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import { ArrowLeftIcon } from '@patternfly/react-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

interface EditToolbarProps {
  hasChanges: boolean;
  onSave: () => Promise<void>;
}

export function EditToolbar({ hasChanges, onSave }: EditToolbarProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const {
    isSaving,
    errorMsg,
    successMsg,
    showLeaveModal,
    handleSave,
    handleBack,
    onLeaveConfirm,
    onLeaveCancel,
  } = useEditToolbar(hasChanges, onSave);

  return (
    <>
      <Toolbar>
        <ToolbarContent>
          <ToolbarItem>
            <Button variant="link" icon={<ArrowLeftIcon />} onClick={handleBack}>
              {t('Back to Functions')}
            </Button>
          </ToolbarItem>
          <ToolbarGroup align={{ default: 'alignCenter' }}>
            <ToolbarItem>
              {errorMsg && <Alert variant="danger" title={errorMsg} isInline isPlain />}
              {successMsg && <Alert variant="success" title={t(successMsg)} isInline isPlain />}
            </ToolbarItem>
          </ToolbarGroup>
          <ToolbarGroup align={{ default: 'alignEnd' }}>
            <ToolbarItem>
              <Button
                variant="primary"
                onClick={handleSave}
                isDisabled={isSaving || !hasChanges}
                isLoading={isSaving}
              >
                {t('Save & Deploy')}
              </Button>
            </ToolbarItem>
          </ToolbarGroup>
        </ToolbarContent>
      </Toolbar>
      <LeaveModal isOpen={showLeaveModal} onStay={onLeaveCancel} onLeave={onLeaveConfirm} />
    </>
  );
}

function useEditToolbar(
  hasChanges: boolean,
  onSave: () => Promise<void>,
): {
  isSaving: boolean;
  errorMsg: string;
  successMsg: string;
  showLeaveModal: boolean;
  handleSave: () => Promise<void>;
  handleBack: () => void;
  onLeaveConfirm: () => void;
  onLeaveCancel: () => void;
} {
  const navigate = useNavigate();
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');
  const [showLeaveModal, setShowLeaveModal] = useState(false);

  // Cleared on unmount to prevent state updates after navigation.
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => clearTimeout(dismissTimer.current);
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      await onSave();
      setSuccessMsg('Pushed to GitHub. Deployment running...');
      dismissTimer.current = setTimeout(() => setSuccessMsg(''), 2000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleBack = () => {
    if (hasChanges) setShowLeaveModal(true);
    else navigate('/faas');
  };

  const onLeaveConfirm = () => {
    setShowLeaveModal(false);
    navigate('/faas');
  };

  const onLeaveCancel = () => {
    setShowLeaveModal(false);
  };

  return {
    isSaving,
    errorMsg,
    successMsg,
    showLeaveModal,
    handleSave,
    handleBack,
    onLeaveConfirm,
    onLeaveCancel,
  };
}

function LeaveModal({
  isOpen,
  onStay,
  onLeave,
}: {
  isOpen: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  return (
    <Modal isOpen={isOpen} onClose={onStay} variant="small">
      <ModalHeader title={t('Unsaved changes')} />
      <ModalBody>{t('You have unsaved changes. Leave anyway?')}</ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onStay}>
          {t('Stay')}
        </Button>
        <Button variant="link" onClick={onLeave}>
          {t('Leave')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
