# Monitoring Integration POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove end-to-end function monitoring: a backend endpoint that queries Thanos with the backend's own identity, authorizes each caller, and returns metric DTOs; a frontend that polls it on a shared interval and renders PatternFly charts on the Functions list and a new Function detail page.

**Architecture:** Backend `monitoring` package holds a metric *catalog* (each entry = scope + unit + PromQL builder), a Thanos client (prometheus/client_golang, credential from `kube.ComponentConfig()`), and a per-request `SelfSubjectAccessReview` + server-injected namespace matcher. One endpoint `GET /api/v1/monitoring/metrics` selects a catalog entry by id. Frontend has a shared polling layer + toolbar driving a dumb `<MetricCard>` fed by a fetch-to-chart adapter. Adding a chart later is a catalog entry + a card reference - no new endpoint.

**Tech Stack:** Go (`net/http`, `k8s.io/client-go`, `github.com/prometheus/client_golang`), React + TypeScript + PatternFly 6 + `@patternfly/react-charts` (victory), OCP Dynamic Plugin SDK.

**Spec:** `docs/design/2026-11-12-SRVOCF-1173-monitoring-poc-design.md` (read it alongside this plan).

## Global Constraints

- This is a spike/POC: **no automated tests are required** (explicit user + project instruction). Verification steps are functional: `go build ./...` + `go vet ./...` (backend), `yarn tsc --noEmit` / `yarn lint` + visual-in-app (frontend), and `curl` against the running dev endpoint. Keep code structured so tests *could* be added later without rework.
- Backend module declares `go 1.26.0`. Pin `github.com/prometheus/client_golang` at a v1.25.x release (requires Go 1.26; `QueryRange`/`Query` return annotations alongside warnings - confirm exact signatures at pin time).
- Frontend: react-core is `6.6.1`, React `^18.3.1`. Pin `@patternfly/react-charts` at a v8.x release; import charts from `@patternfly/react-charts/victory`. Record the exact patch.
- Frontend never sends PromQL or backend URLs - only a metric id + selection params.
- Never render missing data as zero. `no-data`, `stale`, `error` are distinct from a real `0` value.
- Writing style: no em dashes in code comments or docs.
- Follow the layered architecture (`docs/ARCHITECTURE.md`) and backend package/dependency rules. The `monitoring` package imports `kube` only; `handler` imports `monitoring`.

## Review Focus

Inputs/conditions the spec implies that no happy-path check exercises; each gets a functional check in the owning task:

- **Real zero vs no-data** (Task 1, Task 9): a function scaled to zero returns a `data` point `v:0` (scaling chart); an idle request-rate query returns `no-data`. They must render differently.
- **SSAR denied** (Task 3, Task 4): a caller without access to the target namespace gets an `error`/forbidden state, not another namespace's data, and never an unscoped query.
- **In-cluster token rotation** (Task 2): the Thanos transport reads the SA token fresh per request (projected file rotates), not snapshotted once.
- **topk / series cap** (Task 1, Task 4): the overview query is `topk(N,...)` and the response is capped at the max-series limit so a busy cluster cannot return thousands of series.
- **Stale data** (Task 1, Task 4): when the newest sample is older than the freshness threshold, state is `stale` and last-known series are still returned (so the card can show them under a stale badge).

---

## Task 1: `monitoring` package - types, catalog, result mapping

**Files:**
- Create: `backend/monitoring/types.go` (DTO, Scope, State, Selector)
- Create: `backend/monitoring/catalog.go` (Descriptor + the three entries + lookup)
- Create: `backend/monitoring/result.go` (Prometheus `model.Matrix` -> `Response`, state derivation)

