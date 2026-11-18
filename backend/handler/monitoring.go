package handler

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/openshift/faas-console-plugin/backend/monitoring"
)

const (
	// metricsMaxRange caps how far back a range query may reach. Matches the
	// longest range the frontend offers (2 weeks); platform Prometheus
	// retention is 15d, so the full window is servable on any cluster with
	// persistent monitoring storage. On clusters younger than the window (or
	// with ephemeral monitoring storage, e.g. CRC), older portions are
	// correctly returned as no-data.
	metricsMaxRange = 14 * 24 * time.Hour
	// metricsMinStep is the minimum step: below the ~30s scrape interval,
	// points only interpolate. Matches the frontend's MIN_STEP_SECONDS.
	metricsMinStep = 5 * time.Second
	// metricsMaxPoints is the maximum number of data points per query.
	metricsMaxPoints = 1500
	// metricsQueryTimeout is the per-query context deadline.
	metricsQueryTimeout = 30 * time.Second
)

// HandleGetMetrics serves GET /api/v1/monitoring/metrics.
//
// Query parameters:
//
//	metric    - required; must match a catalog entry id.
//	namespace - optional; absent means all-namespaces (cluster-wide).
//	function  - required when the metric's scope is ScopeFunction.
//	start     - required; Unix seconds.
//	end       - required; Unix seconds.
//	step      - required; seconds.
func (h *Handlers) HandleGetMetrics(w http.ResponseWriter, r *http.Request) {
	if h.metricsClient == nil {
		writeError(w, http.StatusServiceUnavailable, "monitoring not configured (missing --thanos-url)")
		return
	}

	q := r.URL.Query()

	// Resolve and validate the metric catalog entry.
	metricID := q.Get("metric")
	if metricID == "" {
		writeError(w, http.StatusBadRequest, "metric parameter is required")
		return
	}
	desc, ok := monitoring.Lookup(metricID)
	if !ok {
		writeError(w, http.StatusBadRequest, "unknown metric: "+metricID)
		return
	}

	namespace := q.Get("namespace")
	function := q.Get("function")

	if desc.Scope == monitoring.ScopeFunction && function == "" {
		writeError(w, http.StatusBadRequest, "function parameter is required for metric "+metricID)
		return
	}
	// A function-scoped metric requires a concrete namespace: without one the
	// SSAR and the selector would be meaningless (all-namespaces + per-function
	// is an undefined combination).
	if desc.Scope == monitoring.ScopeFunction && namespace == "" {
		writeError(w, http.StatusBadRequest, "namespace parameter is required for function-scoped metric "+metricID)
		return
	}

	// Parse and clamp time range parameters.
	startSec, err := strconv.ParseFloat(q.Get("start"), 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid start parameter")
		return
	}
	endSec, err := strconv.ParseFloat(q.Get("end"), 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid end parameter")
		return
	}
	stepSec, err := strconv.ParseFloat(q.Get("step"), 64)
	if err != nil || stepSec <= 0 {
		writeError(w, http.StatusBadRequest, "invalid step parameter")
		return
	}

	start := time.Unix(int64(startSec), 0)
	end := time.Unix(int64(endSec), 0)
	step := time.Duration(stepSec) * time.Second

	// Clamp range.
	if end.Sub(start) > metricsMaxRange {
		start = end.Add(-metricsMaxRange)
	}
	// Enforce minimum step.
	if step < metricsMinStep {
		step = metricsMinStep
	}
	// Increase step if the range would produce too many points.
	if points := end.Sub(start) / step; points > metricsMaxPoints {
		step = end.Sub(start) / metricsMaxPoints
	}

	// Authorize the caller and build the selector.
	callerToken := ocpTokenFrom(r.Context())
	sel, authErr := h.buildSelector(r.Context(), callerToken, namespace, function, metricID, desc.Unit, w)
	if authErr {
		return // response already written
	}
	query := desc.BuildRangeQuery(sel)

	ctx, cancel := context.WithTimeout(r.Context(), metricsQueryTimeout)
	defer cancel()

	matrix, err := h.metricsClient.QueryRange(ctx, query, start, end, step)
	if err != nil {
		slog.Error("Thanos query failed", "metric", metricID, "err", err)
		writeJSON(w, http.StatusBadGateway, monitoring.Response{
			State:   monitoring.StateError,
			Metric:  metricID,
			Unit:    desc.Unit,
			Message: "upstream query failed",
		})
		return
	}

	resp := monitoring.MapMatrix(matrix, desc)
	resp.Query = query
	resp.CanViewInMetrics = sel.CanViewInMetrics()

	writeJSON(w, http.StatusOK, resp)
}

// buildSelector authorizes the caller and returns a Selector for the query.
// Returns (sel, false) on success. On authorization failure or error it writes
// the response itself and returns (_, true) so the caller can return immediately.
//
// All-namespaces flow:
//  1. Try a cluster-wide SSAR. If allowed, run an unscoped query.
//  2. If denied, list the caller's readable namespaces and inject them as a
//     namespace_name=~"..." matcher so partial-access users see their slice.
//  3. If the readable set is empty, return 403.
func (h *Handlers) buildSelector(
	ctx context.Context,
	callerToken, namespace, function, metricID, unit string,
	w http.ResponseWriter,
) (monitoring.Selector, bool) {
	if namespace != "" {
		// Scoped namespace: single SSAR check.
		allowed, err := monitoring.CanReadNamespace(ctx, h.kubeHost, h.caCert, callerToken, namespace)
		if err != nil {
			slog.Error("authorization check failed", "err", err)
			writeJSON(w, http.StatusServiceUnavailable, monitoring.Response{
				State: monitoring.StateError, Metric: metricID, Unit: unit,
				Message: "authorization check failed",
			})
			return monitoring.Selector{}, true
		}
		if !allowed {
			writeJSON(w, http.StatusForbidden, monitoring.Response{
				State: monitoring.StateError, Metric: metricID, Unit: unit,
				Message: "forbidden",
			})
			return monitoring.Selector{}, true
		}
		return monitoring.Selector{Namespace: namespace, Function: function}, false
	}

	// All-namespaces: try cluster-wide first.
	clusterWide, err := monitoring.CanReadClusterWide(ctx, h.kubeHost, h.caCert, callerToken)
	if err != nil {
		slog.Error("cluster-wide authorization check failed", "err", err)
		writeJSON(w, http.StatusServiceUnavailable, monitoring.Response{
			State: monitoring.StateError, Metric: metricID, Unit: unit,
			Message: "authorization check failed",
		})
		return monitoring.Selector{}, true
	}
	if clusterWide {
		return monitoring.Selector{}, false // empty Namespace = cluster-wide query
	}

	// Partial-access: list namespaces the caller can read and restrict to those.
	readable, err := monitoring.ReadableNamespaces(ctx, h.kubeHost, h.caCert, callerToken)
	if err != nil {
		slog.Error("namespace listing failed", "err", err)
		writeJSON(w, http.StatusServiceUnavailable, monitoring.Response{
			State: monitoring.StateError, Metric: metricID, Unit: unit,
			Message: "could not determine accessible namespaces",
		})
		return monitoring.Selector{}, true
	}
	if len(readable) == 0 {
		writeJSON(w, http.StatusForbidden, monitoring.Response{
			State: monitoring.StateError, Metric: metricID, Unit: unit,
			Message: "forbidden",
		})
		return monitoring.Selector{}, true
	}
	return monitoring.Selector{ReadableNamespaces: readable}, false
}
