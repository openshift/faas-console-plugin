# SRVOCF-1038: Show deployment status and pipeline failures in the UI

Status: Implemented (prototype)
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
- Live updates via **SSE**, one stream for the whole list.
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

A function is treated as **known to the cluster** when `useCluster` found a
`ClusterFunction` for it, whatever its status (`Running`, `ScaledToZero`,
`Deploying` or `Error`). It has deployed at least once, so a subsequent build is
a rebuild.

| GH Actions latest run        | Cluster (useCluster)      | Shown status          |
|------------------------------|---------------------------|-----------------------|
| queued / in_progress         | in cluster                | cluster status kept + secondary "build in progress" indicator |
| queued / in_progress         | not in cluster            | `Building`            |
| completed = failure          | in cluster                | cluster status kept + secondary "build failed" indicator |
| completed = failure          | not in cluster            | `BuildFailed`         |
| completed = success, or none | (fall through)            | existing cluster status (`Deploying`/`Running`/`ScaledToZero`/`Error`/`NotDeployed`) |

Notes:
- The build status is **non-destructive** over a function the cluster knows
  about: it keeps its cluster status even while a new revision builds or a
  rebuild fails, so the cluster state is never misrepresented. The build activity
  is surfaced as a small secondary indicator next to the status: a spinner
  (tooltip "Build in progress") while building, or a red (danger-colored) warning
  icon (tooltip "Latest build failed", link to the run) when the latest build
  failed. The failed tooltip is phrased to make clear the function is still
  available and only the latest rebuild failed, not the function itself. This
  avoids flip-flopping a deployed function between its cluster status and
  `Building`/`BuildFailed` on every redeploy.
- The gate is **cluster presence, not the status value.** Gating on availability
  (`Running`/`ScaledToZero`) instead looked equivalent but was not: a live
  function reports `Deploying` for a second or two while the build applies its new
  revision (ksvc `Ready=Unknown`, or no Deployment for the latest ready revision
  yet), and during that window the merge overwrote the status with `Building`, so
  every redeploy flickered `Running` -> `Building` -> `Running`. Cluster presence
  also keeps a broken ksvc (`Ready=False` -> `Error`) as the primary status
  instead of hiding it behind `BuildFailed`.
- For a function the cluster does **not** know about, the build status is the most
  useful thing to show, so `Building` (first deploy / redeploy of a deleted
  function) and `BuildFailed` become the primary status. This includes a
  repo-level `Error` (`FunctionListItem.err`, no cluster resource), which keeps
  falling through like `NotDeployed`.
- `BuildFailed` (and the secondary "build failed" indicator) links to the failing
  run. No failure reason is surfaced in the list; the run is one click away.
- The backend returns a build-centric status (`Building`/`Succeeded`/`Failed`/`None`);
  the merge to `FunctionStatus` happens in the frontend, which is the only place
  that also has the cluster status.
- `Error` is overloaded, and cluster presence is what separates its two senses: a
  cluster `Error` (ksvc `Ready=False`) means a deployed revision is broken and
  stays primary, while a repo-level `Error` (`FunctionListItem.err`) has no
  cluster resource and yields to the build status.

## Source decision: polling GitHub, not webhooks

GitHub can push `workflow_run` events to a webhook, which would be lower latency
than a 3s poll, but it is a much bigger system: a publicly reachable route into
the cluster, a webhook plus signing secret registered and kept in sync on every
function repo, signature verification, and server-side state to fan each event
out to the right browser session. Polling needs none of that. It runs inside the
existing user-scoped request, holds no state beyond the life of the connection
(matching the stateless backend below), and unchanged polls are 304s, so the
steady-state cost is close to zero. The push that is actually needed, backend to
browser, is the one SSE provides.

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

Add one method to `scm.Client`. Polling lives behind it, so the handler stays a
pure SSE writer and the whole poll loop is stubbable in handler tests:

```go
WatchWorkflowRuns(ctx context.Context, workflowFile string) (<-chan []RepoRun, error)
```

```go
// RepoRun pairs a repo with its latest run. A nil Run means no run yet
// (including when the workflow file does not exist there).
type RepoRun struct {
    Repo Repo
    Run  *WorkflowRun
}

type WorkflowRun struct {
    ID         int64
    Status     string // queued | in_progress | completed
    Conclusion string // success | failure | cancelled | timed_out | ""
    HeadSHA    string
    HTMLURL    string
}
```

