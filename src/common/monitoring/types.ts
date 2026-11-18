/**
 * Frontend mirror of the backend monitoring DTO types.
 * No React, no fetch, no Prometheus concepts - pure data types and a pure adapter.
 */

/** Wire state from the backend metrics endpoint. */
export type MetricState = 'data' | 'no-data' | 'error';

/** A single time-value sample. t is Unix seconds. */
export interface MetricPoint {
  t: number;
  v: number;
}

/** A named sequence of time-value samples. */
export interface MetricSeries {
  name: string;
  points: MetricPoint[];
}

/** Wire DTO returned by GET /api/v1/monitoring/metrics. */
export interface MetricResponse {
  state: MetricState;
  metric: string;
  unit: string;
  query?: string;
  /**
   * Whether the caller could re-run this query as themselves (e.g. in the
   * console's query browser): the query is scoped to a namespace they can
   * read, or they were authorized cluster-wide. False means the query relied
   * on the backend's elevated vantage point (partial multi-namespace access).
   */
  canViewInMetrics?: boolean;
  series?: MetricSeries[];
  asOf?: number;
  message?: string;
}

/** A chart-ready series: data points use Date objects on the x axis. */
export interface ChartSeries {
  name: string;
  data: { x: Date; y: number }[];
}

/**
 * Converts a MetricResponse into chart-ready series.
 * Returns an empty array when there are no series to plot.
 * This is a pure function: no React, no side effects.
 */
export function toChartSeries(res: MetricResponse): ChartSeries[] {
  if (!res.series || res.series.length === 0) {
    return [];
  }
  return res.series.map((s) => ({
    name: s.name,
    data: s.points.map((p) => ({
      x: new Date(p.t * 1000),
      y: p.v,
    })),
  }));
}
