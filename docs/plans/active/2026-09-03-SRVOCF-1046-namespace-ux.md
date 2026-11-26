# SRVOCF-1046: Namespace UX on the Create Function form

**Status:** IN REVIEW

**Jira:** [SRVOCF-1046](https://redhat.atlassian.net/browse/SRVOCF-1046) (Story, parent SRVOCF-956). Consolidates and supersedes SRVOCF-1075 (system-namespace warning) and SRVOCF-1076 (non-existent-namespace error), both closed as duplicates.

**Goal:** Improve the namespace field on the Create Function form: warn on system namespaces, handle non-existent namespaces with a clear message, and make the field role-aware (a dropdown for everyone: all namespaces for users who can create namespaces, non-system ones for everyone else).

**Scope:** namespace options and Secret/ConfigMap lookups move to the backend. Admin auto-creation of a non-existent namespace on deploy is deferred.

## Design

### Backend

All endpoints call the cluster with the user's own token (`Authorization` header), never the plugin service account.

- `GET /api/v1/namespaces` (`backend/handler/namespaces.go`) returns `{ namespaces, systemNamespaces, canCreateNamespaces }`.
  - Lists `project.openshift.io/v1` Projects through client-go's dynamic client (no `openshift/client-go` dependency) and runs a SelfSubjectAccessReview for `create namespaces`, in parallel.
  - The system-namespace rule (`openshift`, `default`, `openshift-*`, `kube-*`, `knative-*`) lives only in `cluster.IsSystemNamespace`. Users who cannot create namespaces never receive system namespaces; users who can receive all of them, with the system ones also listed in `systemNamespaces`.
- `GET /api/v1/namespaces/{namespace}/secrets` and `.../configmaps` (`backend/handler/envsources.go`) return `[{ name, keys }]`: key names only, never values. Invalid namespace names return 400, a forbidden list returns 403.

### Frontend

- `FunctionCreatePage` loads namespace options (`getNamespaces`) and holds the form behind a spinner until they arrive. A failed load shows the error instead of the form.
- The page resolves the prefill: the console's active namespace if the user may pick it and it is not a system namespace, otherwise the sole namespace for a user who cannot create namespaces. The form seeds its field from it once.
- The form owns the namespace. A dropdown pick makes the page fetch Secrets and ConfigMaps for it right away. The form only offers lists that belong to the namespace in the field.
- Secrets/ConfigMaps load errors show their own alert. A 403 shows an info hint that the namespace's Secrets/ConfigMaps cannot be used. There are no live updates; lists are refetched when the namespace changes.
- Namespace field by role:
  - Can create namespaces: dropdown of every namespace, system ones included, with a warning when a namespace in `systemNamespaces` is picked. There is no free-text input, so a namespace that does not exist cannot be entered.
  - Cannot create namespaces, one namespace: prefilled, read-only.
  - Cannot create namespaces, several: dropdown.
  - No namespaces at all: info message.

## Acceptance criteria (from Jira)

- System namespace shows an inline warning; creation not blocked. (DONE)
- Non-existent namespace shows an inline message while typing; submit shows a friendly not-found error. (SUPERSEDED: the field is always a dropdown of existing namespaces, so a non-existent one cannot be entered.)
- Admin sees a validated text input. (CHANGED: admins pick from a dropdown of every namespace, system ones included.)
- Developer with one namespace: prefilled, read-only. (DONE)
- Developer with many: dropdown of accessible namespaces. (DONE)
- Detection helpers are unit-tested; UI matches existing inline-alert / FormSelect patterns. (DONE)

## Out of scope (deferred)

- Admin auto-creation of a non-existent namespace on deploy ("will be created on deploy") - backend/follow-up.
