# SRVOCF-1173: Fullstack monitoring integration (POC)

Status: Designed
Date: 2026-11-12
Jira: SRVOCF-1173 (spike, under epic SRVOCF-1168)

## Intent and why

Prove, end to end, that the FaaS plugin can show real monitoring data for
functions: the backend queries the cluster's Prometheus/Thanos with the
caller's token and returns metric DTOs; the frontend polls that endpoint and
renders PatternFly charts inside function pages. The deliverable is a working
prototype plus a decision document that hands the implementation team a settled
set of choices (endpoint, auth, DTO shape, polling interval, library versions)
and a list of what is still open.

Knative Serving is the metric source because it is already running in the FaaS
environment with metrics flowing into the monitoring stack. It is the fastest
path to prove the integration against real data. The design keeps the
Knative-specific surface to one place (PromQL templates and per-metric label
schemes) so the later switch to KEDA changes only those templates, not the
endpoint, auth model, REST contract, DTOs, polling, or chart components.

## Goals

- A backend REST endpoint that queries Thanos with the caller's token, runs
  approved PromQL templates selected by a metric id, and returns DTOs with
  explicit response states.
- A frontend that polls that endpoint on a shared interval and renders charts
  that are oblivious to Prometheus.
- Three real charts across two surfaces, each driven by a different metric from
  a different scope/source, to prove the catalog design:
  - **Functions list view (overview, namespace-scoped):** request rate per
    function (top-N), for the namespace or cluster-wide in all-namespaces mode.
  - **Function detail view (function-scoped):** two charts - Knative pod
    scaling (actual vs desired) and Kubernetes container memory.
- All four UI states demonstrable: loading, no-data, error, stale.
- A decision document capturing the validated findings and pinned choices.

## Non-goals

- Production-ready monitoring views. This is a prototype.
- SSE/watcher delivery for metrics. Metrics are periodic samples; polling a REST
  endpoint is the standard fit.
- Console SDK integration (`QueryBrowser`, `usePrometheusPoll`). The plugin is
  moving all SDK usage to the backend; this spike follows that direction.
- Dashboard/Observe-tab integration. Charts live in plugin-owned Function pages.
- Metric production, collection configuration, and the storage pipeline
  (SRVOCF-1169). This spike assumes metrics already land in the stack and
  focuses on querying and presenting them.

## Anti-goals (what would make this a failure even if it "works")

- Rendering missing data as zero. No-data, stale, and error are distinct from a
  real zero value (and a real zero is meaningful here - a function scaled to
  zero genuinely has zero pods).
- A design where adding a new chart later means a new endpoint or a new bespoke
  component. New charts must be catalog entries (data), not code.
- Letting the frontend send PromQL or backend URLs. The frontend supplies a
  metric id and selection parameters only.
- An auth model that post-filters cluster-wide results in the backend, or that
  requires a tenant to have read access to the `knative-serving` namespace.

## Validated findings (live CRC cluster, kubeadmin + direct Thanos queries)

These were confirmed against the running CRC environment on 2026-11-12. They are
the reason several Jira assumptions are adjusted below, and they are the core
content of the decision document.

### 1. Which metrics actually exist

Only Knative **control-plane** metrics are scraped on this cluster:
`activator_*` (request count, concurrency, latency histograms) and
`autoscaler_*` (actual/desired/requested pods, stable concurrency, panic mode).

The **data-plane** request metrics the Jira examples assumed
(`revision_app_request_count`, `revision_request_latencies`) are **not present**
- they come from the queue-proxy via user-workload monitoring, which is not
enabled here (no `cluster-monitoring-config`, and UWM would not scrape the
`knative-serving` platform namespace anyway).

Consequence: the overview "request rate" chart is built on
`activator_request_count`. Caveat to document: the activator only observes
traffic on the scale-from-zero / burst path, not steady-state traffic that
bypasses it, so activator request rate understates total traffic. Acceptable
for a POC; the decision doc notes data-plane metrics as the production source.

### 2. Knative metrics carry the wrong `namespace` for tenancy

