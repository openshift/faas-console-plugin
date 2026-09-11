# Deploy/Undeploy toggle for the functions list

Date: 2026-09-08
Tickets: SRVOCF-1071 (undeploy button + disabled tooltip), SRVOCF-1072 (deploy button)
Delivered together in PR #181.

## Summary

The functions list currently has a single "undeploy" action (a `PowerOffIcon` button
wired to the delete modal on the Knative Service). This work turns that action into a
single, status-driven toggle button (PatternFly `Button`) that shows the one action
valid for the current state:

- When the function is deployed, the button reads "Undeploy". Clicking it undeploys the
  function (existing delete-modal flow).
- When the function is not deployed, the button reads "Deploy". Clicking it deploys the
  function by triggering the GitHub Actions `workflow_dispatch` of the function's generated
  workflow.
- While the cluster reports a transitional state, the button is disabled with an
  explanatory tooltip.

The button is the last action in the row (after Edit).

## Goals

- One toggle button per function that reflects and controls deployment state based on status.
- Deploy triggers the generated GitHub Actions workflow via `workflow_dispatch`.
- Disabled states carry a tooltip that explains why (the SRVOCF-1071 fix).
- Unit tests and an end-to-end test covering the new flow.

## Non-goals / accepted limitations

- **Existing functions cannot be deployed.** The generated workflow only gains the
  `workflow_dispatch` trigger going forward (see below). Functions created before this
  change have push-only workflows; a deploy attempt against them fails gracefully with an
  inline error Alert. We are not rewriting old repositories' workflow files.
- **Build-phase gating is out of scope.** The ticket asks for the button to be disabled
  during "building". Build status comes from GitHub Actions and is the subject of
  SRVOCF-1038 (PR #177, not yet merged). Until that lands we gate only on cluster-derived
  status. Full build-aware disabling is deferred.
- No green / colored state beyond the button's default styling (the Undeploy state uses a
  danger-styled secondary button; the Status column already renders `Running` in green).

## Background: how deploy must work

The function's workflow file (`.github/workflows/func-deploy.yaml`) is produced by the
vendored knative `func` library, not by a local template. Its `on:` block defaults to
`push` only; the library adds a `workflow_dispatch` trigger only when
`WorkflowConfig.WorkflowDispatch` is true, and the repo's wrapper
(`backend/functions/ci.go`) never sets it. So to make functions dispatchable we set
`WorkflowDispatch: true` there. This affects newly created functions only.

Deploy is therefore: call GitHub's `POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches`
with `{ref: <branch>}`, using the user's PAT. The workflow then builds and deploys, and
the function's Knative Service eventually appears on the cluster, at which point the
existing `useCluster` derivation flips the row's status to `Deploying` then `Running`.

## Status mapping

Derived `FunctionStatus` (from `src/common/types.ts`) drives the button. The button's
label and accessible name are "Deploy" when not deployed and "Undeploy" when deployed.

| Status                                   | Button label | Enabled | Action / notes |
|------------------------------------------|--------------|---------|----------------|
| `NotDeployed`, `Error` (with a repo)     | Deploy       | yes     | clicking dispatches the workflow |
| `Running`, `ScaledToZero`                | Undeploy     | yes     | clicking opens the existing delete modal |
| `Deploying` (and other transitional)     | Deploy       | no      | tooltip "Function is not ready to deploy yet" |
| deployable status but no source repo     | Deploy       | no      | tooltip "No source repository to deploy" |

`CreatingRepo`, `Pushing`, `PushedToGitHub`, `Unknown` are declared in the type but not
produced by current derivation; they are treated as non-deployable (disabled Deploy button
with the transitional tooltip) if encountered.

A `NotDeployed`/`Error` function that has no source repository (a cluster-only function,
`source === 'cluster'`) cannot be dispatched, so its Deploy button is disabled with a
tooltip, mirroring how `EditActionButton` guards the edit action.

The button label is derived from status, not held locally. If the user cancels the
undeploy modal, the button stays "Undeploy" because the cluster status is still `Running`.
After a deploy dispatch the button stays "Deploy" until the cluster status flips to
`Deploying`/`Running`.

## Design

### Backend

1. **Enable the trigger** - `backend/functions/ci.go`: add `WorkflowDispatch: true` to the
   `WorkflowConfig` passed to `NewWorkflowGenerator`.