**Interfaces:**
- Produces:
  - `type Scope string` with `ScopeNamespace`, `ScopeFunction`.
  - `type State string` with `StateData`, `StateNoData`, `StateStale`, `StateError`.
  - `type Selector struct { Namespace, Function string }` (caller-supplied; `Namespace==""` means all-namespaces; `ReadableNamespaces []string` optional for the partial-access regex).
  - `type Point struct { T float64 \`json:"t"\`; V float64 \`json:"v"\` }`
  - `type Series struct { Name string \`json:"name"\`; Points []Point \`json:"points"\` }`
  - `type Response struct { State State \`json:"state"\`; Metric string \`json:"metric"\`; Unit string \`json:"unit"\`; Series []Series \`json:"series,omitempty"\`; AsOf *float64 \`json:"asOf,omitempty"\`; Message string \`json:"message,omitempty"\` }`
  - `type Descriptor struct { ID string; Scope Scope; Unit string; BuildRangeQuery func(Selector) string }`
  - `func Lookup(id string) (Descriptor, bool)` over an unexported `catalog map[string]Descriptor`.
  - `func MapMatrix(m model.Matrix, d Descriptor, now time.Time, staleAfter time.Duration) Response` - builds series (series name from `service_name`, prefixed with `namespace_name` when present), sets `AsOf` to the newest sample, returns `StateNoData` for empty, `StateStale` when `now - AsOf > staleAfter`, else `StateData`.

- [ ] **Step 1: Define types** in `types.go` exactly as the Interfaces block lists.

- [ ] **Step 2: Define the catalog** in `catalog.go` with three entries. Label schemes come from the design's validated findings:
  - `request-rate` (ScopeNamespace, unit `req/s`): `topk(10, sum by (namespace_name, service_name)(rate(activator_request_count{<nsMatch>}[5m])))`, where `<nsMatch>` is `namespace_name="<Namespace>"` when scoped, `namespace_name=~"<regex>"` when a readable set is given, or empty for cluster-wide. Build via a helper `knativeNsMatcher(sel)`.
  - `pod-scaling` (ScopeFunction, unit `pods`): two-series query returning actual and desired - `label_replace(autoscaler_actual_pods{namespace_name="<ns>",service_name="<fn>"}, "series","actual","","") or label_replace(autoscaler_desired_pods{...}, "series","desired","","")` (series name taken from the injected `series` label). Keep the exact approach to the implementer; the requirement is two named series "actual" and "desired".
  - `memory-usage` (ScopeFunction, unit `bytes`): `sum by (pod)(container_memory_working_set_bytes{namespace="<ns>",container="user-container"} * on(namespace,pod) group_left() kube_pod_labels{namespace="<ns>",label_function_knative_dev_name="<fn>"})`. Note the **standard `namespace`** label here, not `namespace_name`.

- [ ] **Step 3: Implement `MapMatrix`** in `result.go` per its signature. Series naming, `AsOf`, and the no-data/stale/data derivation as described. Do not collapse a real `0` sample to no-data.

- [ ] **Step 4: Verify build + vet.**
Run: `cd backend && go build ./monitoring/... && go vet ./monitoring/...`
Expected: no errors. (`model.Matrix` is `github.com/prometheus/common/model`; adding the import pulls the dep - acceptable, pinned in Task 2.)

- [ ] **Step 5: Commit.**
```bash
git add backend/monitoring/types.go backend/monitoring/catalog.go backend/monitoring/result.go
git commit -m "feat(monitoring): metric catalog, DTO types, and result mapping"
```

---

## Task 2: Thanos client

**Files:**
- Create: `backend/monitoring/client.go`
- Modify: `backend/go.mod` / `backend/go.sum` (pin `client_golang` v1.25.x)

**Interfaces:**
- Consumes: nothing from earlier tasks (uses `*rest.Config` from `kube.ComponentConfig()`, passed in by the caller in Task 4).
- Produces:
  - `func NewClient(thanosURL string, caCertPath string, tokenSource func() (string, error)) (*Client, error)` - builds a `prometheus/client_golang/api` client whose `RoundTripper` sets `Authorization: Bearer <tokenSource()>` per request and uses a TLS config with RootCAs from `caCertPath` when non-empty, else `InsecureSkipVerify: true` (dev route).
  - `func TokenSourceFromConfig(cfg *rest.Config) func() (string, error)` - returns a source that reads `cfg.BearerTokenFile` fresh when set (in-cluster rotation), else returns `cfg.BearerToken`.
  - `func (c *Client) QueryRange(ctx context.Context, query string, start, end time.Time, step time.Duration) (model.Matrix, error)` - wraps `v1.API.QueryRange`, returns the matrix (asserting `model.Matrix`), discards warnings/annotations, maps upstream failure to a wrapped error.