Every `activator_*` / `autoscaler_*` series carries the function identity in
`namespace_name`, `service_name`, `configuration_name`, `revision_name` - but
its actual `namespace` label is `knative-serving` (where the activator and
autoscaler pods run), for every function of every tenant.

Tested directly against the tenancy-enforcing Thanos port (9092, via
`port-forward svc/thanos-querier`):

| Request | Result |
|---|---|
| `namespace=<function-ns>` | **empty** - proxy injects `namespace="<ns>"`, no series match |
| `namespace=knative-serving` | returns data - series actually live there |
| no `namespace` param | HTTP 400 (tenancy port requires it); GET required, POST 400s |

So the Jira's assumed model - "use the tenant-scoped endpoint with the namespace
parameter to enforce authorization at the query level" - **does not hold for
Knative Serving control-plane metrics as scraped today.** A namespace-restricted
user querying their own namespace gets nothing; getting data would require read
access to `knative-serving`, which would expose every tenant's functions.

### 3. The relabeling shim is not cleanly available

Copying `namespace_name` into `namespace` at scrape time would fix the tenancy
port, but the five Knative ServiceMonitors (`activator-sm`, `autoscaler-sm`,
`autoscaler-hpa-sm`, `controller-sm`, `webhook-sm`) are **owned by the
`KnativeServing` operator CR** (edits revert) and are scraped by **platform
monitoring** (`openshift-monitoring/k8s`), which is not user-configurable.
Relabeling is therefore out of reach without changing the collection pipeline
(SRVOCF-1169 territory, explicitly out of scope here).

### 4. Kubernetes metrics behave differently (and this is useful)

`container_memory_working_set_bytes` for a function pod carries the **standard
`namespace`** label (e.g. `namespace="q2"`, `container="user-container"`). It
works through the tenancy port and is scoped by pod. Function identity for this
metric comes from a join to `kube_pod_labels` on the knative pod label
(`label_function_knative_dev_name`), which this cluster does expose.

So a single Function detail page will show three metrics with **two sources,
three scoping schemes, and two namespace semantics** - the strongest possible
test of the catalog design.

### 5. The two Thanos ports enforce RBAC differently

Both ports do an RBAC check, but at different scopes and with different behavior:

- **Cluster port `:9091`** checks one *cluster-wide* permission
  (`get prometheuses/api`, i.e. `cluster-monitoring-view`). Pass it and you can
  query any namespace with no restriction; the query is not rewritten. It is for
  cluster admins and monitoring tooling.
- **Tenancy port `:9092`** checks a *per-namespace* permission (you must name a
  `namespace=X` and be able to `get` in it) and then rewrites the query to pin
  `namespace="X"`. It is for namespace-scoped users, and only ever lets them see
  the one namespace they named.

Tested with a purpose-built namespace-restricted ServiceAccount (`view` role in
`q2`, **no** `cluster-monitoring-view`):

| Request | Result |
|---|---|
| namespace-scoped token → cluster port `:9091` (`/api/v1/query`) | **403** `verb=get, resource=prometheuses, subresource=api` |
| namespace-scoped token → tenancy port `:9092`, `namespace=q2`, memory metric | **200 with data** (memory carries standard `namespace`) |
| namespace-scoped token → tenancy port `:9092`, `namespace=q2`, Knative metric | empty (series live under `knative-serving`; finding 2) |
| `SelfSubjectAccessReview` with that token (`can-i get pods`) | `yes` in `q2`, `no` in `openshift-monitoring` |

So forwarding the **caller's** token to the cluster port is a non-starter: it
needs `cluster-monitoring-view`, which a namespace-scoped user lacks. The tenancy
port serves
only metrics that already carry the function's real `namespace` (memory), not
the Knative control-plane metrics. And a `SelfSubjectAccessReview` with the
caller's token needs no privilege (it mirrors the `SelfSubjectReview` the
`identity` package already does).

### 6. TLS: the in-cluster Thanos service cert is service-ca signed

