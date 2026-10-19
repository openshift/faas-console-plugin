# SRVOCF-1038: Build status in the functions list

Status: Implemented prototype, as implemented at the snapshot below.
Original design date: 2026-08-26.
Implementation snapshot: `80ced39a8886b9081c8c2b1753a52fd8b6fba589`.

This document describes existing behavior, including limitations, at that commit
rather than the current default branch. It is not an implementation plan or a
claim that every test passes.

## Purpose and architecture

The functions list combines repository metadata, live Knative Service and
Deployment watches, and the latest GitHub Actions workflow run. It shows build
activity before a function reaches the cluster and preserves cluster status
while a deployed function rebuilds. Failure badges link to the workflow run;
there is no job/step failure-reason lookup.

```text
GitHub user + function repositories
  -> SCM discovery and polling of default-branch func-deploy.yaml runs
  -> WorkflowWatch: full snapshots or watch-wide errors
  -> BuildWatch HTTP handler: build-status / app-error SSE events
  -> createSSEEventSource: generic fetch-based transport
  -> receiveWorkflowRunEvents: JSON decoding and application-error policy
  -> page-local useFunctions: metadata + K8s watches + workflow snapshots
  -> FunctionTable / StatusCell: cluster status and workflow activity
```

The backend polls GitHub; SSE pushes the resulting snapshots to the browser.
There is no webhook receiver, shared watch fan-out, or durable build history on
this path. Each build-watch request creates an SCM client, its own HTTP cache,
and its own polling loop. The list's metadata request is separate from the
workflow watch. Rediscovering a repository in the workflow watch does not itself
insert a row into the metadata list.

## Backend discovery and watch contract

`scm.Client` exposes:

```go
WatchWorkflowRuns(ctx context.Context, workflowFile string) (WorkflowWatch, error)

type WorkflowWatch interface {
    ResultChan() <-chan WorkflowRunsOrErr
    Stop()
}

type WorkflowRunsOrErr struct {
    Runs map[string]WorkflowRun
    Err  error
}

type WorkflowRun struct {
    BuildStatus BuildStatus
    HTMLURL     string
    Error       error
}
```

`BuildStatus` is an integer enum with string forms `None`, `Building`,
`Succeeded`, and `Failed`. Map keys are repository full names, `owner/repo`.
A zero-value run represents no build status, not a nil map entry.

Initial discovery runs synchronously using the caller's context. `ListRepos`
looks up the authenticated GitHub user and paginates a repository search for
`topic:serverless-function user:<login>`, 100 results per page. The handler passes
`functions.WorkflowFilename`, the func workflow constant used to generate
`func-deploy.yaml`. Each repository is polled on its default branch using
`Actions.ListWorkflowRunsByFileName`, with `PerPage: 1`. The implementation uses
the first returned run as latest; unrelated workflow files are not queried.
A missing workflow (404) or empty run list becomes a zero-value run.

### Polling, cancellation, and deduplication

- An initial poll emits the full repository map, including an empty map when
  discovery returns no repositories. Polling then defaults to every 3 seconds;
  repository rediscovery defaults to every 30 seconds. Polls run with at most
  10 concurrent repository requests. These are ticker cadences, not a guarantee
  of end-to-end update latency.
- Successful rediscovery replaces the repository set. Additions and removals
  reach the snapshot on a subsequent poll, not immediately on rediscovery.
- The poll loop uses a background-derived context independent of the caller's
  context after initial discovery. Consumers must call `Stop()`. It cancels
  polling, releases blocked channel sends, stops the tickers, and the goroutine
  closes the result channel. `Stop()` itself does not wait for that closure.
- Each poll produces a full snapshot. `reflect.DeepEqual` suppresses snapshots
  equal to the previously emitted map when there is no watch-wide error. This
  comparison is over derived status, URL, and error, not raw run IDs or SHAs.
- A repository poll failure retains that repository's last-known status and URL
  and sets `WorkflowRun.Error`. With no previous value it retains `None`.
  Repeated failures with the same error message reuse the previous error
  instance so deduplication can suppress them. A successful poll clears the
  error. One repository's failure does not discard other repositories' results.
