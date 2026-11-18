package monitoring

import (
	"github.com/prometheus/common/model"
)

// MapMatrix converts a Prometheus range-query result matrix into a Response.
// It derives the response state:
//   - StateNoData when the matrix is empty (query succeeded, no series returned).
//   - StateData otherwise.
//
// A real 0 value is a valid data point and is never collapsed to StateNoData.
// Series are named from "service_name" (falling back to "pod"), prefixed with
// "namespace_name/" when present (for multi-namespace charts). AsOf carries the
// newest sample timestamp so the UI can reason about freshness if it needs to.
func MapMatrix(m model.Matrix, d Descriptor) Response {
	if len(m) == 0 {
		return Response{
			State:   StateNoData,
			Metric:  d.ID,
			Unit:    d.Unit,
			Message: "no data returned for this range",
		}
	}

	var newestTS float64
	series := make([]Series, 0, len(m))

	for _, ss := range m {
		if len(ss.Values) == 0 {
			// Skip series with no samples rather than adding an empty series that
			// would cause the chart to render state=data with nothing to plot.
			continue
		}
		name := seriesName(ss.Metric)
		points := make([]Point, 0, len(ss.Values))
		for _, sp := range ss.Values {
			ts := float64(sp.Timestamp) / 1000.0 // ms -> s
			points = append(points, Point{T: ts, V: float64(sp.Value)})
			if ts > newestTS {
				newestTS = ts
			}
		}
		series = append(series, Series{Name: name, Points: points})
	}

	// If every series was empty after filtering, treat as no-data.
	if len(series) == 0 {
		return Response{
			State:   StateNoData,
			Metric:  d.ID,
			Unit:    d.Unit,
			Message: "no data returned for this range",
		}
	}

	return Response{
		State:  StateData,
		Metric: d.ID,
		Unit:   d.Unit,
		Series: series,
		AsOf:   &newestTS,
	}
}

// seriesName derives a human-readable name for a Prometheus sample stream.
func seriesName(labels model.Metric) string {
	name := string(labels["service_name"])
	if name == "" {
		name = string(labels["pod"])
	}
	if name == "" {
		name = "unknown"
	}

	// Prefix with namespace when present (multi-namespace overview charts).
	if ns, ok := labels["namespace_name"]; ok && ns != "" {
		name = string(ns) + "/" + name
	}

	return name
}
