# SRVOCF-1046: Namespace UX on the Create Function form

**Status:** ACTIVE

**Jira:** [SRVOCF-1046](https://redhat.atlassian.net/browse/SRVOCF-1046) (Story, parent SRVOCF-956). Consolidates and supersedes SRVOCF-1075 (system-namespace warning) and SRVOCF-1076 (non-existent-namespace error), both closed as duplicates.

**Goal:** Improve the namespace field on the Create Function form: warn on system namespaces, handle non-existent namespaces with a clear message, and make the field role-aware (free-text for admins, prefilled/dropdown for developers).

**Scope for this pass:** frontend only. Admin auto-creation of a non-existent namespace on deploy is deferred (backend/follow-up).

## Background (from investigation)

- The namespace field is currently a free-text `TextInput` in `src/pages/function-create/components/CreateFunctionForm.tsx`. No SDK namespace helpers are used anywhere yet.
- Namespace state flows: `TextInput` -> `setField('namespace')` -> `onNamespaceChange` -> `FunctionCreatePage` `useFunctionCreatePage` (debounced 300ms) -> `useClusterService([], debouncedNamespace)`.
- RBAC / ServiceAccount provisioning is client-side in `src/common/services/cluster/OcpClusterService.ts` `generateKubeconfig(namespace)`. A missing namespace throws a k8s 404 there (not from the Go backend), surfaced raw via `errorMessage` in `FunctionCreatePage` (danger Alert).
- `useClusterService` already watches Secrets/ConfigMaps in the namespace and exposes an `error` (a 404 for a missing namespace) that the form currently ignores.
- Available frontend-only from `@openshift-console/dynamic-plugin-sdk` (currently unused): `useAccessReview` / `useAccessReviewAllowed` (admin detection), `useK8sWatchResource` on `project.openshift.io/v1 Project` (accessible namespaces), `k8sGetResource`/`k8sCreateResource`.
- UI patterns to match: inline `Alert` (system-ns warning already added), `FormSelect` + `FormSelectOption` (existing runtime/secret/configmap selects).

## Tasks

### Task 1: `isSystemNamespace` helper (DONE)

- Pure helper in `src/common/utils/utils.ts`, unit-tested. Prefixes `openshift-`, `kube-`; exact `default`, `openshift`, `kube-system`, `kube-public`, `kube-node-lease`.

### Task 2: System namespace warning on the form (DONE)

- Inline `Alert variant="warning"` inside the Namespace `FormGroup` when `isSystemNamespace(namespace)`. Does not block. i18n string extracted.

### Task 3: Non-existent namespace handling (SRVOCF-1076) (DONE)

- `isNotFoundError` helper in `src/common/utils/utils.ts`, unit-tested. Detects k8s 404/NotFound across `{code:404}`, `{reason:'NotFound'}`, `Error` with `status:404`, and `{response:{status:404}}`.
- `useClusterService` now returns a `namespaceMissing` boolean (true when a namespace is set and the Secret/ConfigMap watch returns a not-found error). Not-found watch errors are no longer surfaced via the generic `error`.
- `CreateFunctionForm` takes a `namespaceMissing` prop and shows an inline warning ("Namespace \"X\" does not exist.") near the Namespace field when the field is non-empty. Does not block Create.
- `FunctionCreatePage` threads `namespaceMissing` through and maps a submit-time k8s 404 to the same friendly message instead of the raw `http code: 404 ...`.
- i18n string extracted. All tests pass (226).

### Task 4: Role-aware namespace field (SRVOCF-1046) (DONE)

- New `NamespaceField` component in `src/pages/function-create/components/NamespaceField.tsx` owns the role-aware rendering plus the system-ns and does-not-exist warnings. It uses an inline `useNamespaceOptions` hook that returns `{ role, namespaces, loading }` from `useAccessReview` (can create namespaces => admin) and `useK8sWatchResource` on `project.openshift.io/v1 Project`.
- Rendering by role:
  - Admin: free-text `TextInput` + system-ns warning + does-not-exist warning (from Task 3).
  - Developer, exactly one namespace: prefilled, disabled input; auto-fires `onChange` with that namespace.
  - Developer, more than one: `FormSelect` of accessible namespaces (placeholder "Select...").
  - Developer, zero namespaces: inline info Alert to contact an administrator.
  - While loading: a `Skeleton` placeholder, no control.
- `CreateFunctionForm` now renders `<NamespaceField>` instead of the inline namespace FormGroup; `setField('namespace', ...)` (registry update + env-var reset + `onNamespaceChange`) still runs via the `onChange` callback.
- Tests: `NamespaceField.test.tsx` covers every role branch and loading (SDK hooks mocked at the boundary). Existing form/page tests mock `useAccessReview` as admin so free-text behavior is unchanged. i18n strings extracted. All tests pass (237).

## Acceptance criteria (from Jira)

- System namespace shows an inline warning; creation not blocked. (DONE)
- Non-existent namespace shows an inline message while typing; submit shows a friendly not-found error.
- Admin sees a validated text input.
- Developer with one namespace: prefilled, read-only.
- Developer with many: dropdown of accessible namespaces.
- Detection helpers are unit-tested; UI matches existing inline-alert / FormSelect patterns.

## Out of scope (deferred)

- Admin auto-creation of a non-existent namespace on deploy ("will be created on deploy") - backend/follow-up.
