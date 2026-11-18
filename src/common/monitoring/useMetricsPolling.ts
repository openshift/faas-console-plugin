import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchMetric, MetricQuery } from '../clients/monitoringClient';
import { MetricResponse } from './types';

export interface TimeRange {
  label: string;
  durationMs: number;
}

export const TIME_RANGES: TimeRange[] = [
  { label: '5 minutes', durationMs: 5 * 60 * 1000 },
  { label: '15 minutes', durationMs: 15 * 60 * 1000 },
  { label: '30 minutes', durationMs: 30 * 60 * 1000 },
  { label: '1 hour', durationMs: 60 * 60 * 1000 },
  { label: '2 hours', durationMs: 2 * 60 * 60 * 1000 },
  { label: '6 hours', durationMs: 6 * 60 * 60 * 1000 },
  { label: '12 hours', durationMs: 12 * 60 * 60 * 1000 },
  { label: '1 day', durationMs: 24 * 60 * 60 * 1000 },
  { label: '2 days', durationMs: 2 * 24 * 60 * 60 * 1000 },
  { label: '1 week', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { label: '2 weeks', durationMs: 14 * 24 * 60 * 60 * 1000 },
];

const POINT_LIMIT = 500; // max points per chart. Design limit, aligned with Perses dashboards (maxDataPoints).
const MIN_STEP_SECONDS = 5; // floor: Matches the console's shortest-view density.

export const DEFAULT_TIME_RANGE = TIME_RANGES[3]; // 1 hour

export interface RefreshInterval {
  label: string;
  ms: number | null;
}

export const REFRESH_INTERVALS: RefreshInterval[] = [
  { label: 'Off', ms: null },
  { label: '15 seconds', ms: 15_000 },
  { label: '30 seconds', ms: 30_000 },
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
];

export const DEFAULT_REFRESH_INTERVAL = REFRESH_INTERVALS[2]; // 30s

type QueryKey = string;
type QueryBase = Omit<MetricQuery, 'start' | 'end' | 'step'>;

function queryKey(q: QueryBase): QueryKey {
  return `${q.metric}:${q.namespace}:${q.function ?? ''}`;
}

/**
 * Shared sequential polling hook.
 *
 * Fetches all queries in a batch, then schedules the next batch only after the
 * current one completes (sequential, non-overlapping). Multiple cards on the
 * same view share one poll cycle per unique (metric, namespace, function).
 *
 * Pauses when the browser tab is hidden.
 * Stopped cleanly on unmount.
 */
export interface ZoomDomain {
  start: Date;
  end: Date;
}

export function useMetricsPolling(
  queries: QueryBase[],
  range: TimeRange,
  interval: RefreshInterval,
  /** When set, overrides the query window with this exact range (zoom re-fetch). */
  zoomOverride?: ZoomDomain,
): {
  results: Record<QueryKey, MetricResponse | undefined>;
  loading: boolean;
  refresh: () => void;
  /** Start of the most recent query window as a Date, for use as the chart x-axis left boundary. */
  startTime: Date;
  /** End of the most recent query window. */
  endTime: Date;
} {
  const [results, setResults] = useState<Record<QueryKey, MetricResponse | undefined>>({});
  const [loading, setLoading] = useState(false);
  const [startTime, setStartTime] = useState<Date>(() => new Date(Date.now() - range.durationMs));
  const [endTime, setEndTime] = useState<Date>(() => new Date());
  // triggerCount increments to force a re-fetch on manual refresh.
  const [triggerCount, setTriggerCount] = useState(0);

  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTriggerCount((c) => c + 1);
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // Deduplicate queries by key.
    const seen = new Set<QueryKey>();
    const deduped = queries.filter((q) => {
      const k = queryKey(q);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (deduped.length === 0) return;

    let cancelled = false;

    const execute = async () => {
      if (cancelled || document.hidden) return;

      setLoading(true);

      // Use zoom override when set, otherwise derive from the range selector.
      let start: number;
      let end: number;
      if (zoomOverride) {
        start = Math.floor(zoomOverride.start.getTime() / 1000);
        end = Math.floor(zoomOverride.end.getTime() / 1000);
      } else {
        const now = Date.now();
        end = Math.floor(now / 1000);
        start = Math.floor((now - range.durationMs) / 1000);
      }
      setStartTime(new Date(start * 1000));
      setEndTime(new Date(end * 1000));
      // step: at most 300 points per query across the range.
      const step = Math.max(MIN_STEP_SECONDS, Math.ceil((end - start) / POINT_LIMIT));

      const fetches = deduped.map(async (q) => {
        const k = queryKey(q);
        try {
          const res = await fetchMetric({ ...q, start, end, step });
          return { k, res };
        } catch {
          const errRes: MetricResponse = {
            state: 'error',
            metric: q.metric,
            unit: '',
            message: 'fetch failed',
          };
          return { k, res: errRes };
        }
      });

      const settled = await Promise.all(fetches);

      if (cancelled) return;

      setResults((prev) => {
        const next = { ...prev };
        for (const { k, res } of settled) {
          next[k] = res;
        }
        return next;
      });
      setLoading(false);

      // Schedule the next run only after this one completes (sequential, non-overlapping).
      if (!cancelled && interval.ms !== null) {
        timerRef.current = setTimeout(() => {
          void execute();
        }, interval.ms);
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden && interval.ms !== null) {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        void execute();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void execute();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // triggerCount forces re-run on manual refresh; queries/range/interval changes restart naturally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    interval.ms,
    range.durationMs,
    triggerCount,
    JSON.stringify(queries.map(queryKey)),
    zoomOverride?.start?.getTime(),
    zoomOverride?.end?.getTime(),
  ]);

  return { results, loading, refresh, startTime, endTime };
}