- Rediscovery failure emits the previous map plus `WorkflowRunsOrErr.Err` and
  continues the loop, including for authorization errors. These watch-wide
  errors are not suppressed by snapshot equality.

The HTTP client has a per-client in-memory cache. `forceRevalidate` sets
`Cache-Control: max-age=0` and `drainOnClose` drains response bodies so the cache
can store them. Tests exercise conditional requests and 304 revalidation across
payload sizes. Caching does not eliminate requests or guarantee a 304 response.

### Exact build-status mapping

| GitHub run status | Conclusion | SCM status |
| --- | --- | --- |
| `queued`, `in_progress`, `waiting`, `requested`, `pending` | any | `Building` |
| `completed` | `success` | `Succeeded` |
| `completed` | `failure`, `cancelled`, `timed_out`, `startup_failure` | `Failed` |
| `completed` | anything else, including `skipped`, `neutral`, `stale`, `action_required` | `None` |
| any other status, no run, or missing workflow | any | `None` |

For an existing run, its HTML URL is retained even if its derived status is
`None`. No run ID, conclusion, head SHA, job name, or step name is sent to the
frontend.

## SSE endpoint and wire format

`GET /api/v1/func/build/watch` has no owner, repository, branch, or namespace
parameters. Discovery is scoped to the authenticated SCM user, not the list's
active namespace or cluster filter. The client supplies `X-SCM-Token`.

If the response writer cannot flush, the handler returns HTTP 500. Otherwise it
sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`Connection: keep-alive`, and `X-Accel-Buffering: no`, commits HTTP 200, and
flushes **before** checking the token or starting discovery. Consequently early
application failures are SSE events, not HTTP 401/502 responses.

Each successful watch result becomes a full `build-status` snapshot with no
outer wrapper. Optional `url` and `error` fields are omitted when empty:

```text
event: build-status
data: {"example/hello":{"status":"Building","url":"https://github.com/example/hello/actions/runs/123"},"example/new":{"status":"None"}}

event: build-status
data: {"example/hello":{"status":"Failed","url":"https://github.com/example/hello/actions/runs/124"},"example/new":{"status":"None"}}

```

The handler sends a heartbeat comment, `:\n\n`, every 15 seconds while its
event loop is active. It flushes snapshots, watch-wide errors, and heartbeats.
It returns on request cancellation, write failure, or result-channel closure,
and defers `watch.Stop()` after successfully obtaining a watch.

### Error scopes and sanitization

| Scope | Wire behavior | Stream behavior |
| --- | --- | --- |
| Missing token | `app-error`, message `X-SCM-Token header is required`, code `401` | Handler returns |
| Unauthorized initial discovery | `app-error`, message `invalid SCM token`, code `401` | Handler returns |
| Other initial discovery failure | `app-error`, message `failed to list repositories`, code `502` | Handler returns |
| Repository poll failure | That entry's `error: {message, code?}` in `build-status`, with retained status/URL | Polling continues |
| Rediscovery failure | `app-error: {message, code?}`; handler does not serialize the accompanying retained map | Polling and handler continue |

`mapErr` maps GitHub `ErrorResponse` HTTP 401/403 to `scm.ErrUnauthorized`.
For runtime errors, the handler sends only these sanitized messages:

- Authorization: `Authentication failed. Please check your access token.`, with
  code `401`.
- Other errors: `Unable to fetch build status. Please try again later.`, without
  a code.

For example, a transient repository failure can carry stale but useful state:

```text
event: build-status
data: {"example/hello":{"status":"Building","url":"https://github.com/example/hello/actions/runs/123","error":{"message":"Unable to fetch build status. Please try again later."}}}

event: app-error
data: {"message":"Authentication failed. Please check your access token.","code":401}

```

Raw upstream errors are logged server-side rather than embedded in these error
DTOs. The browser reads the PAT from session storage and passes it in the
request header, not a URL parameter. This describes the build-status path, not
a general security guarantee for all backend endpoints.

