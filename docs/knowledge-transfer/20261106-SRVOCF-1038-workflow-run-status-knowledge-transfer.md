# SRVOCF-1038: Workflow Run Status in the Functions List

Knowledge transfer session. Two PRs: #256 (backend, Matej), #257 (frontend, Stan).

---

## Slide 1: What We Built

The functions list now shows what each function's latest GitHub Actions workflow
run did, live-updated over SSE, alongside the cluster status it already showed.

| | |
|---|---|
| **Duration** | ~8 weeks (Sep 1 to Oct 24) |
| **PRs** | #177 (development), #256 (BE, merged), #257 (FE, merged) |
| **Commits** | 119 total (100 on #177, 19 merged) |
| **Lines merged** | +9,262 / -1,538 |
| **Files touched** | 61 |
| **Review threads** | 124 (100 on #177, 15 on #256, 9 on #257) |
| **Total comments** | 271 |
| **New patterns and tooling** | 11 (listed on the last slide) |

New patterns and tooling:

1. Composite status (two independent sources composed, not a single enum)
2. Page-level `types.ts` as view model
3. Pure functions in `types.ts` (method-on-class equivalent)
4. `using` / `Symbol.dispose` for test cleanup (`timerFake`, `AsyncQueue`, SSE tests)
5. `AsyncQueue` for async test scripting
6. `timerFake` for controlled time progression in tests
7. MSW for SSE streams
8. `sseEventSource` transport over `consoleFetch`
9. `common/errors.ts` (typed `HttpError`, `ClusterError`, `AppError`)
10. `hack/dev.sh` stop/restart backend
11. `hack/seed-testdata.sh` for manual testing

---

## Slide 2: Backend Summary

High-level overview of the BE work. Matej will present his own deep dive.

| What | Where |
|------|-------|
| ETag-caching HTTP transport | `scm/github/httpcache/etagcache.go` |
| Workflow run watch (poll + rediscovery loop) | `scm/github/workflow.go` |
| SSE handler (`GET /api/v1/func/workflow-run/watch`) | `handler/workflow.go` |
| Fakegithub Actions endpoints for e2e | `fakegithub/server.go` |
| Testable ticker abstraction | `ticker/ticker.go` |
| DTOs for the SSE wire format | `scm/client.go` |
| Design spec | `docs/design/2026-08-26-SRVOCF-1038-build-status-design.md` |

Wire contract:

- `workflow-run-status` events carry a full snapshot (no delta protocol)
- `app-error` events carry errors as structured data (message + HTTP status
  code) rather than closing the connection
- Comment frames every 15s keep proxies alive
- The stream never closes itself on error. The consumer decides what is
  terminal and calls `close()`

---

## Slide 3: Dissolve `useCluster`

`useCluster` served two pages that wanted different things from it.

- **List page** needed Knative Services and Deployments
- **Create page** needed Secrets and ConfigMaps for the env var picker

`useCluster.ts` and `useCluster.test.tsx` deleted. The tests moved into the
page tests that exercise the real call sites:

- List page: [`src/pages/function-list/FunctionsListPage.tsx`](../../src/pages/function-list/FunctionsListPage.tsx) (watch config + `withClusterData`)
- List page tests: [`src/pages/function-list/FunctionsListPage.test.tsx`](../../src/pages/function-list/FunctionsListPage.test.tsx)
- Create page: [`src/pages/function-create/FunctionCreatePage.tsx`](../../src/pages/function-create/FunctionCreatePage.tsx) (secret + configmap watch)
- Create page tests: [`src/pages/function-create/FunctionCreatePage.test.tsx`](../../src/pages/function-create/FunctionCreatePage.test.tsx)

---

## Slide 4: Move Single-Use Types Out of `common/`

`common/types.ts` had accumulated types regardless of who consumed them. Five
types were used only by the create page. `parseFuncYaml` had no remaining
callers after the backend took over func.yaml parsing.

**Before:** everything in [`common/types.ts`](../../src/common/types.ts) and `common/utils/utils.ts`.

**After:**

- [`pages/function-create/types.ts`](../../src/pages/function-create/types.ts) for `PlainEnvVar`, `ResourceEnvVar`,
  `K8sKeyedResource`, `CreateFunctionFormData`, `FunctionRuntime`
- [`pages/function-list/types.ts`](../../src/pages/function-list/types.ts) for `Function`, `FunctionStatus`,
  `ClusterStatus`, `functionKey` (view model, details on slide 6)
- `EnvVarSource` inlined into `EnvVar`, `FunctionRuntime` into
  `CreateFunctionForm`
- `handlerMap` moved into `determineHandler` (its only caller)
- `parseFuncYaml` deleted, `utils.test.ts` with it

Rule this follows: a type belongs in the narrowest directory that reads it.
Added to [`docs/ARCHITECTURE.md` L48](../../docs/ARCHITECTURE.md#L48).

---

## Slide 5: `FunctionListItem` to `FunctionMetadata`

**Before:** `FunctionListItem` with every field required. Empty strings masked
missing data.

**After:** [`FunctionMetadata`](../../src/common/types.ts) with every field optional (except `source`),
matching what the backend actually returns. The list page supplies defaults
where the table needs strings.

Wire: `"err"` renamed to `"error"`, string fields become `omitempty`.

---

## Slide 6: Composite Status

The list page carried a flat string status that conflated two independent facts:
what the cluster thinks of the function, and what its latest workflow run did.

**New type structure** in [`pages/function-list/types.ts`](../../src/pages/function-list/types.ts):

```typescript
interface FunctionStatus {
  cluster: ClusterStatus;
  workflow: WorkflowRun;
}

interface ClusterStatus {
  status: 'NotDeployed' | 'Deploying' | 'Running'
        | 'ScaledToZero' | 'Undeploying' | 'Error';
  error?: ClusterError;
}
```

[`WorkflowRun`](../../src/common/types.ts) lives in `common/types.ts` (shared with the client):

```typescript
interface WorkflowRun {
  status: 'None' | 'InProgress' | 'Succeeded' | 'Failed';
  url?: string;
  error?: AppError;
}
```

Two independent sources composed, not a single enum trying to capture every
combination.

`functionKey()` is a pure function in the same file, the method-on-class
equivalent: keys by `namespace/name` for cluster-matched entries,
`~owner/repoName` for repo-only entries.

Also introduced [`common/errors.ts`](../../src/common/errors.ts) for `HttpError`,
`ClusterError`, and `AppError`.

---

## Slide 7: `FunctionTable` Test Folded into Page Test

The `FunctionTable` unit test was deleted and its cases folded into
[`FunctionsListPage.test.tsx`](../../src/pages/function-list/FunctionsListPage.test.tsx).

The table is only ever rendered by the list page. Testing it through the page
exercises the real derivation (cluster status, workflow status, metadata
merging) instead of hand-built row objects that can drift from reality.

---

## Slide 8: SSE Event Source Transport

**Problem:** Native `EventSource` cannot send custom headers (`X-SCM-Token`),
and cannot use `consoleFetch`, which the OCP console requires for its auth
headers. It also hides the HTTP status on failure.

**Intermediate Solution:** [`createSSEEventSource`](../../src/common/transport/sseEventSource.ts)
in `common/transport/sseEventSource.ts`.

Same consumer API as native (`addEventListener`, `close`), but:

- Accepts a custom `fetchFn` (so we use `consoleFetch`) and custom `headers`
- Passes `timeout: 0` because `consoleFetch`'s default ~60s timeout would kill
  the long-lived stream
- `error` listener receives `Error` or `HttpError` with a status code
- Transport always reconnects; consumer decides what is terminal by calling
  `close()`

Migration path documented in the source: once HTTP-only session cookies replace
PAT headers, native `EventSource` can be used.

---

## Slide 9: SSE Transport Tests

Tested with MSW (intercepts at the network level) + two new test utilities.

### `AsyncQueue<T>` ([`common/testing/AsyncQueue.ts`](../../src/common/testing/AsyncQueue.ts))

Async producer-consumer queue. `enqueue()` is synchronous and buffers.
`dequeue()` returns immediately with a buffered value or waits for the next
`enqueue()`. Supports `for await...of` and `Symbol.dispose` (`using`).

Used to script SSE event sequences in tests:

```typescript
using es = createEventSource();
using events = captureEvents(es, 'workflow-run-status');

const data = await events.dequeue();
expect(data).toBe('{"a/b":{"status":"InProgress"}}');
```

### `timerFake()` ([`common/testing/timerFake.ts`](../../src/common/testing/timerFake.ts))

Disposable wrapper around `vi.useFakeTimers({ shouldAdvanceTime: true })`.
Returns `advance(ms)` for controlled time progression. `Symbol.dispose` runs
pending timers and restores real timers.

```typescript
using timer = timerFake();
// ... trigger reconnect ...
await timer.advance(3100);
// assert reconnected
```

All in [`sseEventSource.test.ts`](../../src/common/transport/sseEventSource.test.ts).

---

## Slide 10: Consuming the Stream in the List Page

[`useFunctions`](../../src/pages/function-list/FunctionsListPage.tsx) composes three data sources:

| # | Source | What it provides |
|---|--------|------------------|
| 1 | `listFunctions()` (one-shot fetch) | Repo identity, func.yaml fields, repo-level errors |
| 2 | `useK8sWatchResource` (K8s watch) | Cluster status, route URL, replicas, ksvc resource |
| 3 | `receiveWorkflowRunEvents` (SSE) | Workflow run status keyed by `owner/repoName` |

Sources are independent. Each enriches the base `Function` map built from
source 1. Source 2 enriches with cluster data (only for functions with a
parseable name). Source 3 enriches with workflow data (only for functions with
an owner/repoName).

### `receiveWorkflowRunEvents` ([`functionsClient.ts`](../../src/common/clients/functionsClient.ts))

Thin wrapper around `createSSEEventSource`. Listens for three event types:

- `workflow-run-status`: parses JSON, calls `eventCbk`
- `app-error`: on 401, reports auth expiry and calls `es.close()`; otherwise
  passes message through to `errorCbk`
- `error`: formats `HttpError` or generic connection loss message

Returns a `close` function. The `useEffect` cleanup calls it.

---

## Slide 11: StatusCell Rendering

[`StatusCell`](../../src/pages/function-list/components/FunctionTable.tsx) in
`FunctionTable.tsx` renders two independent indicators side by side using a
PatternFly `Flex`:

**Cluster status** (primary): `NotDeployed`, `Running`, `ScaledToZero`,
`Deploying`, `Undeploying`, `Error` (with tooltip showing `ClusterError.message`).

**Workflow status** (secondary, beside the cluster status):

| Workflow status | Rendered as |
|----------------|-------------|
| `None` | nothing |
| `Succeeded` | nothing (no news is good news) |
| `InProgress` | spinning sync icon with tooltip |
| `Failed` | danger triangle icon, linked to the GitHub Actions run URL |

Repo-level errors (e.g. broken `func.yaml`) take over the primary slot. The
workflow indicator still appears beside it.

---

## Slide 12: `functionsClientStub` for Page Tests

[`receiveWorkflowRunEventsStub`](../../src/common/testing/functionsClientStub.ts)
supports two modes:

- **Static snapshot:** one-shot `workflow-run-status` frame, stream stays open
- **Scripted stream:** accepts an `AsyncIterable<WorkflowRunStreamEvent>`,
  encodes each event as an SSE frame, closes when the iterable ends

The scripted mode lets page tests walk a function through status transitions:

```typescript
const stream = new AsyncQueue<WorkflowRunStreamEvent>();
receiveWorkflowRunEventsStub({ stream });

// ... render page ...
stream.enqueue({ type: 'workflow-run-status', runs: { 'a/b': { status: 'InProgress' } } });
// ... assert spinner ...
stream.enqueue({ type: 'workflow-run-status', runs: { 'a/b': { status: 'Failed', url: '...' } } });
// ... assert failure link ...
```

---

## Slide 13: E2E Tests

New test file:
[`e2e/use-cases/list/workflow-run-status.test.ts`](../../e2e/use-cases/list/workflow-run-status.test.ts).

Tests use [`setWorkflowRun()`](../../e2e/helpers/fakegithub.ts) to script
fakegithub runs and rely on the SSE stream's ~3s poll cadence to deliver
updates without manual refresh.

The tests follow good testing practice and are isolated: they set up their own
initial state and clean up after, they do not rely on state from other tests.

```typescript
test.beforeEach(async ({ page }) => {
  // The namespace must exist or the backend reports a namespace error, which
  // takes over the status cell this suite asserts on.
  await ensureNamespace(page, PRESEEDED_FUNC_NAMESPACE);
  await seedRepo(E2E_USER, FUNC_NAME, BRANCH, ['serverless-function'], [
    { path: 'func.yaml', mode: '100644', content: `name: ${FUNC_NAME}\n...` },
  ]);
});

test.afterEach(async () => {
  await deleteRepoOnFakeGithub(E2E_USER, FUNC_NAME);
});

test.afterAll(async () => {
  await resetFakeGithub();
});
```

---

## Slide 14: Manual Testing with `seed-testdata.sh`

The workflow indicator is hard to reproduce manually.
[`hack/seed-testdata.sh`](../../hack/seed-testdata.sh) and the matching `make`
targets seed fakegithub and/or the cluster:

```bash
make seed                          # repo only (NotDeployed)
make seed-cluster                  # repo + cluster ksvc (Running)
make seed-build-in_progress        # repo + Building status
make seed-build-failure            # repo + BuildFailed status
make seed-build-success            # repo + Succeeded status
make seed-cleanup                  # delete seeded repo + cluster ksvc
make seed-cleanup-all              # reset all fakegithub + delete all func ksvc's
```

Prerequisite: dev environment running with `hack/dev.sh --fake-gh`.

---

## Slide 15: Documentation Changes

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md): co-location convention
  for page-scoped `types.ts`, ownership rule for extracted components
- [`docs/TESTING.md`](../../docs/TESTING.md): new test utilities (`timerFake`,
  `AsyncQueue`), `receiveWorkflowRunEventsStub`, manual testing section with
  seed commands
- [`docs/design/2026-08-26-SRVOCF-1038-build-status-design.md`](../../docs/design/2026-08-26-SRVOCF-1038-build-status-design.md):
  design spec (pre-existing, updated with rename from "build" to "workflow run")

---

## Slide 16: Patterns and Tooling Worth Knowing

| # | Pattern / Tool | Where | Why |
|---|---------------|-------|-----|
| 1 | Composite status | [`FunctionStatus`](../../src/pages/function-list/types.ts) | Two independent sources composed, not a combinatorial enum |
| 2 | Page-level `types.ts` as view model | [`function-list/types.ts`](../../src/pages/function-list/types.ts), [`function-create/types.ts`](../../src/pages/function-create/types.ts) | Types belong in the narrowest directory that reads them |
| 3 | Pure functions in `types.ts` | [`functionKey()`](../../src/pages/function-list/types.ts) | Method-on-class equivalent without a class |
| 4 | `using` / `Symbol.dispose` | [`timerFake`](../../src/common/testing/timerFake.ts), [`AsyncQueue`](../../src/common/testing/AsyncQueue.ts), SSE tests | Teardown cannot be forgotten; scoped to the block |
| 5 | `AsyncQueue` | [`common/testing/AsyncQueue.ts`](../../src/common/testing/AsyncQueue.ts) | Async producer-consumer for scripting event sequences in tests |
| 6 | `timerFake` | [`common/testing/timerFake.ts`](../../src/common/testing/timerFake.ts) | Controlled time progression without manual `vi.useFakeTimers` setup/teardown |
| 7 | MSW for SSE streams | [`functionsClientStub.ts`](../../src/common/testing/functionsClientStub.ts) | Same MSW boundary used for REST; SSE is just a `ReadableStream` response |
| 8 | `sseEventSource` transport | [`common/transport/sseEventSource.ts`](../../src/common/transport/sseEventSource.ts) | EventSource-compatible over `consoleFetch` with custom headers |
| 9 | `common/errors.ts` | [`common/errors.ts`](../../src/common/errors.ts) | Typed `HttpError`, `ClusterError`, `AppError` in one place |
| 10 | `hack/dev.sh` stop/restart backend | [`hack/dev.sh`](../../hack/dev.sh) | Backend can be restarted without restarting the full dev stack |
| 11 | `hack/seed-testdata.sh` | [`hack/seed-testdata.sh`](../../hack/seed-testdata.sh) | Reproducible manual testing for hard-to-trigger states |
