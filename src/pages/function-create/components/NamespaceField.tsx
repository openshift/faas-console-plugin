import { Alert, FormGroup, FormSelect, FormSelectOption, TextInput } from '@patternfly/react-core';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isSystemNamespace } from '../../../common/utils/utils';

interface NamespaceFieldProps {
  canCreateNamespaces: boolean;
  namespaces: string[];
  namespaceMissing: boolean;
  value: string;
  onChange: (namespace: string) => void;
}

export function NamespaceField({
  canCreateNamespaces,
  namespaces,
  namespaceMissing,
  value,
  onChange,
}: NamespaceFieldProps) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  // A user who cannot create namespaces should never be offered a system namespace, so
  // filter them out here regardless of what the caller passed in.
  const selectable = useMemo(
    () => (canCreateNamespaces ? namespaces : namespaces.filter((ns) => !isSystemNamespace(ns))),
    [canCreateNamespaces, namespaces],
  );

  // A user who can create namespaces types the target namespace freely (including a
  // not-yet-created one), with a warning if it is a system namespace.
  if (canCreateNamespaces) {
    return (
      <FormGroup label={t('Namespace')} isRequired fieldId="namespace">
        <TextInput
          id="namespace"
          isRequired
          value={value}
          onChange={(_, val) => onChange(val)}
          aria-label={t('Namespace')}
        />
        {isSystemNamespace(value) && (
          <Alert
            variant="warning"
            isInline
            title={t(
              'Functions should not be deployed to a system namespace. Deployment there is likely to fail. Create a new namespace for your functions instead.',
            )}
            className="pf-v6-u-mt-sm"
          />
        )}
        {namespaceMissing && (
          <Alert
            variant="warning"
            isInline
            title={t('Namespace "{{namespace}}" does not exist.', { namespace: value })}
            className="pf-v6-u-mt-sm"
          />
        )}
      </FormGroup>
    );
  }

  if (selectable.length === 0) {
    return (
      <FormGroup label={t('Namespace')}>
        <Alert variant="info" isInline title={t('No namespaces available.')} />
      </FormGroup>
    );
  }

  return (
    <FormGroup label={t('Namespace')} isRequired fieldId="namespace">
      {selectable.length === 1 ? (
        <TextInput
          id="namespace"
          isRequired
          isDisabled
          value={selectable[0]}
          aria-label={t('Namespace')}
        />
      ) : (
        <FormSelect
          id="namespace"
          value={value}
          onChange={(_, val) => onChange(val)}
          aria-label={t('Namespace')}
        >
          <FormSelectOption value="" label={t('Select...')} isPlaceholder />
          {selectable.map((ns) => (
            <FormSelectOption key={ns} value={ns} label={ns} />
          ))}
        </FormSelect>
      )}
    </FormGroup>
  );
}