## Frontend transport and data flow

### What changed in the frontend

The frontend comparison is from
`375493f796d1e162bd4d012eff93399fc10c3688` to the implementation snapshot.
Previously, the list page fetched repository metadata, delegated Kubernetes
state to the shared `useCluster` hook, and enriched table items from that
result. Its page-loaded flag waited for both metadata and cluster loading.
The shared hook is deleted in this comparison. The list now owns a local
`useFunctions` that joins metadata, Kubernetes watches, and the new workflow
stream; it exposes metadata loading separately from ongoing live updates.

The model changes with that ownership: page-local `FunctionStatus` contains
independent `cluster: ClusterStatus` and `workflow: WorkflowRun` values, rather
than one flat status value. The metadata type is renamed from `FunctionListItem`
to `FunctionMetadata`; it and the new workflow wire types are defined in
`src/common/types.ts`. The list's joined `Function` and cluster
types live in `src/pages/function-list/types.ts`. `ClusterError` carries cluster
condition details, `AppError` represents protocol application errors, and
`HttpError` represents transport HTTP failures. These are not interchangeable
build-failure reasons.

Kubernetes watches, namespace/name row identity, and source/resource-based row
actions are retained, not introduced by the workflow stream. `AuthProvider`
is unchanged across this comparison: its existing `onLogin` increments
`connectionId`. The page already consumed that counter for metadata reloads;
the new receiver lifecycle also uses it to acquire current SCM headers.

### Ownership boundaries

| Layer | Owns | Outside its responsibility |
| --- | --- | --- |
| `createSSEEventSource` | Fetch, framing, named-event dispatch, transport errors, reconnect delay, and cancellation | Workflow JSON interpretation and terminal application-error policy |
| `receiveWorkflowRunEvents` | Console fetch/SCM headers, workflow JSON decoding, error messages, and closing on top-level `app-error` code 401 | React effects, namespace scope, row joins, and rendered state |
| Page-local `useFunctions` | Metadata request lifecycle, K8s watches, workflow snapshots, joins, and page errors | Status precedence, links, icons, and row-action presentation |
| `FunctionTable` / `StatusCell` | Presentation of the joined cluster/workflow state and row actions | Fetching, parsing, and subscription lifecycle |

This separation is visible in the interfaces: transport events contain raw
`data` strings, the receiver emits `WorkflowRunRecord` and returns a close
function, and the hook passes joined `Function` values to the table. The
transport does not know repository keys or React state. In particular, retrying
HTTP errors belongs to transport while deciding that an application 401 is
terminal belongs to the receiver. The custom fetch requirement below explains
why native EventSource cannot replace the transport as it stands.

### Generic fetch-based transport

`createSSEEventSource` uses an injected fetch function and headers rather than
native `EventSource`, allowing the Console SDK's `consoleFetch` and SCM token
header. It passes timeout `0` for the long-lived request. Its API exposes
`open`, generic named-event listeners, transport `error` listeners, and `close`.

The parser buffers decoded chunks, splits frames on LF/LF, ignores comment
lines and frames without an event name or data, and joins multiple `data:`
lines with a newline. Multiple frames and delimiters split across chunks are
handled. This is not a complete browser EventSource implementation: there is
no event-ID replay, server `retry:` handling, or CRLF frame-delimiter support.

Fetch/read failures notify transport-error listeners; non-OK HTTP responses
become `HttpError`. Normal stream completion reconnects too. The default delay
is a fixed 3 seconds, not exponential backoff. A response without a body takes
an immediate retry path before the delay. HTTP errors, including 401/403, do
not themselves stop the transport. Listener exceptions are logged and do not
stop event delivery. `close()` aborts the request and pending delay and clears
listeners.

### Client policy and page ownership

`receiveWorkflowRunEvents` supplies `consoleFetch` and the SCM headers. It
decodes `build-status` JSON directly as `WorkflowRunRecord`, a plain record of
`{status, url?, error?}` keyed by `owner/repo`. It returns a close function.
There is no standalone `useBuildStatus` hook at this snapshot.

