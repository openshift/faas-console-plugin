import {
  Alert,
  Button,
  Divider,
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
  Tooltip,
} from '@patternfly/react-core';
import { GithubIcon, KeyIcon, UserIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { ForgeUser, PAT_KEY, USER_KEY } from '../services/types';
import { useContext, useState } from 'react';
import { ForgeConnectionContext } from '../context/ForgeConnectionProvider';
import { useSourceControlService } from '../services/source-control/useSourceControlService';
import { errorMessage } from '../utils/utils';

interface UserAvatarProps {
  enableReconnect: boolean;
}

export function UserAvatar({ enableReconnect }: UserAvatarProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { user, isModalOpen, openModal, closeModal, login } = useUserAvatar(enableReconnect);

  const icon = user ? <UserIcon /> : <KeyIcon />;
  const label = user ? user.name : t('Connect to GitHub');

  return (
    <>
      <Button
        variant="link"
        icon={icon}
        onClick={enableReconnect ? openModal : undefined}
        isDisabled={!enableReconnect}
        style={!enableReconnect ? { cursor: 'default' } : undefined}
      >
        {label}
      </Button>
      <PatModal isOpen={isModalOpen} onClose={closeModal} onConnect={login} />
    </>
  );
}

function useUserAvatar(enableReconnect: boolean) {
  const sourceControlService = useSourceControlService();
  const connectToForge = useContext(ForgeConnectionContext).connectToForge;
  const [user, setUser] = useState<ForgeUser | null>(() => readStoredUser());
  const [isModalOpen, setIsModalOpen] = useState(
    () => enableReconnect && !sessionStorage.getItem(PAT_KEY),
  );

  const login = async (pat: string) => {
    const forgeUser = await sourceControlService.fetchUserInfo(pat);
    sessionStorage.setItem(PAT_KEY, pat);
    sessionStorage.setItem(USER_KEY, JSON.stringify(forgeUser));
    setUser(forgeUser);
    setIsModalOpen(false);
    connectToForge(forgeUser);
  };

  const openModal = () => setIsModalOpen(true);
  const closeModal = () => setIsModalOpen(false);

  return { user, isModalOpen, openModal, closeModal, login };
}

function readStoredUser(): ForgeUser | null {
  const pat = sessionStorage.getItem(PAT_KEY);
  const userJson = sessionStorage.getItem(USER_KEY);

  if (!pat || !userJson) {
    return null;
  }

  try {
    return JSON.parse(userJson) as ForgeUser;
  } catch {
    return null;
  }
}

interface PatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (pat: string) => Promise<void>;
}

function PatModal({ isOpen, onClose, onConnect }: PatModalProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { pat, isValidating, error, setPat, handleConnect, handleClose } = usePatModal(
    onClose,
    onConnect,
  );

  return (
    <Modal isOpen={isOpen} onClose={isValidating ? undefined : handleClose} variant="small">
      <ModalHeader title={t('Connect to GitHub')} />
      <ModalBody>
        {error && (
          <Alert variant="danger" title={error} isInline style={{ marginBottom: '1rem' }} />
        )}
        <Tooltip content={t('Coming soon')}>
          <Button
            className="pf-v6-u-my-md"
            variant="secondary"
            icon={<GithubIcon />}
            isAriaDisabled
            isBlock
            data-test="oauth-button"
          >
            {t('Sign in with GitHub')}
          </Button>
        </Tooltip>
        <Flex
          className="pf-v6-u-my-md"
          alignItems={{ default: 'alignItemsCenter' }}
          spaceItems={{ default: 'spaceItemsSm' }}
        >
          <FlexItem flex={{ default: 'flex_1' }}>
            <Divider />
          </FlexItem>
          <FlexItem>{t('or')}</FlexItem>
          <FlexItem flex={{ default: 'flex_1' }}>
            <Divider />
          </FlexItem>
        </Flex>
        <Form>
          <FormGroup label={t('Personal Access Token')} fieldId="pat-input">
            <TextInput
              id="pat-input"
              type="password"
              value={pat}
              onChange={(_, value) => setPat(value)}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t('Enter your GitHub Personal Access Token to connect your repositories.')}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          onClick={handleConnect}
          isDisabled={!pat || isValidating}
          isLoading={isValidating}
        >
          {t('Connect')}
        </Button>
        <Button variant="link" onClick={handleClose} isDisabled={isValidating}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function usePatModal(onClose: () => void, onConnect: (pat: string) => Promise<void>) {
  const [pat, setPat] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setIsValidating(true);
    setError(null);
    try {
      await onConnect(pat);
      setPat('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsValidating(false);
    }
  };

  const handleClose = () => {
    setPat('');
    setError(null);
    onClose();
  };

  return { pat, isValidating, error, setPat, handleConnect, handleClose };
}
