import { isAllNamespacesKey } from '@openshift-console/dynamic-plugin-sdk';

import { customFetchJSON } from './httpClient';
import { MetricResponse } from '../monitoring/types';
import { PROXY_BASE } from '../types';

export interface MetricQuery {
  metric: string;
  namespace: string;
  function?: string;
  start: number;
  end: number;
  step: number;
}

/**
 * Fetches a single metric range from the backend metrics endpoint.
 * The namespace parameter is omitted when in all-namespaces mode,
 * signaling a cluster-wide query to the backend.
 * Never sends PromQL or backend URLs - only a metric id and selection params.
 */
export async function fetchMetric(q: MetricQuery): Promise<MetricResponse> {
  const params = new URLSearchParams();
  params.set('metric', q.metric);

  // All-namespaces mode: omit namespace so the backend runs a cluster-wide query.
  if (!isAllNamespacesKey(q.namespace)) {
    params.set('namespace', q.namespace);
  }

  if (q.function !== undefined) {
    params.set('function', q.function);
  }

  params.set('start', String(q.start));
  params.set('end', String(q.end));
  params.set('step', String(q.step));

  return customFetchJSON<MetricResponse>(
    `${PROXY_BASE}/api/v1/monitoring/metrics?${params.toString()}`,
  );
}
