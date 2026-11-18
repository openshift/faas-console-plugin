import { Breadcrumb, BreadcrumbItem, Content, PageSection } from '@patternfly/react-core';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';

import { MetricCard } from '../../common/components/MetricCard';
import { MetricsToolbar } from '../../common/components/MetricsToolbar';
import {
  DEFAULT_REFRESH_INTERVAL,
  DEFAULT_TIME_RANGE,
  RefreshInterval,
  TimeRange,
  ZoomDomain,
  useMetricsPolling,
} from '../../common/monitoring/useMetricsPolling';

const MEMORY_COLOR_SCALE = ['#0066CC'];

/**
 * Read-only function detail page showing scaling and memory charts.
 * Both charts share one MetricsToolbar and one zoom state so they always
 * display the same time window.
 * Route: /faas/functions/:namespace/:name
 */
export default function FunctionDetailPage() {
  const { namespace = '', name } = useParams<{ namespace: string; name: string }>();
  const [range, setRange] = useState<TimeRange>(DEFAULT_TIME_RANGE);
  const [interval, setInterval] = useState<RefreshInterval>(DEFAULT_REFRESH_INTERVAL);
  const [zoom, setZoom] = useState<ZoomDomain | undefined>();

  const functionName = name ?? '';

  const queries = [
    { metric: 'pod-scaling', namespace, function: functionName },
    { metric: 'memory-usage', namespace, function: functionName },
  ];

  const { results, loading, refresh, startTime, endTime } = useMetricsPolling(
    queries,
    range,
    interval,
    zoom,
  );

  const scalingKey = `pod-scaling:${namespace}:${functionName}`;
  const memoryKey = `memory-usage:${namespace}:${functionName}`;

  const onZoom = useCallback((start: Date, end: Date) => setZoom({ start, end }), []);
  const onResetZoom = useCallback(() => setZoom(undefined), []);

  return (
    <>
      <div className="co-page-heading" data-test="page-heading">
        <PageSection type="breadcrumb">
          <Breadcrumb aria-label="Breadcrumb" data-test="page-heading-breadcrumbs">
            <BreadcrumbItem
              render={({ className }) => (
                <Link className={className} to="/faas">
                  Functions
                </Link>
              )}
            />
            <BreadcrumbItem isActive>Function details</BreadcrumbItem>
          </Breadcrumb>
        </PageSection>
        <PageSection>
          <Content component="h1">
            <div
              className="co-m-pane__heading co-resource-item"
              style={{
                alignItems: 'center',
                gap: 'var(--pf-t--global--spacer--sm)',
                justifyContent: 'flex-start',
              }}
            >
              <span className="pf-v6-u-screen-reader">Function</span>
              <span
                className="co-m-resource-icon co-m-resource-pod co-m-resource-icon--lg"
                title="Function"
              >
                F
              </span>{' '}
              <span
                className="co-resource-item__resource-name"
                data-test="resource-title"
                data-test-id="resource-title"
              >
                {functionName}
              </span>
            </div>
          </Content>
        </PageSection>
      </div>
      <PageSection>
        <MetricsToolbar
          range={range}
          onRangeChange={(r) => {
            setZoom(undefined);
            setRange(r);
          }}
          interval={interval}
          onIntervalChange={setInterval}
          onRefresh={() => {
            setZoom(undefined);
            refresh();
          }}
          loading={loading}
          isZoomed={!!zoom}
          onResetZoom={onResetZoom}
        />
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '1rem' }}>
          <div style={{ flex: '0 0 calc(33.333% - 0.667rem)', minWidth: '280px' }}>
            <MetricCard
              title="Instances"
              response={results[scalingKey]}
              height={220}
              colorScale={MEMORY_COLOR_SCALE}
              startTime={startTime}
              endTime={endTime}
              showSeriesNames={false}
              onZoom={onZoom}
            />
          </div>
          <div style={{ flex: '0 0 calc(33.333% - 0.667rem)', minWidth: '280px' }}>
            <MetricCard
              title="Container Memory"
              response={results[memoryKey]}
              height={220}
              colorScale={MEMORY_COLOR_SCALE}
              startTime={startTime}
              endTime={endTime}
              showSeriesNames={false}
              onZoom={onZoom}
            />
          </div>
          {/* Future charts slot here */}
        </div>
      </PageSection>
    </>
  );
}