The workflow file is the only parameter; the method is otherwise
**user-scoped**. It discovers the caller's function repos itself (`ListRepos`,
`topic:serverless-function user:<login>`) and polls each one's default branch.
Discovery runs synchronously so an auth failure is returned to the caller
instead of being lost in the goroutine. `Repo.FullName()` (`owner/name`) is the
key everything is correlated on, matching what `listFunctions` returns.

### GitHub implementation (`backend/scm/github/watch.go`)

- Per repo, `Actions.ListWorkflowRunsByFileName(ctx, owner, repo, workflowFile,
  {Branch: defaultBranch, PerPage: 1})`. Runs come back `created_at` descending,
  so the single element is the newest. A 404 means the workflow does not exist
  there (a non-func repo, or not pushed yet) and maps to no run.
- Scoped to a single workflow file, `functions.WorkflowFilename` (func's
  `func-deploy.yaml`), so an unrelated workflow in the same repo cannot be
  reported as the function's build.
- No per-job lookup. A composed failure reason ("<job> / <step>") was tried and
  dropped: it cost an extra `ListWorkflowJobs` call per failed repo per poll, it
  is GitHub-Actions-shaped and would not port to another builder, and it told a
  user little they would not get by opening the run.
- Repos are polled concurrently (errgroup, limit 10). A per-repo error carries
  that repo's last-known run forward rather than flickering the status to `None`.
- The channel carries **changes only**: a snapshot equal to the previous one is
  not sent.
- Poll interval ~3s. The repo set is rediscovered on a slower cadence (~30s) so
  newly created or deleted functions appear/disappear without reconnecting. A
  rediscover that comes back `ErrUnauthorized` (token revoked mid-stream) closes
  the channel rather than leaving the client on stale status.
- Errors mapped through the existing `mapErr` (401/403 -> `scm.ErrUnauthorized`).
- The GitHub HTTP client wraps `httpcache.NewMemoryCacheTransport()` in a
  `forceRevalidate` RoundTripper (`Cache-Control: max-age=0`), so every poll is a
  conditional request. Unchanged runs answer 304, which does not count against
  the primary rate limit. The cache is per-PAT, like the client.

### Endpoint (`backend/handler/build.go`)

`GET /api/v1/func/build/watch` (SSE) is the only build endpoint. It is
**parameterless and user-scoped**, mirroring `GET /api/v1/func/list`: it requires
only the `X-SCM-Token` header, and repo discovery happens inside
`WatchWorkflowRuns`. No owner/name/branch params, no per-function URLs, one
connection for the whole list.

