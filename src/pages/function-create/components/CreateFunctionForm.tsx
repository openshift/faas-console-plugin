import {
  ActionGroup,
  Alert,
  Bullseye,
  Button,
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormHelperText,
  FormSection,
  FormSelect,
  FormSelectOption,
  Grid,
  GridItem,
  HelperText,
  HelperTextItem,
  Spinner,
  Split,
  SplitItem,
  Stack,
  StackItem,
  TextInput,
  Title,
} from '@patternfly/react-core';
import { MinusCircleIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../../common/context/AuthProvider';
import {
  FunctionRuntime,
  K8sKeyedResource,
  PlainEnvVar,
  ResourceEnvVar,
} from '../../../common/types';
import { isSystemNamespace } from '../../../common/utils/utils';

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
  plainEnvVars: PlainEnvVar[];
  secretEnvVars: ResourceEnvVar[];
  configMapEnvVars: ResourceEnvVar[];
}

type EnvVarField = 'plainEnvVars' | 'secretEnvVars' | 'configMapEnvVars';

interface CreateFunctionFormProps {
  secrets: K8sKeyedResource[];
  configMaps: K8sKeyedResource[];
  isSubmitting: boolean;
  canCreateNamespaces: boolean;
  namespaces: string[];
  onSubmit: (data: CreateFunctionFormData) => void;
  onCancel: () => void;
  onNamespaceChange: (namespace: string) => void;
  namespacesLoaded: boolean;
}

export function CreateFunctionForm({
  secrets,
  configMaps,
  onSubmit,
  onCancel,
  onNamespaceChange,
  isSubmitting,
  canCreateNamespaces,
  namespaces,
  namespacesLoaded,
}: CreateFunctionFormProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { fields, setField, setNamespace, setEnvVars, isValid } = useCreateFunctionForm();

  if (!namespacesLoaded) {
    return (
      <Bullseye>
        <Spinner aria-label={t('Loading')} size="lg" />
      </Bullseye>
    );
  }

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...fields });
      }}
    >
      <GithubSettingsSection fields={fields} setField={setField} />
      <FunctionSettingsSection
        fields={fields}
        setField={setField}
        canCreateNamespaces={canCreateNamespaces}
        namespaces={namespaces}
        setNamespaceField={setNamespace}
        onNamespaceChange={onNamespaceChange}
      />
      <EnvVarSection
        secrets={secrets}
        configMaps={configMaps}
        plainEnvVars={fields.plainEnvVars}
        secretEnvVars={fields.secretEnvVars}
        configMapEnvVars={fields.configMapEnvVars}
        namespace={fields.namespace}
        onEnvVarChange={setEnvVars}
      />
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

type OwnedFields = CreateFunctionFormData;

