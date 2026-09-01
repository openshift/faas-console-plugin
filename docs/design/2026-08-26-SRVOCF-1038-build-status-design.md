# SRVOCF-1038: Show deployment status and pipeline failures in the UI

Status: Design (prototype)
Date: 2026-08-26
Jira: SRVOCF-1038 (Story, parent SRVOCF-953)

## Problem

After "Save & Deploy", a function is pushed to GitHub, a GitHub Actions workflow
builds the image and deploys a Knative Service, and only then does the cluster
show status. Today function status comes entirely from `useCluster.ts` (a K8s
watch of the Knative Service + Deployment). That means:

- The build window (queued, building, deploying) is invisible in the UI.
- A pipeline failure (compile error, image push error) is completely invisible:
  the ksvc simply never appears and the row shows `NotDeployed` forever.

This work surfaces GitHub Actions build status, including failure reasons, in the
functions list, and keeps the list current as a deployment progresses.

## Scope (prototype)

- Surface only in the **functions list** (no separate post-save detail view).
- Simple statuses only: build is **Building**, **Succeeded**, or **Failed**.
  More granular states can come later.
- Live updates via **SSE**; plus a non-streaming snapshot endpoint.
- Deterministic testing via a scripted fake GitHub Actions API.

## Lifecycle and status merge

```
push -> GH Actions run: queued -> in_progress -> completed(success|failure)
                                                     |
                                  success -----------+--> ksvc -> Deployment ready -> Running
                                  failure -----------/        (tracked by useCluster today)
                                           (never reaches cluster; currently invisible)
```

GitHub Actions is authoritative during the build; the cluster is authoritative
after a successful deploy. The frontend merges the two per function:

A function is treated as **available** when its cluster status is `Running`
(actively serving) or `ScaledToZero` (deployed and idle, cold-starts on demand).
Both have deployed successfully at least once, so a subsequent build is a rebuild.

| GH Actions latest run        | Cluster (useCluster)      | Shown status          |
|------------------------------|---------------------------|-----------------------|
| queued / in_progress         | available (Running/ScaledToZero) | cluster status kept + secondary "build in progress" indicator |
| queued / in_progress         | not available             | `Building`            |
| completed = failure          | available (Running/ScaledToZero) | cluster status kept + secondary "build failed" indicator |
| completed = failure          | not available             | `BuildFailed`         |
| completed = success, or none | (fall through)            | existing cluster status (`Deploying`/`Running`/`ScaledToZero`/`Error`/`NotDeployed`) |

Notes:
- The build status is **non-destructive** over an available function: a function
  that is deployed and available (serving `Running`, or idle `ScaledToZero` that
  cold-starts on demand) keeps its cluster status even while a new revision builds
  or a rebuild fails, so availability is never misrepresented. The build activity
  is surfaced as a small secondary indicator next to the status: a spinner
  (tooltip "Build in progress") while building, or a red (danger-colored) warning
  icon (tooltip "Latest build failed: <reason>", link to the run) when the latest
  build failed. The failed tooltip is phrased to make clear the function is still
  available and only the latest rebuild failed, not the function itself. This
  avoids flip-flopping an available function between its cluster status and
  `Building`/`BuildFailed` on every redeploy.
- For a function that is **not** currently available, the build status is the most
  useful thing to show, so `Building` (first deploy / redeploy of a stopped
  function) and `BuildFailed` become the primary status.
- `BuildFailed` (and the secondary "build failed" indicator) carries a failure
  reason and a link to the failing run.
- The backend returns a build-centric status (`Building`/`Succeeded`/`Failed`/`None`);
  the merge to `FunctionStatus` happens in the frontend, which is the only place
  that also has the cluster status.
- **Deferred: non-destructive treatment for a cluster `Error`.** A cluster `Error`
  (ksvc `Ready=False`) means a deployed revision is broken, so a failed rebuild
  currently overwrites it with `BuildFailed`, losing the runtime signal. Ideally it
  would be handled like the available states (keep `Error` as primary, show the
  build as a secondary indicator). The catch is that `Error` is overloaded: it also
  covers a repo/list-level error (`FunctionListItem.err`, no cluster resource),
  which should keep falling through to `BuildFailed` like `NotDeployed`. Doing this
  correctly means gating the non-destructive branch on **cluster presence** (whether
  a `ClusterFunction` exists), not on the status string. Deferred to a later change.

## Transport decision: SSE over consoleFetch stream

- Server-to-client push only, so SSE fits better than WebSocket (full-duplex we
  would never use).