An `app-error` with code 401 reports
`Authentication expired. Reconnect to GitHub and refresh.` and closes the
transport. Other application errors pass their message to the consumer without
closing. HTTP errors report `Server error (<status>)`; other transport errors
report connection loss and reconnection. JSON is parsed without runtime schema
validation. Malformed JSON throws into the transport's listener-error handling
and is logged, rather than becoming a user-facing application error.

The page-local `useFunctions` in `FunctionsListPage.tsx`:

1. Fetches namespace-scoped metadata via `listFunctions`, initializing rows by
   `namespace/name` with cluster `NotDeployed` and workflow `None`.
2. Watches Knative Services and Deployments using the function-name label and
   active namespace (or all namespaces). It enriches rows with cluster status,
   route URL, replicas, and the main Kubernetes resource.
3. Opens the workflow receiver when authenticated and replaces the workflow
   record on each snapshot. `withWorkflowRunData` correlates rows by
   `owner/repoName`, independently of their namespace/name identity.
4. Passes separate cluster and workflow state to `FunctionTable`. List errors,
   K8s watch errors, and receiver errors appear as page-level danger alerts.
   A received snapshot clears the receiver error; an `open` event alone does not.

`loaded` is exactly `listLoaded`, not an aggregate readiness signal. Metadata
success or failure ends initial loading; the unauthenticated path marks it
loaded without fetching. The page does not wait for either Kubernetes watch or
the first workflow snapshot before rendering the list. Until each K8s watch is
loaded, its data is treated as empty. Metadata rows start with cluster
`NotDeployed`, workflow `None`, an empty route URL, and no replicas or main
resource. Available K8s data and any retained workflow snapshot can immediately
override those defaults. Thus an initial status is not proof that all three
sources have completed. Once a Knative Service is available but no Deployment
is found, cluster derivation yields `Deploying`.

Repository metadata `err` and per-repository workflow `error` are not rendered
as dedicated row errors by this page. The latter remains in workflow state;
rendering uses status and URL. Neither is a job/step build failure reason.
An entry's nested `error.code: 401` does not trigger terminal authentication
handling; the receiver closes only for a top-level `app-error` with code 401.

## Cluster/workflow rendering

The status model retains both sources; it does not overwrite a cluster enum
with a build enum. `StatusCell` selects the primary presentation:

| Cluster state | Workflow `None` | Workflow `Building` | Workflow `Succeeded` | Workflow `Failed` |
| --- | --- | --- | --- | --- |
| `NotDeployed` | Not deployed | Building + spinning workflow icon | Deploying | Build failed, linked when URL exists |
| `Running` | Running | Running + spinning workflow icon | Running | Running + failure icon |
| `ScaledToZero` | Scaled to zero | Scaled to zero + spinning workflow icon | Scaled to zero | Scaled to zero + failure icon |
| `Deploying` | Deploying | Deploying + spinning workflow icon | Deploying | Deploying + failure icon |
| `Undeploying` | Undeploying | Undeploying + spinning workflow icon | Undeploying | Undeploying + failure icon |
| `Error` | Error | Error + spinning workflow icon | Error | Error + failure icon |

These are translated labels, not all literal enum spellings. Building,
Deploying, Undeploying, NotDeployed, and ScaledToZero use `InfoStatus`; Running
uses `SuccessStatus`; primary BuildFailed and cluster Error use `ErrorStatus`.
The spinning icon tooltip is `Workflow run in progress`. The secondary danger
icon tooltip is `Latest workflow run failed`; it links to the run when a URL
exists. Run links open a new tab with `noopener noreferrer`. Cluster Error has
a tooltip from `ClusterError.message`, which includes the condition reason,
not the full Kubernetes condition message.

Cluster derivation checks deletion first (`Undeploying`), then absence of a
Deployment (`Deploying`), then the Knative Ready condition. No Ready condition
or an unknown Ready status means `Deploying`. Ready=True with both desired and
ready replicas zero means `ScaledToZero`; otherwise it means `Running`.
Ready=False means `Error` only after a Deployment has been found. Deployment
matching uses namespace and the latest ready revision label when available,
otherwise the function-name label.