function useCreateFunctionForm() {
  const { user } = useContext(AuthContext);
  const [fields, setFields] = useState<OwnedFields>({
    owner: user?.name ?? '',
    repo: '',
    branch: '',
    name: '',
    runtime: 'node',
    registry: OCP_INTERNAL_REGISTRY,
    namespace: '',
    plainEnvVars: [],
    secretEnvVars: [],
    configMapEnvVars: [],
  });

  const setField = (key: keyof OwnedFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  // Secrets and ConfigMaps are namespace scoped, so a namespace change invalidates every
  // resource selection made against the previous one.
  const setNamespace = (namespace: string) => {
    setFields((prev) => ({
      ...prev,
      namespace,
      registry: OCP_INTERNAL_REGISTRY + namespace,
      secretEnvVars: prev.secretEnvVars.map((e) => ({ ...e, resourceName: '', resourceKey: '' })),
      configMapEnvVars: prev.configMapEnvVars.map((e) => ({
        ...e,
        resourceName: '',
        resourceKey: '',
      })),
    }));
  };

  const setEnvVars = (field: EnvVarField, vars: PlainEnvVar[] | ResourceEnvVar[]) => {
    setFields((prev) => ({ ...prev, [field]: vars }));
  };

  const isValid = Boolean(
    fields.owner &&
    fields.repo &&
    fields.branch &&
    fields.name &&
    fields.registry &&
    fields.namespace &&
    areEnvVarsValid(fields.plainEnvVars, fields.secretEnvVars, fields.configMapEnvVars),
  );

  return {
    fields,
    setField,
    setNamespace,
    setEnvVars,
    isValid,
  };
}

interface GithubSettingsSectionProps {
  fields: OwnedFields;
  setField: (key: keyof OwnedFields, value: string) => void;
}

const GithubSettingsSection = ({ fields, setField }: GithubSettingsSectionProps) => {
  const { t } = useTranslation('plugin__console-functions-plugin');

  return (
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
  );
};

interface FunctionSettingsSectionProps {
  fields: OwnedFields;
  setField: (key: keyof OwnedFields, value: string) => void;
  canCreateNamespaces: boolean;
  namespaces: string[];
  setNamespaceField: (namespace: string) => void;
  onNamespaceChange: (namespace: string) => void;
}

const FunctionSettingsSection = ({
  fields,
  setField,
  canCreateNamespaces,
  namespaces,
  setNamespaceField,
  onNamespaceChange,
}: FunctionSettingsSectionProps) => {
  const { t } = useTranslation('plugin__console-functions-plugin');

  return (
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
      <NamespaceInput
        canCreateNamespaces={canCreateNamespaces}
        namespaces={namespaces}
        value={fields.namespace}
        setNamespaceField={setNamespaceField}
        onNamespaceChange={onNamespaceChange}
      />
    </FormSection>
  );
};

interface NamespaceInputProps {
  canCreateNamespaces: boolean;
  namespaces: string[];
  value: string;
  setNamespaceField: (namespace: string) => void; // set the namespace field in the form
  onNamespaceChange: (namespace: string) => void; // debounced namespace change handler to watch for secrets and configmaps
}

export function NamespaceInput({
  canCreateNamespaces,
  namespaces,
  value,
  setNamespaceField,
  onNamespaceChange,
}: NamespaceInputProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleTextChange = (val: string) => {
    setNamespaceField(val); // Instant UI update

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      onNamespaceChange(val); // Debounced parent call (e.g., 500ms delay)
    }, 500);
  };

  // A user who cannot create namespaces should never be offered a system namespace, so
  // filter them out here regardless of what the caller passed in.
  const selectable = useMemo(
    () => (canCreateNamespaces ? namespaces : namespaces.filter((ns) => !isSystemNamespace(ns))),
    [canCreateNamespaces, namespaces],
  );

  // With a single choice there is nothing to pick, so the field is rendered read-only. The
  // owner still has to learn the value, otherwise the form would submit an empty namespace.
  const soleNamespace = !canCreateNamespaces && selectable.length === 1 ? selectable[0] : null;

  useEffect(() => {
    if (soleNamespace && value !== soleNamespace) {
      onNamespaceChange(soleNamespace);
      setNamespaceField(soleNamespace);
    }
  }, [soleNamespace, value, onNamespaceChange, setNamespaceField]);

  const namespaceMissing =
    canCreateNamespaces && !!value && namespaces.length > 0 && !namespaces.includes(value);

  if (!canCreateNamespaces && !selectable.length) {
    return (
      <FormGroup label={t('Namespace')}>
        <NamespaceAlert
          variant="info"
          title={t('No namespaces available. You can create a new namespace in Home/Projects.')}
        />
      </FormGroup>
    );
  }

  return (
    <FormGroup label={t('Namespace')} isRequired fieldId="namespace">
      {canCreateNamespaces ? (
        <TextInput
          id="namespace"
          isRequired
          value={value}
          onChange={(_, val) => handleTextChange(val)}
          aria-label={t('Namespace')}
        />
      ) : soleNamespace ? (
        <TextInput
          id="namespace"
          isRequired
          isDisabled
          value={soleNamespace}
          aria-label={t('Namespace')}
        />
      ) : (
        <FormSelect
          id="namespace"
          value={value}
          onChange={(_, val) => handleTextChange(val)}
          aria-label={t('Namespace')}
        >
          <FormSelectOption value="" label={t('Select...')} isPlaceholder />
          {selectable.map((ns) => (
            <FormSelectOption key={ns} value={ns} label={ns} />
          ))}
        </FormSelect>
      )}
      {canCreateNamespaces && isSystemNamespace(value) && (
        <NamespaceAlert
          title={t(
            'Functions should not be deployed to a system namespace. Deployment there is likely to fail. Create a new namespace for your functions instead.',
          )}
        />
      )}
      {canCreateNamespaces && namespaceMissing && (
        <NamespaceAlert
          title={t('Namespace "{{namespace}}" does not exist.', { namespace: value })}
        />
      )}
    </FormGroup>
  );
}