The in-cluster `thanos-querier` service serving cert is issued by
`openshift-service-serving-signer` (the service-ca operator), **not** the
kube-apiserver CA the backend reads at startup. The backend therefore needs the
service-ca bundle to verify TLS when querying the in-cluster service. (The
external route cert is ingress-signed, which only matters for the dev harness.)

## Decision: backend-SA query + per-caller SelfSubjectAccessReview gate

Because the cluster port rejects tokens of namespace-scoped users (which lack
`cluster-monitoring-view`; finding 5) and the tenancy port cannot serve Knative
control-plane metrics to such a user (findings 2-3), and
because we want one model identical for Knative now and KEDA later, the backend
queries with its **own** ServiceAccount token and authorizes each caller itself:

On each request the backend
1. resolves the caller's OpenShift identity from the forwarded token (reusing
   the `identity` package pattern already used for SCM credentials), then
2. runs a **`SelfSubjectAccessReview` with the caller's token** - may this user
   read in the target namespace? (e.g. `get pods` in the namespace). This is a
   self-review, needs no backend privilege, and `403`/`no` maps to a forbidden
   DTO state, then
3. injects the namespace label matcher into the approved PromQL template
   **before** querying, so the query only ever returns that namespace's series,
   then
4. executes the template against the cluster Thanos querier port `:9091` using
   the **backend's own identity** - the same `kube.ComponentConfig()` credential
   used for every other "as itself" operation (the pod SA in-cluster, the local
   kubeconfig off-cluster), whose SA is granted `cluster-monitoring-view` - and
   maps the result to a DTO.