- `WatchWorkflowRuns` is called before any SSE header is written, so an auth
  failure surfaces as a normal `401` instead of an error frame on an
  already-committed stream.
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`, then an immediate flush so
  the client's request completes and it can start reading.
- Each snapshot from the channel is written as one `event: build-status` frame.
  The first frame is the full snapshot; a full snapshot is re-sent whenever any
  function's build status changes.
- Heartbeat comment (`:\n\n`) every 15s to survive proxy idle timeouts.
- Exit on `r.Context().Done()`, on write error (detects client disconnect
  without TCP close), or when the watch channel closes. The first two are
  learnings from the spike (c5a1455, f7059667).

Snapshot payload, keyed by `owner/name`. A map rather than an array so the
frontend merge is a direct key lookup, and because `encoding/json` sorts map
keys, an unchanged snapshot always serializes to the same bytes:

```json
{
  "functions": {
    "matejvasek/fn-testing-a": {
      "buildStatus": "Failed",
      "conclusion": "failure",
      "runURL": "https://github.com/.../actions/runs/123",
      "headSHA": "abc123"
    }
  }
}
```

`buildStatus` is one of `Building | Succeeded | Failed | None`, derived from the run:
- `queued` / `in_progress`, plus the gated `waiting` / `requested` / `pending` -> `Building`
- `completed` + `success` -> `Succeeded`
- `completed` + `failure|cancelled|timed_out` -> `Failed`
- `completed` + `skipped|neutral|stale|action_required` -> `None`; these are not
  failures, so the frontend falls back to the cluster status rather than showing
  a red badge
- no run -> `None`

## Fake GitHub (`backend/fakegithub`)

Add the Actions API surface plus an admin control to script runs deterministically.

GitHub API:
- `GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs` ->
  `{ total_count, workflow_runs: [...] }`, filtered by `?branch=` and by the
  workflow file in the path, mirroring real GitHub. Each run: `id, head_branch,
  head_sha, status, conclusion, html_url, created_at`. The repo-wide
  `/actions/runs` listing is deliberately not implemented: nothing calls it once
  build status is scoped to one workflow.

Admin control:
- `POST /_admin/actions/runs` with `{ owner, repo, branch, headSha, status,
  conclusion, workflow }` creates/replaces the latest run for a repo.
  Lets tests drive queued -> in_progress -> failed transitions with exact control.
  `workflow` defaults to the func build workflow; set it to script a run under a
  different workflow and assert build status stays scoped.
- `POST /_admin/reset` also clears runs.

State: add a `runs` slice (or latest-run field) to the in-memory `repo` struct.

## Frontend

### Client hook (`src/common/clients/useBuildStatus.ts`)

`useBuildStatus(connectionId)` opens the SSE stream with `consoleFetch` (PAT in
`X-SCM-Token`, timeout `0` so the SDK's ~60s abort does not kill a long-lived
stream), reads the `ReadableStream` body, parses `event: build-status` frames,
and returns `ReadonlyMap<repoKey, BuildStatus>` where

```ts
interface BuildStatus {
  buildStatus: 'Building' | 'Succeeded' | 'Failed' | 'None';
  conclusion?: string;
  runURL?: string;
}
```

There are no per-function arguments; the backend scopes the stream to the user.
`connectionId` comes from the auth context, so the stream tears down and
reconnects with the current PAT on in-place login and account switch.

Handles reconnect on stream end/error with a small backoff (EventSource's
built-in reconnect is not available with fetch streaming). A 401/403 is the
exception: a bad or expired PAT will not recover, so the hook stops instead of
reconnecting in a tight loop.

### List integration (`src/pages/function-list/FunctionsListPage.tsx`)

`useFunctionListPage` calls `useBuildStatus(connectionId)` alongside
`useCluster(functionNames)` and merges per the table above in `enrichItem`,
looking up each item's build status by its `owner/repo` key.

### Types and rendering

- `FunctionStatus` gains `Building` and `BuildFailed`.
- `FunctionTableItem` gains optional `buildRunURL` and
  `buildActivity` (`'Building' | 'Failed'`, set only when the primary status is a
  cluster status that the build status must not overwrite).
- `StatusCell` in `FunctionTable.tsx`:
  - `Building` -> `ProgressStatus`.
  - `BuildFailed` -> error style linking to `buildRunURL`. No tooltip: the badge
    already reads "BuildFailed", so one would only repeat it.
  - A cluster status (`Running` -> `SuccessStatus`, `ScaledToZero` ->
    `InfoStatus`, `Deploying` -> `ProgressStatus`, `Error` -> `ErrorStatus`) with
    `buildActivity` renders the cluster badge plus a secondary indicator: a
    spinner (tooltip "Build in progress") for `'Building'`, or a red
    (danger-colored) warning icon (tooltip "Latest build failed", link to
    `buildRunURL`) for `'Failed'`.

## Testing

Follow `docs/TESTING.md` (red/green/refactor, one test at a time).

Backend (Ginkgo/Gomega):
- `scm/github` client: `WatchWorkflowRuns` happy path (in_progress, success),
  failure path, change-only emission, per-repo error carry-forward, rediscovery,
  missing workflow file, and conditional-request revalidation. Use the existing github client test harness; also manually
  cross-check against real GitHub repo `matejvasek/fn-testing-a` (token in
  `gh-token.txt`) during development.
- `handler` build endpoint: snapshot maps runs to `buildStatus`; SSE emits an
  initial snapshot then a new snapshot on change; heartbeats; `X-SCM-Token`
  required; error mapping; channel close ends the stream. Drive it through
  `scm.ClientStub.OnWatchWorkflowRuns`.
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
updates to `BuildFailed` with a link to the run. Because
the list streams over SSE, the update should appear without a manual refresh
(use `expect.poll` / `toBeVisible` with a timeout).

## Implementation order

1. fakegithub Actions endpoints + `/_admin/actions/runs` (foundation for tests
   and manual cross-check).
2. `scm.Client.WatchWorkflowRuns` + github implementation + unit tests; cross-check
   against real GitHub.
3. Backend SSE endpoint + handler tests; wire the route in `main.go`.
4. Frontend `useBuildStatus` hook, list merge, new statuses, `StatusCell` +
   component tests.
5. E2e test.
6. Revisit backend for anything the frontend surfaces.

## Out of scope (prototype)

- Faithful workflow execution via `act` (deferred; `/_admin` scripting instead).
- Live streaming on any surface other than the list.
- Granular per-step progress beyond Building/Succeeded/Failed.
- Persisting build history.