function NamespaceAlert({
  title,
  variant = 'warning',
}: {
  title: string;
  variant?: 'warning' | 'info';
}) {
  return <Alert variant={variant} isInline title={title} className="pf-v6-u-mt-sm" />;
}

interface EnvVarSectionProps {
  plainEnvVars: PlainEnvVar[];
  secretEnvVars: ResourceEnvVar[];
  configMapEnvVars: ResourceEnvVar[];
  secrets: K8sKeyedResource[];
  configMaps: K8sKeyedResource[];
  namespace: string;
  onEnvVarChange: (field: EnvVarField, vars: PlainEnvVar[] | ResourceEnvVar[]) => void;
}

function EnvVarSection({
  plainEnvVars,
  secretEnvVars,
  configMapEnvVars,
  secrets,
  configMaps,
  namespace,
  onEnvVarChange,
}: EnvVarSectionProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { expanded, expand, close, plainNameErrors, secretNameErrors, configMapNameErrors } =
    useEnvVarSection(plainEnvVars, secretEnvVars, configMapEnvVars);

  return (
    <FormSection title={t('Environment Variables')}>
      {!expanded ? (
        <Flex>
          <FlexItem>
            <Button variant="link" icon={<PlusCircleIcon />} onClick={() => expand()}>
              {t('Add environment variable')}
            </Button>
          </FlexItem>
        </Flex>
      ) : (
        <Grid>
          <GridItem span={6}>
            <Stack hasGutter>
              <StackItem>
                <PlainEnvVarGroup
                  envVars={plainEnvVars}
                  nameErrors={plainNameErrors}
                  onChange={(vars) => onEnvVarChange('plainEnvVars', vars)}
                />
              </StackItem>
              <StackItem>
                <ResourceEnvVarGroup
                  title={t('Secrets')}
                  envVars={secretEnvVars}
                  resources={secrets}
                  resourceLabel={t('Secret')}
                  addLabel={t('Add key/value')}
                  nameErrors={secretNameErrors}
                  namespaceSelected={Boolean(namespace)}
                  onChange={(vars) => onEnvVarChange('secretEnvVars', vars)}
                  idPrefix="secret"
                />
              </StackItem>
              <StackItem>
                <ResourceEnvVarGroup
                  title={t('ConfigMaps')}
                  envVars={configMapEnvVars}
                  resources={configMaps}
                  resourceLabel={t('ConfigMap')}
                  addLabel={t('Add key/value')}
                  nameErrors={configMapNameErrors}
                  namespaceSelected={Boolean(namespace)}
                  onChange={(vars) => onEnvVarChange('configMapEnvVars', vars)}
                  idPrefix="configmap"
                />
              </StackItem>
              <StackItem>
                <Flex justifyContent={{ default: 'justifyContentFlexEnd' }}>
                  <FlexItem>
                    <Button
                      variant="link"
                      icon={<MinusCircleIcon />}
                      onClick={() => {
                        onEnvVarChange('plainEnvVars', []);
                        onEnvVarChange('secretEnvVars', []);
                        onEnvVarChange('configMapEnvVars', []);
                        close();
                      }}
                    >
                      {t('Remove environment variables')}
                    </Button>
                  </FlexItem>
                </Flex>
              </StackItem>
            </Stack>
          </GridItem>
        </Grid>
      )}
    </FormSection>
  );
}