- The GitHub PAT lives only in the browser (sessionStorage) and reaches the
  backend as the `X-SCM-Token` header. Both native `EventSource` and native
  `WebSocket` cannot set custom headers, so they would force the PAT into a URL
  query param or WS subprotocol. Reading an SSE stream with `consoleFetch` +
  `ReadableStream` lets us send the PAT as a header cleanly. This is the same
  pattern the OpenShift Lightspeed console plugin uses for streaming chat.
- SSE is plain `net/http` + `Flusher`: zero new backend dependencies, matching
  the stdlib-only backend. WebSocket would need a third-party library.

## Backend

Stateless, matching the current design: no shared in-memory store (unlike the
removed SSE spike). Each request creates its own SCM client from the caller's
PAT; each SSE connection runs its own poll loop.

### SCM interface (`backend/scm/client.go`)

Add one method to `scm.Client`:

```go
LatestWorkflowRun(ctx context.Context, owner, repo, branch string) (*WorkflowRun, error)
```

```go
type WorkflowRun struct {
    ID            int64
    Status        string // queued | in_progress | completed
    Conclusion    string // success | failure | cancelled | timed_out | ""
    HeadSHA       string
    HTMLURL       string
    FailureReason string // set for failures: "<job> / <step>" summary
}
```

Returns `nil, nil` when the repo has no runs on that branch (maps to `None`).

### GitHub implementation (`backend/scm/github/client.go`)

- `Actions.ListRepositoryWorkflowRuns(ctx, owner, repo, &ListWorkflowRunsOptions{Branch: branch, ...})`,
  take the most recent run.
- On `conclusion == "failure"`, call `Actions.ListWorkflowJobs` and compose
  `FailureReason` from the first failed job and its first failed step.
- Errors mapped through the existing `mapErr` (401/403 -> `scm.ErrUnauthorized`).

### Endpoints (`backend/handler/build.go`)

Both are **parameterless and user-scoped**, mirroring `GET /api/v1/func/list`.
They require only the `X-SCM-Token` header and discover the caller's function
repos server-side the same way the list endpoint does (`ListRepos`,
`topic:serverless-function user:<login>`), then fetch `LatestWorkflowRun` per repo
using each repo's default branch (already returned by `ListRepos`). No owner/
name/branch params, no per-function URLs, one connection for the whole list. The
snapshot keys (`owner/repo`) match what `listFunctions` returns, so the frontend
merge is a direct key lookup.

`GET /api/v1/func/build/status` (snapshot):

```json
{
  "functions": [
    {
      "key": "matejvasek/fn-testing-a",
      "buildStatus": "Failed",
      "conclusion": "failure",
      "runURL": "https://github.com/.../actions/runs/123",
      "failureReason": "build / go test",
      "headSHA": "abc123"
    }
  ]
}
```

`buildStatus` is one of `Building | Succeeded | Failed | None`, derived from the run:
- `queued` / `in_progress` -> `Building`
- `completed` + `success` -> `Succeeded`
- `completed` + `failure|cancelled|timed_out` -> `Failed`
- no run -> `None`

`GET /api/v1/func/build/watch` (SSE):
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`.
- First event is a full snapshot (same shape as above), then a full snapshot is
  re-sent whenever any function's build status changes.
- Heartbeat comment (`:\n\n`) every 15s to survive proxy idle timeouts.
- Poll interval ~3s: each cycle fetches `LatestWorkflowRun` for every discovered
  repo and re-emits the snapshot if anything changed. The user's function set is
  discovered on connect and refreshed on a slower cadence (~30s) so newly created
  or deleted functions appear/disappear without reconnecting.
- Exit on `r.Context().Done()` or on write error (detects client disconnect
  without TCP close). Both learnings from the spike (c5a1455, f7059667).

## Fake GitHub (`backend/fakegithub`)

Add the Actions API surface plus an admin control to script runs deterministically.

GitHub API:
- `GET /repos/{owner}/{repo}/actions/runs` -> `{ total_count, workflow_runs: [...] }`,
  filtered by `?branch=`. Each run: `id, head_branch, head_sha, status, conclusion,
  html_url, created_at`.
- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` -> `{ total_count, jobs: [...] }`,
  each job: `id, name, status, conclusion, steps: [{ name, status, conclusion, number }]`.

Admin control:
- `POST /_admin/actions/runs` with `{ owner, repo, branch, headSha, status, conclusion, jobs: [...] }`
  creates/replaces the latest run for a repo. Lets tests drive queued ->
  in_progress -> failed transitions with exact control.
- `POST /_admin/reset` also clears runs.

State: add a `runs` slice (or latest-run field) to the in-memory `repo` struct.

## Frontend

### Client hook (`src/common/clients/useBuildStatus.ts`)

`useBuildStatus()` (no arguments; the backend scopes to the user) opens the SSE
stream with `consoleFetch` (PAT in `X-SCM-Token`), reads the `ReadableStream`
body, parses `event: build-status` frames, and returns
`ReadonlyMap<repoKey, BuildStatus>` where