2. **SCM client** - add to the `scm.Client` interface (`backend/scm/client.go`):

   ```go
   DispatchWorkflow(ctx context.Context, owner, repo, workflowFileName, ref string) error
   ```

   Implement in `backend/scm/github/client.go` via
   `Actions.CreateWorkflowDispatchEventByFileName(ctx, owner, repo, workflowFileName,
   ghlib.CreateWorkflowDispatchEventRequest{Ref: ref})`, error-mapped through `mapErr`.
   Add the method (and a settable func field) to `ClientStub` for tests.

3. **Handler + route** - new `backend/handler/deploy.go`, `HandleFuncDeploy`:
   - Read `X-SCM-Token` (401 if missing), `{owner}`/`{name}` from the path, `branch` from
     the JSON request body.
   - Dispatch the known workflow file (`func-deploy.yaml`, referenced via the func lib's
     `DefaultGitHubWorkflowFilename` rather than a hardcoded string).
   - Map errors like `create.go`: `ErrUnauthorized`->401, upstream failure->502.
   - Respond `202 Accepted`.
   - Register `POST /api/v1/func/{owner}/{name}/deploy` in `backend/main.go`.

### Frontend

4. **Client** - `deployFunction(owner, name, branch)` in
   `src/common/clients/functionsClient.ts`, following the `putFiles` pattern (path params,
   `scmHeaders()`, `consoleFetch`).

5. **Toggle button** - replace `UndeployActionButton` in
   `src/pages/function-list/components/FunctionTable.tsx` with a status-driven PatternFly
   `Button` per the mapping above, placed in the action list after Edit. The button shows
   the single action valid for the current state: "Deploy" (play icon) fires deploy
   immediately (no modal) and calls back to the page, which surfaces success/failure
   feedback; "Undeploy" (power-off icon, danger-styled secondary) keeps the existing
   delete-modal flow. Disabled states use `isAriaDisabled` (which keeps the button
   hoverable) wrapped in a `Tooltip`. The button's label and accessible name are "Deploy"
   when not deployed and "Undeploy" when deployed.

6. **Data plumbing** - add `owner` and `branch` to `FunctionTableItem`; the list page
   already has `owner`/`defaultBranch` from the list response, so map them through.

### Deploy feedback mechanism

The codebase has no toast/notification system (no `useToast`, `AlertGroup`, or console SDK
toast usage anywhere). `FunctionsListPage` already renders transient feedback with an inline
PatternFly `Alert variant="danger" isInline` for listing errors. Reuse that pattern: the
page holds a `deployNotice` state and renders an inline `Alert` (`success` on dispatch,
`danger` on failure) above the table. Do not introduce a new notification pattern.

## Testing

### Unit

- Backend `deploy_test.go`: dispatch success (202), missing `X-SCM-Token` (401), upstream
  failure (502); `ClientStub.DispatchWorkflow` wiring.
- Frontend `FunctionTable.test.tsx`: renders a Deploy vs Undeploy button per status;
  `Deploying` disabled; clicking Deploy calls `onDeploy`; clicking Undeploy launches the
  undeploy modal; disabled tooltip present.
- `functionsClient` test for `deployFunction` (URL, headers, body).

### E2E (Playwright)

- Fake GitHub (`e2e/helpers/fakegithub.ts`): add a route for
  `POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches` -> 204, recording the
  call for assertion.
- New `e2e/use-cases/deploy/function-deploy.test.ts`:
  - Deploy button shown and enabled for a `NotDeployed` function.
  - Clicking Deploy dispatches the workflow (assert fake GitHub received it) and shows
    the success Alert.
  - Button flips to Undeploy after deploy (driven by `simulateGitHubActionsDeploy`).
- Rework `e2e/use-cases/delete/function-delete.test.ts`: use button lookups (role `button`
  named "Deploy"/"Undeploy"); replace the now-invalid "disabled for not deployed" assertion
  (a `NotDeployed` function now shows an enabled Deploy button).

## Files touched

Backend: `functions/ci.go`, `scm/client.go`, `scm/github/client.go`, `handler/deploy.go`
(new), `main.go`, plus tests.
Frontend: `common/clients/functionsClient.ts`, `common/types.ts`,
`pages/function-list/components/FunctionTable.tsx`,
`pages/function-list/FunctionsListPage.tsx`, plus tests.
E2E: `helpers/fakegithub.ts`, `use-cases/deploy/function-deploy.test.ts` (new),
`use-cases/delete/function-delete.test.ts`.