function useEnvVarSection(
  plainEnvVars: PlainEnvVar[],
  secretEnvVars: ResourceEnvVar[],
  configMapEnvVars: ResourceEnvVar[],
) {
  const [expanded, setExpanded] = useState(false);
  const expand = () => setExpanded(true);
  const close = () => setExpanded(false);

  const plainNames = plainEnvVars.map((e) => e.name);
  const secretNames = secretEnvVars.map((e) => e.name);
  const configMapNames = configMapEnvVars.map((e) => e.name);
  const duplicates = findDuplicateEnvVarNames([...plainNames, ...secretNames, ...configMapNames]);

  return {
    expanded,
    expand,
    close,
    plainNameErrors: getNameError(
      plainNames,
      duplicates,
      plainEnvVars.map((e) => Boolean(e.value)),
    ),
    secretNameErrors: getNameError(
      secretNames,
      duplicates,
      secretEnvVars.map((e) => Boolean(e.resourceName || e.resourceKey)),
    ),
    configMapNameErrors: getNameError(
      configMapNames,
      duplicates,
      configMapEnvVars.map((e) => Boolean(e.resourceName || e.resourceKey)),
    ),
  };
}

function areEnvVarsValid(
  plainEnvVars: PlainEnvVar[],
  secretEnvVars: ResourceEnvVar[],
  configMapEnvVars: ResourceEnvVar[],
): boolean {
  const filledPlain = plainEnvVars.filter((e) => e.name || e.value);
  const filledResource = [...secretEnvVars, ...configMapEnvVars].filter(
    (e) => e.name || e.resourceName || e.resourceKey,
  );
  if (filledPlain.length === 0 && filledResource.length === 0) return true;

  const allNames = [
    ...plainEnvVars.map((e) => e.name),
    ...secretEnvVars.map((e) => e.name),
    ...configMapEnvVars.map((e) => e.name),
  ];
  if (findDuplicateEnvVarNames(allNames).size > 0) return false;

  const plainValid = filledPlain.every(
    (e) => e.name && validateEnvVarName(e.name) === null && e.value.trim() !== '',
  );
  const resourceValid = filledResource.every(
    (e) =>
      e.name &&
      validateEnvVarName(e.name) === null &&
      e.resourceName.trim() !== '' &&
      e.resourceKey.trim() !== '',
  );
  return plainValid && resourceValid;
}

function validateEnvVarName(name: string): string | null {
  const ENV_VAR_NAME_REGEX = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;

  if (!name) return 'Name is required';
  if (!ENV_VAR_NAME_REGEX.test(name)) {
    return 'Must start with a letter, dot, dash, or underscore, followed by letters, digits, dots, dashes, or underscores';
  }
  return null;
}

function findDuplicateEnvVarNames(names: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return duplicates;
}

function getNameError(names: string[], duplicates: Set<string>, hasContent: boolean[]) {
  return names.map((name, i) => {
    if (duplicates.has(name)) return 'Duplicate name';
    if (name) return validateEnvVarName(name);
    if (hasContent[i]) return 'Name is required';
    return null;
  });
}

interface PlainEnvVarGroupProps {
  envVars: PlainEnvVar[];
  nameErrors: (string | null)[];
  onChange: (vars: PlainEnvVar[]) => void;
}

