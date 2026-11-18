package monitoring

import (
	"fmt"
	"strings"
)

// catalog is the authoritative registry of supported metrics.
// Adding a new chart requires a new entry here and a frontend card reference - no new endpoint.
var catalog = map[string]Descriptor{
	"request-rate": {
		ID:    "request-rate",
		Scope: ScopeNamespace,
		Unit:  "req/s",
		BuildRangeQuery: func(sel Selector) string {
			matcher := knativeNsMatcher(sel)
			if matcher != "" {
				matcher = "{" + matcher + "}"
			}
			// Single-namespace: group by service_name only - the namespace is already
			// implied by the matcher so the legend doesn't need to repeat it.
			// Cluster-wide: group by both so the legend can show namespace/function.
			if sel.Namespace != "" {
				return fmt.Sprintf(
					`sum by (service_name)(rate(activator_request_count%s[5m]))`,
					matcher,
				)
			}
			return fmt.Sprintf(
				`sum by (namespace_name, service_name)(rate(activator_request_count%s[5m]))`,
				matcher,
			)
		},
	},
	"pod-scaling": {
		ID:    "pod-scaling",
		Scope: ScopeFunction,
		Unit:  "",
		BuildRangeQuery: func(sel Selector) string {
			return fmt.Sprintf(
				`autoscaler_actual_pods{namespace_name=%q,service_name=%q}`,
				sel.Namespace, sel.Function,
			)
		},
	},
	"memory-usage": {
		ID:    "memory-usage",
		Scope: ScopeFunction,
		Unit:  "bytes",
		BuildRangeQuery: func(sel Selector) string {
			// Memory uses the standard namespace label, not namespace_name.
			// Identity is established via kube_pod_labels join on the knative function label.
			return fmt.Sprintf(
				`sum by (pod)(container_memory_working_set_bytes{namespace=%q,container="user-container"}`+
					` * on(namespace,pod) group_left()`+
					` kube_pod_labels{namespace=%q,label_function_knative_dev_name=%q})`,
				sel.Namespace, sel.Namespace, sel.Function,
			)
		},
	},
}

// Lookup returns the Descriptor for a metric id. Returns false when unknown.
func Lookup(id string) (Descriptor, bool) {
	d, ok := catalog[id]
	return d, ok
}

// knativeNsMatcher builds the namespace label matcher for Knative control-plane metrics.
// Knative metrics use namespace_name (not the standard namespace label).
// Returns an empty string for cluster-wide queries (no matcher injected).
func knativeNsMatcher(sel Selector) string {
	if sel.Namespace != "" {
		return fmt.Sprintf(`namespace_name=%q`, sel.Namespace)
	}
	if len(sel.ReadableNamespaces) > 0 {
		return fmt.Sprintf(`namespace_name=~%q`, strings.Join(sel.ReadableNamespaces, "|"))
	}
	// Cluster-wide: no matcher; query returns all namespaces.
	return ""
}
