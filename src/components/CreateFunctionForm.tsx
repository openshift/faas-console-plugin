import { useContext, useState } from 'react';
import {
  ActionGroup,
  Button,
  Form,
  FormGroup,
  FormSection,
  FormSelect,
  FormSelectOption,
  TextInput,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { FunctionRuntime } from '../services/types';
import { ForgeConnectionContext } from '../context/ForgeConnectionProvider';

const OCP_INTERNAL_REGISTRY = 'image-registry.openshift-image-registry.svc:5000/';

const runtimeOptions = [
  { value: 'node', label: 'Node.js' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'quarkus', label: 'Quarkus' },
];

export interface CreateFunctionFormData {
  owner: string;
  repo: string;
  branch: string;
  name: string;
  runtime: FunctionRuntime;
  registry: string;
  namespace: string;
}

interface CreateFunctionFormProps {
  onSubmit: (data: CreateFunctionFormData) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function CreateFunctionForm({ onSubmit, onCancel, isSubmitting }: CreateFunctionFormProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { fields, setField, isValid } = useCreateFunctionForm();

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(fields);
      }}
    >
      <FormSection title={t('GitHub Settings')}>
        <FormGroup label={t('Owner')} isRequired fieldId="owner">
          <TextInput id="owner" isRequired isDisabled value={fields.owner} />
        </FormGroup>
        <FormGroup label={t('Repository')} isRequired fieldId="repo">
          <TextInput
            id="repo"
            isRequired
            value={fields.repo}
            onChange={(_, val) => setField('repo', val)}
          />
        </FormGroup>
        <FormGroup label={t('Branch')} isRequired fieldId="branch">
          <TextInput
            id="branch"
            isRequired
            value={fields.branch}
            onChange={(_, val) => setField('branch', val)}
          />
        </FormGroup>
      </FormSection>
      <FormSection title={t('Function Settings')}>
        <FormGroup label={t('Name')} isRequired fieldId="name">
          <TextInput
            id="name"
            isRequired
            value={fields.name}
            onChange={(_, val) => setField('name', val)}
          />
        </FormGroup>
        <FormGroup label={t('Language')} isRequired fieldId="runtime">
          <FormSelect
            id="runtime"
            value={fields.runtime}
            onChange={(_, val) => setField('runtime', val as FunctionRuntime)}
            aria-label={t('Language')}
          >
            {runtimeOptions.map(({ value, label }) => (
              <FormSelectOption key={value} value={value} label={label} />
            ))}
          </FormSelect>
        </FormGroup>
        <FormGroup label={t('Registry')} isRequired fieldId="registry">
          <TextInput id="registry" isRequired isDisabled value={fields.registry} />
        </FormGroup>
        <FormGroup label={t('Namespace')} isRequired fieldId="namespace">
          <TextInput
            id="namespace"
            isRequired
            value={fields.namespace}
            onChange={(_, val) => setField('namespace', val)}
          />
        </FormGroup>
      </FormSection>
      <ActionGroup>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!isValid || isSubmitting}
          isLoading={isSubmitting}
        >
          {t('Create')}
        </Button>
        <Button variant="link" onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </ActionGroup>
    </Form>
  );
}

function useCreateFunctionForm() {
  const { user } = useContext(ForgeConnectionContext);
  const [fields, setFields] = useState<CreateFunctionFormData>({
    owner: user?.name ?? '',
    repo: '',
    branch: '',
    name: '',
    runtime: 'node',
    registry: OCP_INTERNAL_REGISTRY,
    namespace: '',
  });

  const setField = (key: keyof CreateFunctionFormData, value: string) => {
    setFields((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'namespace') {
        next.registry = OCP_INTERNAL_REGISTRY + value;
      }
      return next;
    });
  };

  const isValid = Boolean(
    fields.owner &&
    fields.repo &&
    fields.branch &&
    fields.name &&
    fields.registry &&
    fields.namespace,
  );

  return { fields, setField, isValid };
}