function PlainEnvVarGroup({ envVars, nameErrors, onChange }: PlainEnvVarGroupProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { rows, keys, handleAdd, handleChange, handleRemove } = useEnvVarList(
    envVars,
    { name: '', value: '' },
    onChange,
  );

  return (
    <Stack hasGutter>
      {rows.map((envVar, index) => (
        <StackItem key={envVars.length > 0 ? keys[index] : 0}>
          <PlainEnvVarRow
            envVar={envVar}
            index={index}
            nameError={envVars.length > 0 ? nameErrors[index] : null}
            onChange={handleChange}
          />
        </StackItem>
      ))}
      <StackItem>
        <Split>
          <SplitItem>
            <Button variant="link" icon={<PlusCircleIcon />} onClick={handleAdd}>
              {t('Add key/value')}
            </Button>
          </SplitItem>
          <SplitItem isFilled />
          {envVars.length > 1 && (
            <SplitItem>
              <Button
                variant="link"
                icon={<MinusCircleIcon />}
                onClick={() => handleRemove(envVars.length - 1)}
              >
                {t('Remove')}
              </Button>
            </SplitItem>
          )}
        </Split>
      </StackItem>
    </Stack>
  );
}

function useEnvVarList<T extends object>(items: T[], empty: T, onChange: (items: T[]) => void) {
  const [keys, setKeys] = useState<number[]>(() => items.map((_, i) => i));

  const rows = items.length > 0 ? items : [empty];

  const handleAdd = () => {
    if (items.length === 0) {
      onChange([{ ...empty }, { ...empty }]);
      setKeys([0, 1]);
      return;
    }
    onChange([...items, { ...empty }]);
    setKeys((prev) => [...prev, Math.max(0, ...prev) + 1]);
  };

  const handleChange = (index: number, updated: T) => {
    if (items.length === 0) {
      onChange([updated]);
      setKeys([0]);
      return;
    }
    const next = [...items];
    next[index] = updated;
    onChange(next);
  };

  const handleRemove = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
    setKeys((prev) => prev.filter((_, i) => i !== index));
  };

  return { rows, keys, handleAdd, handleChange, handleRemove };
}

interface PlainEnvVarRowProps {
  envVar: PlainEnvVar;
  index: number;
  nameError: string | null;
  onChange: (index: number, envVar: PlainEnvVar) => void;
}

function PlainEnvVarRow({ envVar, index, nameError, onChange }: PlainEnvVarRowProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  return (
    <Flex gap={{ default: 'gapMd' }}>
      <FlexItem flex={{ default: 'flex_1' }}>
        <FormGroup label={t('Name')} fieldId={`env-name-${index}`}>
          <TextInput
            id={`env-name-${index}`}
            value={envVar.name}
            onChange={(_, val) => onChange(index, { ...envVar, name: val })}
            aria-label={t('Name')}
            validated={nameError ? 'error' : 'default'}
          />
          {nameError && (
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant="error">{nameError}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          )}
        </FormGroup>
      </FlexItem>
      <FlexItem flex={{ default: 'flex_1' }}>
        <FormGroup label={t('Value')} fieldId={`env-value-${index}`}>
          <TextInput
            id={`env-value-${index}`}
            value={envVar.value}
            onChange={(_, val) => onChange(index, { ...envVar, value: val })}
            aria-label={t('Value')}
          />
        </FormGroup>
      </FlexItem>
    </Flex>
  );
}

interface ResourceEnvVarGroupProps {
  title: string;
  envVars: ResourceEnvVar[];
  resources: K8sKeyedResource[];
  resourceLabel: string;
  addLabel: string;
  nameErrors: (string | null)[];
  namespaceSelected: boolean;
  onChange: (vars: ResourceEnvVar[]) => void;
  idPrefix: string;
}

