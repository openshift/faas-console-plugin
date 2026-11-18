package monitoring

// Scope indicates what selection parameters a metric requires.
type Scope string

const (
	// ScopeNamespace metrics are scoped to a namespace (overview charts).
	ScopeNamespace Scope = "namespace"
	// ScopeFunction metrics are scoped to a specific function (detail charts).
	ScopeFunction Scope = "function"
)

// State describes the result of a metric query.
type State string

const (
	// StateData means at least one series with points was returned.
	StateData State = "data"
	// StateNoData means the query succeeded but returned no series.
	StateNoData State = "no-data"
	// StateError means an upstream failure, timeout, or authorization denial.
	StateError State = "error"
)

// Selector carries the caller-supplied scope parameters for a metric query.
// Namespace=="" means all-namespaces (cluster-wide).
// ReadableNamespaces is populated for partial-access users in all-namespaces mode.
type Selector struct {
	Namespace          string
	Function           string
	ReadableNamespaces []string
}

// CanViewInMetrics reports whether the query built from this selector stays
// within permissions the caller has demonstrated themselves: either it is
// scoped to a namespace they can read, or they were authorized cluster-wide.
// False means the query relies on the backend's elevated vantage point (the
// partial-access readable-namespaces regex), so re-running the same query as
// the caller - e.g. via the console's query browser - may be denied or empty.
func (s Selector) CanViewInMetrics() bool {
	return s.Namespace != "" || len(s.ReadableNamespaces) == 0
}

// Point is a single time-value sample.
type Point struct {
	T float64 `json:"t"`
	V float64 `json:"v"`
}

// Series is a named sequence of points.
type Series struct {
	Name   string  `json:"name"`
	Points []Point `json:"points"`
}

// Response is the wire DTO returned by the metrics endpoint.
// State is always present. Series is present only when State==StateData.
// Never return zero as a substitute for missing data: StateNoData is distinct from a
// real zero value.
type Response struct {
	State            State    `json:"state"`
	Metric           string   `json:"metric"`
	Unit             string   `json:"unit"`
	Query            string   `json:"query,omitempty"`
	CanViewInMetrics bool     `json:"canViewInMetrics,omitempty"`
	Series           []Series `json:"series,omitempty"`
	AsOf             *float64 `json:"asOf,omitempty"`
	Message          string   `json:"message,omitempty"`
}

// Descriptor describes a single catalog entry.
type Descriptor struct {
	ID              string
	Scope           Scope
	Unit            string
	BuildRangeQuery func(Selector) string
}