This is **not** post-filtering (the Jira's actual concern): authorization is
enforced at query construction via a backend-injected matcher plus an explicit
SSAR. The backend SA can read all namespaces' metrics, so **the SSAR + matcher
is the sole authorization boundary** and must be implemented so it cannot be
bypassed (the matcher is always injected server-side; the frontend never sends
PromQL). It is the true "same as KEDA" path:

- **Knative now:** matcher is `namespace_name="X"` (control-plane) or
  `namespace="X"` (memory). Works with today's metrics.
- **KEDA later:** matcher is `namespace="X"`. Only the label name inside the
  PromQL template changes - exactly the one thing the Jira says changes for
  KEDA. Auth code, endpoint, DTOs, polling, and charts are untouched. (Path B
  also works regardless of where KEDA's metrics are namespaced, since the backend
  SA can read them; the tenancy port could not guarantee that.)

This decision consciously overrides the Jira's "use the platform tenancy
endpoint / forward the caller's token" wording; the decision document records it
as a validated finding, with the tenancy port named as the future default once
all metrics carry the standard `namespace` label.

### Why this is secure (the proxy model)

Prometheus/Thanos has no concept of auth or namespaces - a metric is just labels
and values, and `namespace="q2"` is an ordinary label with no inherent security.
Raw Thanos returns everything. OpenShift restricts access with proxies in front
of Thanos, not in the data:

- The **cluster port `:9091`** proxy checks one thing - does the token hold
  `cluster-monitoring-view` (cluster-wide)? A tenant token does not, hence the
  403.
- The **tenancy port `:9092`** proxy (`kube-rbac-proxy` + `prom-label-proxy`)
  requires a `namespace=X` param, runs a `SubjectAccessReview` ("can this token
  read in X?"), and then **rewrites the PromQL to pin `namespace="X"`**. Its
  security is the RBAC check plus the forced matcher - but it only ever keys on
  the `namespace` label, which is why it cannot isolate Knative control-plane
  metrics (their `namespace` is `knative-serving`; the function's namespace is in
  `namespace_name`).

Our backend **reimplements that proxy logic where we control it**: it queries
`:9091` with its own privileged SA token (so Thanos returns the data), but first
runs a `SelfSubjectAccessReview` on the *caller's* token and injects the matcher
itself - keyed on whichever label actually carries the function's namespace
(`namespace_name` for Knative, `namespace` for memory). The caller never reaches
Thanos directly, and the backend only ever builds a query scoped to a namespace
it has just verified the caller may read. That is why a privileged SA token is
safe here: the SSAR + server-side matcher is the boundary.

### New wiring this model requires

- **Chart RBAC:** a `ClusterRole`/`ClusterRoleBinding` (or aggregation to the
  built-in `cluster-monitoring-view`) granting the backend's ServiceAccount read
  access to the Thanos query API. New manifest(s) under `charts/`.
- **Service-ca trust:** mount the service-ca bundle (a configmap annotated
  `service.beta.openshift.io/inject-cabundle: "true"`, or
  `openshift-service-ca.crt`) and load it into the `monitoring` package's HTTP
  client, separate from the kube-apiserver CA (finding 6).
- **Query credential:** reuse `kube.ComponentConfig()` - the existing
  "backend as itself" credential (pod SA in-cluster, local kubeconfig
  off-cluster). No new token flag and no "dev token" plumbing. In prod the chart
  grants that SA `cluster-monitoring-view`; in dev the logged-in kubeconfig user
  already has it. The in-cluster SA token is a rotating projected file, so the
  Thanos HTTP transport must read it fresh per request (as client-go's own
  transports do), not snapshot it once.
- **Thanos endpoint config:** a `--thanos-url` backend flag (following the
  `--kube-host` precedent), because Thanos is a different host than the API
  server `ComponentConfig()` points at. Prod: in-cluster service DNS
  (`https://thanos-querier.openshift-monitoring.svc:9091`). Dev: the external
  route, since the off-cluster dev backend cannot resolve the service name;
  `hack/dev.sh` resolves and passes it.

## The metric catalog (the extensibility mechanism)

Charts are data, not code. One catalog entry fully describes a metric, and
adding a chart later is: add an entry (backend) + reference its id in a card
(frontend). Nothing else changes.

A catalog entry owns:

- **id** - stable identifier the frontend passes (e.g. `request-rate`,
  `pod-scaling`, `memory-usage`).
- **scope** - `namespace` (overview) or `function` (detail). Determines which
  selection parameters are required.
- **label scheme / selector builder** - how the UI's `(namespace, function)`
  identity becomes this metric's selector. This is the per-metric knowledge
  finding 4 forces into the open:
  - request-rate / pod-scaling → `namespace_name="<ns>"`,
    `service_name="<fn>"` (control-plane, namespace matcher is `namespace_name`)
  - memory-usage → `namespace="<ns>"` plus a join to
    `kube_pod_labels{label_function_knative_dev_name="<fn>"}`
- **PromQL templates** - one for range (`QueryRange`, chart history) and
  optionally one for instant (`Query`, summary values). The only Knative-vs-KEDA
  surface.
- **presentation** - unit, value formatting, series naming (e.g. actual vs
  desired for pod scaling).
- **bounded limits** - see below.

The frontend keeps a thin registry mirroring the ids (for labels, unit hints,
chart type) but never the PromQL.

## Backend shape

New package `monitoring` (consuming package; distinct from the
instrumentation-only `prometheus/client_golang/prometheus`). It depends on
`kube` for connection setup, follows the existing dependency rules, and is
imported by `handler` only.

- Uses `github.com/prometheus/client_golang/api` and `api/prometheus/v1`;
  `QueryRange` for history, `Query` for summary values.
- Pin `client_golang` at a tested version. The backend declares `go 1.26.0`, so
  v1.25.x (which requires Go 1.26 and returns annotations alongside warnings) is
  acceptable; the builder confirms the exact `QueryRange`/`Query` signatures at
  pin time.

Route (mounted under the existing `/api/v1/` sub-mux, behind `RequireOCPToken`):

```
GET /api/v1/monitoring/metrics?metric=<id>&namespace=X[&function=Y]&start=T1&end=T2&step=S
```

The handler validates the metric id against the catalog, validates/clamps the
range and step against bounded limits, runs SAR, builds the selector, executes
the template, and returns a DTO. The frontend supplies the metric id and
selection parameters only - never PromQL or a backend URL.

### Bounded operation limits (concrete numbers, to be ratified)

- per-query timeout: 30s
- max range: 24h
- min step: 15s (and step is clamped so a range yields <= ~1500 points)
- max series per response: 100
- max concurrent upstream queries per backend instance: 8

### Response DTO and explicit states

One envelope for both history and summary payloads, with a required state. Never
zero-for-missing.

```
state: "data" | "no-data" | "stale" | "error"
metric: "<id>"
unit:   "<unit>"
series: [ { name, points: [ { t, v } ] } ]   // present when state == data
asOf:   <timestamp of newest sample>          // drives the stale check
message: "<human-readable>"                    // present when state == error/no-data
```

- **data**: at least one series with points inside the range.
- **no-data**: the query succeeded but returned no series (e.g. idle request
  rate, or a function scaled to zero for a pod-count-free metric). Distinct from
  a real zero value, which is a `data` point with `v: 0`.
- **stale**: the newest sample is older than a freshness threshold (proposed
  2x the scrape interval, builder to confirm against the actual interval).
- **error**: upstream failure, timeout, or authorization denied (SAR false →
  the DTO carries an error/forbidden state; HTTP status mapping follows the
  existing handler error-mapping conventions).

## Frontend shape

Follows the layered architecture (Types <- Clients <- Hooks <- Components <-
Pages; Utils cross-cutting).

- **Library**: add `@patternfly/react-charts` (Victory-based). react-core is
  6.6.1, so the compatible major is react-charts v8 (its major differs from
  react-core's, as the Jira warns). Import charts from
  `@patternfly/react-charts/victory`. Pin the exact patch at install and record
  it; confirm it resolves against react-core 6.6.1 and React 18.3.1.
- **Client**: `common/clients/monitoringClient.ts`, built on the existing
  `httpClient` (`customFetchJSON`), exposing a typed fetch for the metrics
  endpoint. No polling logic here.
- **Types**: the DTO + a pure fetch-to-chart adapter (DTO series → chart points)
  in `common/types.ts` or a `monitoring` types module. No React, no Prometheus
  concepts leak into components.
- **Shared polling layer**: a `common/hooks` hook (or small context) that owns
  the interval and de-duplicates fetches so multiple cards on one view issue a
  single request per (metric, scope). It drives all cards on a view off one
  shared time range and one shared refresh interval, satisfying the Jira's
  "shared time range and selection across cards" requirement.
  - **Sequential (non-overlapping) by default:** the next tick is scheduled only
    after the in-flight fetch settles, so a slow Thanos query cannot cause
    requests to pile up. (A plain `setInterval` is not enough; schedule the next
    run from the previous run's completion.)
  - Lifecycle (start/stop on mount/unmount, pause when the tab is hidden) lives
    here, not in cards.
- **Shared toolbar** (`common/components`, per view): a `MetricsToolbar`
  matching the OCP Observe convention, holding a **time-range** dropdown, a
  **refresh-interval** dropdown (Off / 15s / 30s / 1m / 5m, default 30s), and a
  **manual refresh** button that fires an immediate fetch and resets the interval
  timer. It controls the shared polling layer; cards do not own these controls.
  On the detail page the single toolbar drives both the scaling and memory charts
  in sync.
- **Component**: a reusable `<MetricCard>` in `common/components` using
  `Card`/`CardHeader`/`CardTitle`/`CardBody` and `Chart`/`ChartLine` or
  `ChartArea`/`ChartAxis`. It receives adapter output + a state and renders the
  four UI states (loading spinner, no-data empty state, error with retry, stale
  badge over last-known data). It knows nothing about Prometheus and initiates
  no requests.

## Surfaces

- **Functions list view** (`/faas`, existing `FunctionsListPage`): one overview
  `<MetricCard>` for request rate, plotting **one line per function, top-N
  capped**. Prometheus does the aggregation and the capping in a single query -
  **no fan-out** (not in the frontend, not in the backend):
  - Single namespace selected:
    `topk(10, sum by (service_name)(rate(activator_request_count{namespace_name="X"}[w])))`
    - a line per function in namespace X, gated by an SSAR on X.
  - **All-namespaces mode** (admin, `isAllNamespacesKey`): the same shape without
    the matcher, broken down by namespace+function so lines stay distinct across
    namespaces:
    `topk(10, sum by (namespace_name, service_name)(rate(activator_request_count[w])))`
    - the busiest functions cluster-wide in one round trip. Authorization is a
    single SSAR for a cluster-wide read (which is effectively who the console
    shows all-namespaces mode to). For a partial-access user, the backend
    resolves the caller's readable namespaces with one `namespaces` List on the
    caller's token and injects `namespace_name=~"ns1|ns2|..."` - still one query,
    Prometheus still doing the aggregation and capping, no loop.

  `topk(N, ...)` (default N=10, aligned with the series cap) keeps busy views
  legible instead of rendering an unreadable thicket. Each returned series is one
  function; the DTO names it (`service_name`, plus `namespace_name` in
  all-namespaces mode) and the chart legend identifies it. The endpoint has two
  scope modes: `namespace=X` (scoped, matcher injected) and all-namespaces (no
  `namespace` param; cluster-wide SSAR, optional readable-set regex). The
  authorization boundary stays "one SSAR + a server-built matcher per query."
- **Function detail view**: a **new** read-only page at route `/faas/:name`
  (new `console.page/route` + nav as appropriate), holding two `<MetricCard>`s -
  pod scaling (actual vs desired) and container memory. This is new scaffolding
  (route, page component under `src/pages/function-detail/`, co-located
  components). The app already identifies a function by
  `function.knative.dev/name` (`FUNCTION_NAME_LABEL`) + namespace, which the
  catalog selectors consume.

## Constraints

- Follow the layered architecture and co-location conventions in
  `docs/ARCHITECTURE.md` (frontend) and the backend package/dependency rules.
- PatternFly components and styling over custom HTML/CSS; errors through the
  existing `ErrorProvider`/`addError` pattern; clients consumed through hooks.
- No tests required (POC), per the explicit instruction for this spike. Keep the
  code structured so tests could be added later without rework.
- Stay consistent with OCP console monitoring conventions (token-forwarded
  Thanos queries, explicit data states, PatternFly charts).

## What is left to the builder

- Ratify the bounded-limit numbers and the polling interval (sensible defaults
  proposed above).
- Confirm the exact `client_golang` version/signatures and the exact
  `@patternfly/react-charts` v8 patch against the installed PatternFly 6.
- Confirm the scrape interval to set the stale threshold.
- Confirm the exact resource/verb for the `SelfSubjectAccessReview` (`get pods`
  in the namespace is the working default; the restricted-user path is already
  validated in findings 5 - the builder confirms it in code).
- Confirm the precise RBAC binding for the backend SA (aggregate to
  `cluster-monitoring-view` vs a scoped `ClusterRole`) and the service-ca mount
  wiring.
- Decide nav placement/visibility for the new detail page and whether rows in
  the list link to it.
- **Series count limit (removed for the PoC):** the backend originally capped
  responses at 100 series (`metricsMaxSeries`); it was removed because the
  truncation was silent. Before production, re-introduce a bound - either a
  cap with an explicit truncation signal in the DTO (`truncated`/total count,
  surfaced as "showing 100 of N" in the UI) or server-side top-N aggregation.
  Unbounded, the all-namespaces overview scales payload and chart render work
  with the number of functions (roughly 10 KB per series per query, polled
  every 30s per open tab).
- Generate load against a function during the demo to light up request-rate and
  latency metrics and to show the data/stale/no-data transitions.

## Decision document (spike deliverable)

The spike also produces a short decision document for the implementation
handoff: query endpoint, auth approach (and the finding that overrides the
Jira's tenancy-port assumption), DTO shape, polling interval, library versions
pinned, prototype location, and open questions. Its evidence is the "Validated
findings" section above; the final numbers are confirmed during implementation.
Format and destination (repo markdown vs Confluence) to be chosen with the team.