- [ ] **Step 1: Pin the dependency.**
Run: `cd backend && go get github.com/prometheus/client_golang@v1.25.0 && go mod tidy`
Expected: resolves; record the exact version in the commit. Adjust to the latest v1.25.x if 1.25.0 is unavailable.

- [ ] **Step 2: Implement `TokenSourceFromConfig` and the bearer-injecting RoundTripper** per signatures.

- [ ] **Step 3: Implement `NewClient` and `QueryRange`** per signatures, using `api.NewClient(api.Config{Address: thanosURL, RoundTripper: rt})` and `v1.NewAPI(...)`.

- [ ] **Step 4: Verify build + vet.**
Run: `cd backend && go build ./monitoring/... && go vet ./monitoring/...`
Expected: no errors.

- [ ] **Step 5: Commit.**
```bash
git add backend/monitoring/client.go backend/go.mod backend/go.sum
git commit -m "feat(monitoring): Thanos query client with rotating-token transport"
```

---

## Task 3: Authorization (SelfSubjectAccessReview)

**Files:**
- Create: `backend/monitoring/authz.go`

**Interfaces:**
- Consumes: `kube.UserConfig(host, token, caCert)` (existing) to build a clientset from the caller's token.
- Produces:
  - `func CanReadNamespace(ctx context.Context, host string, caCert []byte, callerToken, namespace string) (bool, error)` - creates an `authorizationv1.SelfSubjectAccessReview` for `ResourceAttributes{Namespace: namespace, Verb: "get", Resource: "pods"}` with the caller's token, returns `Status.Allowed`.
  - `func CanReadClusterWide(ctx context.Context, host string, caCert []byte, callerToken string) (bool, error)` - SSAR with `Namespace: ""` (cluster-scoped `get pods`) for the all-namespaces overview.

- [ ] **Step 1: Implement both functions** per signatures using `clientset.AuthorizationV1().SelfSubjectAccessReviews().Create(...)`.

- [ ] **Step 2: Verify build + vet.**
Run: `cd backend && go build ./monitoring/... && go vet ./monitoring/...`
Expected: no errors.

- [ ] **Step 3: Commit.**
```bash
git add backend/monitoring/authz.go
git commit -m "feat(monitoring): per-caller SelfSubjectAccessReview authorization"
```

---

## Task 4: Metrics HTTP handler + wiring

**Files:**
- Create: `backend/handler/monitoring.go`
- Modify: `backend/handler/handler.go` (add monitoring deps to `Handlers` + `New`)
- Modify: `backend/main.go` (new flags; build `monitoring.Client`; pass into `handler.New`; register route)

**Interfaces:**
- Consumes: Task 1 (`monitoring.Lookup`, `MapMatrix`, `Response`, `Selector`), Task 2 (`*monitoring.Client`, `QueryRange`), Task 3 (`CanReadNamespace`, `CanReadClusterWide`); `ocpTokenFrom(r.Context())` (existing) for the caller token.
- Produces: `func (h *Handlers) HandleGetMetrics(w http.ResponseWriter, r *http.Request)` serving `GET /api/v1/monitoring/metrics`.

- [ ] **Step 1: Extend `Handlers`** in `handler.go`: add fields `metrics *monitoring.Client`, `metricsAuth` config (`kubeHost`, `caCert` already present). Add params to `New(...)` for the `*monitoring.Client`. Update the single call site in `main.go`.