function ResourceEnvVarGroup({
  title,
  envVars,
  resources,
  resourceLabel,
  addLabel,
  nameErrors,
  namespaceSelected,
  onChange,
  idPrefix,
}: ResourceEnvVarGroupProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const { rows, keys, handleAdd, handleChange, handleRemove } = useEnvVarList(
    envVars,
    { name: '', resourceName: '', resourceKey: '' },
    onChange,
  );

  return (
    <Stack hasGutter>
      <StackItem>
        <Title headingLevel="h4" size="md">
          {title}
        </Title>
      </StackItem>
      {rows.map((envVar, index) => (
        <StackItem key={envVars.length > 0 ? keys[index] : 0}>
          <ResourceEnvVarRow
            envVar={envVar}
            index={index}
            nameError={envVars.length > 0 ? nameErrors[index] : null}
            resources={resources}
            resourceLabel={resourceLabel}
            namespaceSelected={namespaceSelected}
            onChange={handleChange}
            idPrefix={idPrefix}
          />
        </StackItem>
      ))}
      <StackItem>
        <Split>
          <SplitItem>
            <Button variant="link" icon={<PlusCircleIcon />} onClick={handleAdd}>
              {addLabel}
            </Button>
          </SplitItem>
          <SplitItem isFilled />
          {envVars.length > 1 && (
            <SplitItem>
              <Button
                variant="link"
                icon={<MinusCircleIcon />}
                onClick={() => handleRemove(envVars.length - 1)}
              >
                {t('Remove')}
              </Button>
            </SplitItem>
          )}
        </Split>
      </StackItem>
    </Stack>
  );
}

interface ResourceEnvVarRowProps {
  envVar: ResourceEnvVar;
  index: number;
  nameError: string | null;
  resources: K8sKeyedResource[];
  resourceLabel: string;
  namespaceSelected: boolean;
  onChange: (index: number, envVar: ResourceEnvVar) => void;
  idPrefix: string;
}

function ResourceEnvVarRow({
  envVar,
  index,
  nameError,
  resources,
  resourceLabel,
  namespaceSelected,
  onChange,
  idPrefix,
}: ResourceEnvVarRowProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');
  const resourceKeys = resources.find((r) => r.name === envVar.resourceName)?.keys ?? [];

  return (
    <Flex gap={{ default: 'gapMd' }}>
      <FlexItem flex={{ default: 'flex_2' }}>
        <FormGroup label={t('Name')} fieldId={`${idPrefix}-name-${index}`}>
          <TextInput
            id={`${idPrefix}-name-${index}`}
            value={envVar.name}
            onChange={(_, val) => onChange(index, { ...envVar, name: val })}
            aria-label={t('Name')}
            validated={nameError ? 'error' : 'default'}
          />
          {nameError && (
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant="error">{nameError}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          )}
        </FormGroup>
      </FlexItem>
      <FlexItem flex={{ default: 'flex_1' }}>
        <FormGroup
          label={resourceLabel}
          fieldId={`${idPrefix}-resource-${index}`}
          labelHelp={<span title={t('Select a namespace first')}>&#9432;</span>}
        >
          <FormSelect
            id={`${idPrefix}-resource-${index}`}
            value={envVar.resourceName}
            onChange={(_, val) =>
              onChange(index, { ...envVar, resourceName: val, resourceKey: '' })
            }
            aria-label={resourceLabel}
            isDisabled={!namespaceSelected}
          >
            <FormSelectOption value="" label={t('Select...')} isPlaceholder />
            {resources.map((r) => (
              <FormSelectOption key={r.name} value={r.name} label={r.name} />
            ))}
          </FormSelect>
        </FormGroup>
      </FlexItem>
      <FlexItem flex={{ default: 'flex_1' }}>
        <FormGroup label={t('Key')} fieldId={`${idPrefix}-key-${index}`}>
          <FormSelect
            id={`${idPrefix}-key-${index}`}
            value={envVar.resourceKey}
            onChange={(_, val) => onChange(index, { ...envVar, resourceKey: val })}
            aria-label={t('Key')}
            isDisabled={!envVar.resourceName}
          >
            <FormSelectOption value="" label={t('Select...')} isPlaceholder />
            {resourceKeys.map((key) => (
              <FormSelectOption key={key} value={key} label={key} />
            ))}
          </FormSelect>
        </FormGroup>
      </FlexItem>
    </Flex>
  );
}