The table's service URL is `routeURL` from the Knative Service's `status.url`,
not the GitHub workflow URL. Workflow links are confined to status presentation.
Rows without cluster enrichment have absent replicas and display a dash
placeholder; enrichment uses Deployment `readyReplicas`, defaulting to zero if
unavailable. The Knative Service becomes `mainResource`, enabling the existing
Undeploy action. Without that resource the action is disabled. Edit still uses
`repoName` and is unavailable for cluster-sourced rows. The Edit button retains
`isAriaDisabled` rather than native disabling so its explanatory tooltip can
receive hover events; the click handler also checks the disabled condition.
The comparison adds the explanatory comment, not this disabling behavior.

## Lifecycle and prototype limitations

The metadata effect depends on `[connectionId, namespace, refreshKey]`; the
workflow receiver effect depends only on `[connectionId, refreshKey]`. The page
passes `undefined` as the connection ID when unauthenticated. Metadata effect
cleanup sets an `ignore` flag so an obsolete request cannot update its state;
it does not abort that HTTP request. Receiver cleanup calls its close function,
which aborts the active stream and pending reconnect delay.

| Event | Metadata, loading, and K8s state | Workflow snapshot and receiver state |
| --- | --- | --- |
| Mount | Metadata starts empty and `listLoaded` false; an authenticated page fetches metadata and configures K8s watches from its function names and active namespace. An unauthenticated metadata effect marks loading complete without a request. | Starts with an empty workflow record and no receiver error. Only an authenticated page opens a receiver. |
| Metadata request completes | Success replaces metadata and clears `listError`; failure sets `listError` without replacing current metadata. Both set `listLoaded` true and `refreshing` false. Neither waits for K8s watches. | Does not wait for, replace, or clear workflow state. |
| K8s watch updates | Each watch's loaded flag gates use of its data; the cluster join recalculates status, route, replicas, and resource. Watch errors are read from the SDK and included in page alerts. | Does not restart the receiver or alter its snapshot. |
| Workflow snapshot or error | Does not refetch metadata or change its loading flag. | A snapshot replaces the whole record and clears `receiveError`. An error sets `receiveError` and preserves the record; top-level application 401 also closes the receiver. |
| Manual Refresh | When authenticated, increments `refreshKey`, sets `listLoaded` false and `refreshing` true, and fetches metadata again. Preserves current rows and `listError` until completion; the page keeps the table visible with the button spinner. | Closes the old receiver and starts a new one. Preserves the workflow record and receiver error until a snapshot or subsequent error changes them. |
| Namespace changes | Clears metadata and `listError`, resets loading and refreshing, and refetches metadata; watch configuration follows the namespace and new function names. The page hides stale rows behind initial loading. | Does not itself restart the user-wide stream or clear workflow state/error. |
| Connection/account changes | The existing login counter changes `connectionId`, clearing metadata and `listError` and resetting loading/refreshing before refetch. Obsolete metadata completions are ignored. | Closes the previous receiver and, if authenticated, opens one with current headers. Does not explicitly clear the workflow record or receiver error. |
| Transport reconnect or `open` | Does not refetch metadata or change loading. | Transport retries without rerunning the React effect. Retains the last snapshot and error; `open` alone does not clear the error. A later snapshot does. |
| Unmount | Metadata cleanup ignores late completions; SDK hooks own K8s subscriptions. | Receiver cleanup closes the stream and pending retry. A later mount starts with fresh hook state. |

Workflow retention applies while this hook remains mounted, including manual
refresh and connection changes. It can temporarily expose stale workflow state
across an account switch when the newly loaded rows match retained repository
keys. Neither stream cleanup nor metadata's obsolete-response guard clears
that workflow state. There is no account-keyed snapshot reset guarantee.

Other limits:

- The watch has no namespace/cluster filtering, whereas the metadata endpoint
  filters repositories by cluster and namespace. Extra workflow entries do not
  create rows. Latest-run status is not correlated to a cluster revision or a
  particular save operation; success without a matching cluster resource is
  displayed as Deploying, with no frontend timeout for that state.
- Only the functions list consumes this live status. There is no post-save
  progress surface, per-step progress, webhook ingestion, or persisted history
  on this path. Session-cookie transport or native EventSource migration is
  not implemented here.

## Fake GitHub and existing test coverage

`backend/fakegithub/server.go` implements
`GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs`. It filters scripted
runs by workflow and optional branch and returns newest-appended first. It
returns all matching scripted runs, rather than implementing the production
client's `per_page=1` pagination. There is no repo-wide Actions runs route.

`POST /_admin/actions/runs` requires a seeded repository and accepts owner, repo,
branch, headSha, status, conclusion, and workflow. Branch defaults to `main` and
workflow defaults to `functions.WorkflowFilename`. Each call appends a new
immutable run record with an increasing ID and generated GitHub run URL; it
does not update an existing run. Tests simulate transitions by appending newer
runs. `POST /_admin/reset` clears repository state, including stored runs, but
does not reset the server's run-ID sequence.

Coverage present in this snapshot:

| Test source | Exercised behavior |
| --- | --- |
| `backend/scm/github/watch_test.go` | Conditional cache revalidation, initial discovery auth errors, initial/change-only snapshots, per-repo carry-forward and repeated-error suppression, rediscovery, missing workflow, Stop, failure isolation, status mapping |
| `backend/handler/build_test.go` | Early app-errors over HTTP 200, heartbeat, exact snapshot DTOs, omitted optional fields, channel closure, continued streaming after errors, Stop on request cancellation |
| `backend/fakegithub/server_test.go` | Scripted runs, latest-run retrieval, branch/workflow scoping |
| `src/common/transport/sseEventSource.test.ts` | Named frames, comments, sequential/large/chunk-split frames, open/errors/retry, body-less retry, listener exceptions, close, timeout zero |
| `src/common/clients/functionsClient.test.ts` | Parsed snapshots, terminal 401 app-error, other app-errors, HTTP/network error messages |
| `src/pages/function-list/FunctionsListPage.test.tsx` | Real page/hooks/client with MSW and SDK boundary doubles; status composition, links, stream errors/recovery, retained workflow status after application errors, refresh behavior, namespace scoping |

Relative to the comparison base, testing moves with the frontend ownership:
the shared `useCluster.test.tsx` and standalone `FunctionTable.test.tsx` files
are deleted, while `FunctionsListPage.test.tsx` is expanded to exercise cluster
derivation and table presentation through the real page. New transport tests
exercise framing, retry, and cancellation independently of workflow semantics;
new client tests exercise decoding and protocol-error policy. The page tests
then cover their composition using MSW for HTTP/SSE and SDK doubles for cluster
watches, consistent with `docs/TESTING.md`. This describes a redistribution of
test responsibilities, not proof that every deleted assertion has an exact
replacement or that live Console integration passes.

Shared streaming test infrastructure includes
`src/common/testing/functionsClientStub.ts`, `src/common/testing/AsyncQueue.ts`,
and `src/common/testing/timerFake.ts`.
There is no `useBuildStatus` hook to mock at this snapshot. Repository test
commands are `make unit-frontend`, `make unit-backend`, and `make test-e2e`;
the latter needs the configured Console/cluster environment described in
`docs/TESTING.md` and `hack/test-prow-e2e.sh`.

Multiline `data:` joining is implemented in the transport but is not directly
exercised by its test file at this snapshot. Cross-account workflow retention
is a source-derived limitation, not a tested account-switch guarantee.

`e2e/use-cases/list/build-status.test.ts` scripts the real backend/fakegithub
path, but its first-build assertions still expect Not deployed plus an icon
named "build in progress". Current rendering instead shows Building and an
icon named "Workflow run in progress". The test expresses intended E2E coverage,
not evidence that the snapshot's assertions pass. This documentation update
does not repair that test or claim a successful E2E execution.