- [ ] **Step 2: Add flags + client construction in `main.go`:**
  - `thanosURL := flag.String("thanos-url", "", "Thanos querier base URL for metrics queries")`
  - `thanosCAPath := flag.String("thanos-ca-path", "", "CA bundle for Thanos TLS (empty = skip verify, dev only)")`
  - Build `monitoring.NewClient(*thanosURL, *thanosCAPath, monitoring.TokenSourceFromConfig(cfg))` reusing the `cfg` already obtained from `kube.ComponentConfig()` at `main.go:77`. Pass the client into `handler.New(...)`.

- [ ] **Step 3: Register the route** in `newMux` on the `api` sub-mux (behind `RequireOCPToken`, no SCM credential needed):
`api.HandleFunc("GET /api/v1/monitoring/metrics", h.HandleGetMetrics)` (insert near the other `api.*` routes at `backend/main.go:152`).

- [ ] **Step 4: Implement `HandleGetMetrics`** in `monitoring.go`:
  - Parse `metric` (required), `namespace` (optional - absent means all-namespaces), `function` (required when the descriptor's `Scope==ScopeFunction`), `start`,`end`,`step`.
  - `Lookup(metric)`; 400 if unknown. Validate scope vs params (400 if function metric without `function`). Clamp `start/end/step` to bounded limits (timeout 30s, max range 24h, min step 15s, max ~1500 points, max 100 series).
  - Authorize with the caller token (`ocpTokenFrom`): scoped namespace -> `CanReadNamespace`; all-namespaces -> `CanReadClusterWide`. On `false`, return `Response{State: StateError, Message: "forbidden"}` with HTTP 403.
  - Build `Selector`, call `descriptor.BuildRangeQuery`, `client.QueryRange`, then `MapMatrix(...)`; truncate to the series cap. On upstream error return `Response{State: StateError, ...}` (map to 502 following existing handler error conventions). Write JSON via `writeJSON`.

- [ ] **Step 5: Verify build + vet + run.**
Run: `cd backend && go build ./... && go vet ./...`
Then with the dev env running (Task 10 harness or manual `make dev`), functionally verify each case against your CRC cluster (`q2` namespace):
```bash
B=http://localhost:8080; T=$(oc whoami --show-token)
# data: scaling (expect state=data, 'actual'/'desired' series, zeros allowed)
curl -s -H "Authorization: Bearer $T" "$B/api/v1/monitoring/metrics?metric=pod-scaling&namespace=q2&function=q2&start=$(($(date +%s)-3600))&end=$(date +%s)&step=60" | jq '.state, (.series|map(.name))'
# no-data: idle request rate (expect state=no-data OR data with low values)
curl -s -H "Authorization: Bearer $T" "$B/api/v1/monitoring/metrics?metric=request-rate&namespace=q2&start=$(($(date +%s)-3600))&end=$(date +%s)&step=60" | jq '.state'
# forbidden: unknown/again a namespace the token cannot read (expect 403 + state=error)
```
Expected: scaling returns `data` with `["actual","desired"]`; request-rate returns `data` or `no-data` (never silent zeros); unauthorized returns 403/`error`.

- [ ] **Step 6: Commit.**
```bash
git add backend/handler/monitoring.go backend/handler/handler.go backend/main.go
git commit -m "feat(handler): GET /api/v1/monitoring/metrics endpoint"
```

---

## Task 5: Deployment wiring (chart RBAC, service-ca mount, dev.sh)

**Files:**
- Modify/Create: `charts/` templates - a `ClusterRole`/`ClusterRoleBinding` granting the backend SA `cluster-monitoring-view`; a service-ca configmap (`service.beta.openshift.io/inject-cabundle: "true"`) mounted into the pod; deployment args `--thanos-url` (in-cluster svc DNS) and `--thanos-ca-path` (mounted bundle).
- Modify: `hack/dev.sh` - resolve the Thanos route and pass `--thanos-url`; (optional) add the Observe-tab bridge env vars.

**Interfaces:** none (deployment only).

- [ ] **Step 1: Chart RBAC.** Add a `ClusterRoleBinding` binding the backend's ServiceAccount to the built-in `cluster-monitoring-view` ClusterRole (prefer binding the existing role over redefining it).

- [ ] **Step 2: Service-ca mount.** Add a configmap annotated `service.beta.openshift.io/inject-cabundle: "true"`, mount it (e.g. `/var/run/service-ca/`), and set `--thanos-ca-path` to the mounted `service-ca.crt`. Set `--thanos-url=https://thanos-querier.openshift-monitoring.svc:9091`.

- [ ] **Step 3: dev.sh.** In `start_backend` / `restart_backend` / the watcher, add a `resolve_thanos_url` that reads `oc get route thanos-querier -n openshift-monitoring -o jsonpath='{.spec.host}'` and pass `--thanos-url "https://$THANOS_HOST"` (no `--thanos-ca-path` in dev -> skip-verify on the route). Call it from `main()` and `restart_backend`.

- [ ] **Step 4 (optional, Observe tab): bridge env vars.** In `start_console`, add `--env "BRIDGE_K8S_MODE_OFF_CLUSTER_THANOS=https://${THANOS_HOST}"` and `--env "BRIDGE_K8S_MODE_OFF_CLUSTER_ALERTMANAGER=https://$(oc get route alertmanager-main -n openshift-monitoring -o jsonpath='{.spec.host}')"`. (Include per the user's decision at execution time.)

- [ ] **Step 5: Verify.**
Run: `helm lint charts/<chart>` (or `helm template charts/<chart> | oc apply --dry-run=client -f -`) and `bash -n hack/dev.sh`.
Then `make dev` and confirm the backend starts with the Thanos URL (check `.dev-logs/backend.log`) and Task 4's curls work.
Expected: lint passes, backend reaches Thanos.

- [ ] **Step 6: Commit.**
```bash
git add charts hack/dev.sh
git commit -m "chore(monitoring): chart RBAC + service-ca trust + dev Thanos wiring"
```

---

## Task 6: Frontend - react-charts, DTO types, adapter

**Files:**
- Modify: `package.json` / `yarn.lock` (add `@patternfly/react-charts` v8.x)
- Create: `src/common/monitoring/types.ts` (DTO mirror + chart point types + adapter)

**Interfaces:**
- Produces (mirror of the backend DTO):
  - `export type MetricState = 'data' | 'no-data' | 'stale' | 'error';`
  - `export interface MetricPoint { t: number; v: number; }`
  - `export interface MetricSeries { name: string; points: MetricPoint[]; }`
  - `export interface MetricResponse { state: MetricState; metric: string; unit: string; series?: MetricSeries[]; asOf?: number; message?: string; }`
  - `export interface ChartSeries { name: string; data: { x: Date; y: number }[]; }`
  - `export function toChartSeries(res: MetricResponse): ChartSeries[]` - maps `{t,v}` to `{x:new Date(t*1000), y:v}`; returns `[]` when no series. Pure; no React, no fetch.

- [ ] **Step 1: Install the library.**
Run: `yarn add @patternfly/react-charts@^8` then pin the resolved patch.
Expected: resolves against react-core 6.6.1 / React 18.3.1 with no peer-dep errors.

- [ ] **Step 2: Define types + `toChartSeries`** per the Interfaces block.

- [ ] **Step 3: Verify typecheck.**
Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit.**
```bash
git add package.json yarn.lock src/common/monitoring/types.ts
git commit -m "feat(monitoring): react-charts dep, metric DTO types and chart adapter"
```

---

## Task 7: Frontend - monitoring client

**Files:**
- Create: `src/common/clients/monitoringClient.ts`

**Interfaces:**
- Consumes: `customFetchJSON` from `./httpClient`, `PROXY_BASE` from `../types`, `MetricResponse` from `../monitoring/types`, `isAllNamespacesKey` from the SDK.
- Produces:
  - `export interface MetricQuery { metric: string; namespace: string; function?: string; start: number; end: number; step: number; }`
  - `export async function fetchMetric(q: MetricQuery): Promise<MetricResponse>` - builds `${PROXY_BASE}/api/v1/monitoring/metrics?...`, omitting `namespace` when `isAllNamespacesKey(q.namespace)`, URL-encoding params.

- [ ] **Step 1: Implement `fetchMetric`** per signature.

- [ ] **Step 2: Verify typecheck.**
Run: `yarn tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit.**
```bash
git add src/common/clients/monitoringClient.ts
git commit -m "feat(monitoring): frontend metrics client"
```

---

## Task 8: Frontend - shared polling layer + toolbar

**Files:**
- Create: `src/common/monitoring/useMetricsPolling.ts` (hook/context, sequential polling)
- Create: `src/common/components/MetricsToolbar.tsx`

**Interfaces:**
- Consumes: Task 6 types, Task 7 `fetchMetric`.
- Produces:
  - `export interface TimeRange { label: string; durationMs: number; }` and a `TIME_RANGES` list (e.g. 30m/1h/6h/24h).
  - `export interface RefreshInterval { label: string; ms: number | null; }` with `null` = Off; list Off/15s/30s/1m/5m, default 30s.
  - `export function useMetricsPolling(queries: Omit<MetricQuery,'start'|'end'>[], range: TimeRange, interval: RefreshInterval): { results: Record<string, MetricResponse | undefined>; loading: boolean; refresh: () => void }` - keyed by `metric` (+`function`). **Sequential:** schedule the next run only after the in-flight batch settles (not `setInterval`); dedupe identical queries; stop on unmount; pause when `document.hidden`. `refresh()` fires an immediate fetch and resets the timer.
  - `export const MetricsToolbar: React.FC<{ range; onRangeChange; interval; onIntervalChange; onRefresh; loading }>` - PatternFly `Toolbar` with a time-range `Select`, a refresh-interval `Select`, and a refresh `Button` (`SyncAltIcon`).

- [ ] **Step 1: Implement `useMetricsPolling`** with sequential (completion-chained) scheduling, dedupe, visibility pause, and `refresh()`.

- [ ] **Step 2: Implement `MetricsToolbar`** per signature using PatternFly components.

- [ ] **Step 3: Verify typecheck + lint.**
Run: `yarn tsc --noEmit && yarn lint`
Expected: no errors.

- [ ] **Step 4: Commit.**
```bash
git add src/common/monitoring/useMetricsPolling.ts src/common/components/MetricsToolbar.tsx
git commit -m "feat(monitoring): shared sequential polling layer and metrics toolbar"
```

---

## Task 9: Frontend - `<MetricCard>` with four states

**Files:**
- Create: `src/common/components/MetricCard.tsx`

**Interfaces:**
- Consumes: Task 6 (`MetricResponse`, `toChartSeries`), `@patternfly/react-charts/victory` (`Chart`, `ChartLine`/`ChartArea`, `ChartAxis`, `ChartGroup`, `ChartLegend`), PatternFly `Card`/`CardHeader`/`CardTitle`/`CardBody`, `Spinner`, `EmptyState`.
- Produces: `export const MetricCard: React.FC<{ title: string; response?: MetricResponse; height?: number }>` rendering by state: `undefined`/loading -> `Spinner`; `no-data` -> empty state "No data for this range"; `error` -> empty state with `response.message` + relying on the toolbar refresh; `stale` -> render last-known series via `toChartSeries` under a "Stale" `Label`/badge; `data` -> the chart. Knows nothing about Prometheus; initiates no fetch. A real `0` renders as a plotted zero, never as no-data.

- [ ] **Step 1: Implement `MetricCard`** per signature, one Victory line per series with a legend; unit on the Y axis.

- [ ] **Step 2: Verify typecheck + lint + build.**
Run: `yarn tsc --noEmit && yarn lint && yarn build`
Expected: no errors (confirms the victory import path and bundle).

- [ ] **Step 3: Commit.**
```bash
git add src/common/components/MetricCard.tsx
git commit -m "feat(monitoring): MetricCard with loading/no-data/error/stale states"
```

---

## Task 10: Overview chart on the Functions list view

**Files:**
- Modify: `src/pages/function-list/` (the `FunctionsListPage` component + any co-located section)

**Interfaces:**
- Consumes: Task 7-9; existing `useActiveNamespace()` + `isAllNamespacesKey`.

- [ ] **Step 1: Add a `MetricsToolbar` + overview `MetricCard`** above (or beside) the functions table. Wire local state for `range`/`interval`; call `useMetricsPolling([{metric:'request-rate', namespace: activeNamespace}], range, interval)`; pass the `request-rate` result and toolbar handlers (`refresh`, loading).

- [ ] **Step 2: Verify in app.**
Run: `make dev` (if not running), open the console Functions list for `q2`, generate traffic against the function to light up request rate:
```bash
# in another shell, hit the function's route repeatedly to produce activator traffic
```
Expected: the overview chart shows one line per function (top-N), no-data when idle, updates on the chosen interval, and manual refresh works. Switch to all-namespaces (admin) and confirm it still renders (cluster-wide top-N) or shows the defined state.

- [ ] **Step 3: Commit.**
```bash
git add src/pages/function-list
git commit -m "feat(function-list): namespace request-rate overview chart"
```

---

## Task 11: Function detail page with scaling + memory charts

**Files:**
- Create: `src/pages/function-detail/FunctionDetailPage.tsx` (+ co-located components as needed)
- Modify: `console-extensions.json` (new `console.page/route` `/faas/:name`; optional nav)
- Modify: the webpack/plugin exposed-modules map (wherever `FunctionsListPage`/`FunctionEditPage` are registered as `$codeRef`s) to export `FunctionDetailPage`.
- Modify: `src/pages/function-list/` to link each row to `/faas/:name` (optional but expected).

**Interfaces:**
- Consumes: Task 7-9; the function name from the route param and namespace from `useActiveNamespace()`.

- [ ] **Step 1: Register the route + code-ref.** Add the `console.page/route` for `/faas/:name` in `console-extensions.json` pointing at a new `FunctionDetailPage` code-ref, and add that export where the other page code-refs are declared.

- [ ] **Step 2: Build `FunctionDetailPage`** - read `:name` + active namespace; one shared `MetricsToolbar`; `useMetricsPolling([{metric:'pod-scaling',namespace,function:name},{metric:'memory-usage',namespace,function:name}], range, interval)`; render two `MetricCard`s (scaling = actual vs desired; memory = bytes) driven by the one toolbar.

- [ ] **Step 3: Link rows** from the list to `/faas/:name` (optional).

- [ ] **Step 4: Verify in app.**
Run: with `make dev`, navigate `/faas/<function>`; confirm both charts render from one toolbar, scaling shows actual vs desired (including a real `0` when scaled to zero, distinct from no-data), memory shows bytes when a pod is running and no-data when scaled to zero, and the shared time range/refresh drives both.
Expected: both charts share the toolbar; all four states reachable (idle -> no-data/stale; load -> data; revoke access/unknown -> error).

- [ ] **Step 5: Commit.**
```bash
git add src/pages/function-detail console-extensions.json src/pages/function-list
git commit -m "feat(function-detail): detail page with scaling and memory charts"
```

---

## Self-review notes

- **Spec coverage:** endpoint + catalog (T1,T4), Thanos client + versions (T2,T6), auth model/SSAR (T3,T4), DTO + four states (T1,T9), overview top-N (T1,T4,T10), detail scaling+memory (T1,T11), shared toolbar + sequential polling + refresh (T8), RBAC + service-ca + dev wiring (T5), all-namespaces single-query (T1,T4,T10). Decision-doc deliverable is the design doc's "Validated findings" + "Decision document" section (finalize numbers post-build).
- **Review Focus** items each have a functional check in their owning task (zero-vs-no-data T4/T9, SSAR-denied T4, token rotation T2, topk/cap T4, stale T4).
- **Open numbers to ratify during execution:** exact `client_golang` and `react-charts` patch versions, scrape-interval-based stale threshold, SSAR resource/verb, nav placement.