```ts
interface BuildStatus {
  buildStatus: 'Building' | 'Succeeded' | 'Failed' | 'None';
  conclusion?: string;
  runURL?: string;
  failureReason?: string;
}
```

Handles reconnect on stream end/error with a small backoff (EventSource's
built-in reconnect is not available with fetch streaming).

### List integration (`src/pages/function-list/FunctionsListPage.tsx`)

`useFunctionListPage` calls `useBuildStatus()` alongside
`useCluster(functionNames)` and merges per the table above in `enrichItem`,
looking up each item's build status by its `owner/repo` key.

### Types and rendering

- `FunctionStatus` gains `Building` and `BuildFailed`.
- `FunctionTableItem` gains optional `buildRunURL`, `failureReason`, and
  `buildActivity` (`'Building' | 'Failed'`, set only when the primary status is an
  available cluster status (`Running`/`ScaledToZero`) that the build status must
  not overwrite).
- `StatusCell` in `FunctionTable.tsx`:
  - `Building` -> `ProgressStatus`.
  - `BuildFailed` -> error style with a tooltip showing `failureReason` and a link
    to `buildRunURL`.
  - An available status (`Running` -> `SuccessStatus`, `ScaledToZero` ->
    `InfoStatus`) with `buildActivity` renders the cluster badge plus a secondary
    indicator: a spinner (tooltip "Build in progress") for `'Building'`, or a red
    (danger-colored) warning icon (tooltip "Latest build failed: `failureReason`",
    link to `buildRunURL`) for `'Failed'`.

## Testing

Follow `docs/TESTING.md` (red/green/refactor, one test at a time).

Backend (Ginkgo/Gomega):
- `scm/github` client: `LatestWorkflowRun` happy path (in_progress, success) and
  failure path (composes `FailureReason`). Use the existing github client test
  harness; also manually cross-check against real GitHub repo
  `matejvasek/fn-testing-a` (token in `gh-token.txt`) during development.
- `handler` build endpoints: snapshot maps runs to `buildStatus`; SSE emits an
  initial snapshot then a new snapshot on change; `X-SCM-Token` required; error
  mapping. Extend `scmStub` with a `LatestWorkflowRun` function field.
- `fakegithub`: the new Actions endpoints and `/_admin/actions/runs` (directly or
  via the github client test that points at fakegithub).

Frontend (Vitest + RTL): stub the network boundary, do not `vi.mock` our own
hook. Following the SRVOCF-822 precedent (the list test stubs
`useK8sWatchResource` and runs the real `useCluster`), add a reusable
`consoleFetchStreamStub` in `src/common/testing/` that returns a `Response` whose
body is a `ReadableStream` fed SSE frames.
- `useBuildStatus.test`: real hook against the stream stub; asserts frame parsing,
  the returned map, and reconnect.
- `FunctionsListPage.test` / `FunctionTable.test`: real `useBuildStatus` via the
  same stub (alongside the existing K8s stub); asserts the `Building`/`BuildFailed`
  merge and rendering. This catches SSE-payload vs consumer shape drift.

Pragmatic fallback if streaming in jsdom proves fiddly: stub `consoleFetch`
directly (still the boundary), never mock `useBuildStatus` itself.

E2e (Playwright): run against the **real backend connected to fakegithub**, no
`page.route` mocking (e2e no longer mocks GitHub; it seeds/resets fakegithub via
`/_admin` in `e2e/helpers/fakegithub.ts`). Add a `setWorkflowRun(owner, name,
branch, run)` helper that POSTs to `/_admin/actions/runs`. A test seeds a repo,
scripts an `in_progress` run, loads the list and asserts the status column shows
`Building`, then scripts a `completed`/`failure` run and asserts the column
updates to `BuildFailed` with the failure reason and a link to the run. Because
the list streams over SSE, the update should appear without a manual refresh
(use `expect.poll` / `toBeVisible` with a timeout).

## Implementation order

1. fakegithub Actions endpoints + `/_admin/actions/runs` (foundation for tests
   and manual cross-check).
2. `scm.Client.LatestWorkflowRun` + github implementation + unit tests; cross-check
   against real GitHub.
3. Backend snapshot + SSE endpoints + handler tests; wire routes in `main.go`.
4. Frontend `useBuildStatus` hook, list merge, new statuses, `StatusCell` +
   component tests.
5. E2e test.
6. Revisit backend for anything the frontend surfaces.

## Out of scope (prototype)

- Faithful workflow execution via `act` (deferred; `/_admin` scripting instead).
- Live streaming on any surface other than the list.
- Granular per-step progress beyond Building/Succeeded/Failed.
- Persisting build history.
