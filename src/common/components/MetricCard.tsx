import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  EmptyStateBody,
  Spinner,
  Tooltip,
} from '@patternfly/react-core';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ExclamationCircleIcon,
  ExpandArrowsAltIcon,
  InfoCircleIcon,
} from '@patternfly/react-icons';
import {
  Chart,
  ChartAxis,
  ChartGroup,
  ChartLabel,
  ChartLegend,
  ChartLine,
  ChartTooltip,
  ChartTooltipProps,
  createContainer,
} from '@patternfly/react-charts/victory';
import { Curve, VictoryClipContainer } from 'victory';

import { MetricResponse, toChartSeries } from '../monitoring/types';

/**
 * Visually distinct color palette for chart lines.
 * Chosen to differ maximally in hue and lightness so series are
 * distinguishable even when they overlap or are close in value.
 */
const COLOR_SCALE = [
  '#0066CC', // blue
  '#3E8635', // green
  '#EC7A08', // orange
  '#C9190B', // red
  '#8481DD', // violet
  '#009596', // teal
  '#F4C145', // gold
  '#6A6E73', // grey
  '#2B9AF3', // light blue
  '#A30000', // dark red
];

const CursorVoronoiContainer = createContainer('voronoi', 'cursor');
const TOOLTIP_LINE_TOLERANCE_PX = 6;

type GroupedMetricTooltipProps = ChartTooltipProps & {
  activePoints?: Array<{ x: Date | number | string; y: number }>;
  scale?: { y?: (value: number) => number };
};

function GroupedMetricTooltip({
  activePoints = [],
  center,
  scale,
  text,
  ...props
}: GroupedMetricTooltipProps) {
  const mouseY = center?.y;
  const scaleY = scale?.y;
  const isNearLine =
    mouseY === undefined ||
    typeof scaleY !== 'function' ||
    activePoints.some((point) => Math.abs(scaleY(point.y) - mouseY) <= TOOLTIP_LINE_TOLERANCE_PX);

  if (!isNearLine) return null;

  const rows = Array.isArray(text)
    ? text.map(String)
    : typeof text === 'string' || typeof text === 'number'
      ? String(text).split('\n')
      : [];
  const hoveredTime = activePoints[0]?.x;
  const timestamp =
    hoveredTime === undefined
      ? undefined
      : new Date(hoveredTime).toLocaleString([], {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
  const tooltipText = timestamp ? [timestamp, ...rows] : rows;
  const tooltipStyles = tooltipText.map((_, index) =>
    index === 0 && timestamp ? { fontSize: 9, fontWeight: 800 } : { fontSize: 8 },
  );

  return (
    <ChartTooltip
      {...props}
      center={center}
      constrainToVisibleArea={false}
      renderInPortal
      text={tooltipText}
      style={tooltipStyles}
    />
  );
}

interface MetricCardProps {
  title: string;
  response?: MetricResponse;
  height?: number;
  /** Colors assigned to chart series, cycling when there are more series than colors. */
  colorScale?: string[];
  /** Start of the requested time window. Sets the x-axis left boundary. */
  startTime?: Date;
  /** End of the requested time window. Sets the x-axis right boundary (defaults to now). */
  endTime?: Date;
  /** Whether to show the series legend. */
  showLegend?: boolean;
  /** Whether tooltip values include their series names. */
  showSeriesNames?: boolean;
  /** Called when the user drags a zoom range on the chart. */
  onZoom?: (start: Date, end: Date) => void;
}

const DEFAULT_HEIGHT = 200;

function buildQueryBrowserHref(query: string): string {
  const params = new URLSearchParams({ query0: query });
  return `/monitoring/query-browser?${params.toString()}`;
}

/**
 * Dumb metric chart card - renders DTO output, initiates no fetches.
 * Rendering by state:
 *   undefined             -> loading spinner
 *   state=no-data         -> empty state
 *   state=error           -> error empty state
 *   state=data            -> chart
 *
 * A real 0 value is a valid data point and renders as a plotted zero.
 */
export function MetricCard({
  title,
  response,
  height = DEFAULT_HEIGHT,
  colorScale = COLOR_SCALE,
  startTime,
  endTime,
  showLegend = false,
  showSeriesNames = true,
  onZoom,
}: MetricCardProps) {
  const displayTitle = response?.unit ? `${title} (${response.unit})` : title;
  const queryBrowserHref =
    response?.query && response.canViewInMetrics
      ? buildQueryBrowserHref(response.query)
      : undefined;

  return (
    <Card>
      <CardHeader
        hasWrap
        actions={
          queryBrowserHref
            ? {
                actions: (
                  <Tooltip content="View in Metrics">
                    <Button
                      aria-label="View in Metrics"
                      component="a"
                      href={queryBrowserHref}
                      icon={<ExpandArrowsAltIcon />}
                      variant="plain"
                    />
                  </Tooltip>
                ),
              }
            : undefined
        }
      >
        <CardTitle>{displayTitle}</CardTitle>
      </CardHeader>
      <CardBody>
        <MetricCardBody
          response={response}
          height={height}
          colorScale={colorScale}
          startTime={startTime}
          endTime={endTime}
          showLegend={showLegend}
          showSeriesNames={showSeriesNames}
          onZoom={onZoom}
        />
      </CardBody>
    </Card>
  );
}

interface MetricCardBodyProps {
  response?: MetricResponse;
  height: number;
  colorScale: string[];
  unit?: string;
  startTime?: Date;
  endTime?: Date;
  showLegend?: boolean;
  showSeriesNames?: boolean;
  onZoom?: (start: Date, end: Date) => void;
}

// Chart padding constants - used both when rendering and when computing
// pixel <-> domain mapping for the drag-to-zoom overlay.
const CHART_PADDING = { bottom: 30, left: 60, right: 0, top: 10 };
const LINE_STROKE_HEADROOM = 2;
const Y_AXIS_LABEL_GAP = 14;

interface ZoomOverlayProps {
  xDomain: [Date, Date];
  padding: typeof CHART_PADDING;
  containerRef?: React.RefObject<HTMLDivElement>;
  onZoom?: (start: Date, end: Date) => void;
  children: React.ReactNode;
}

/**
 * Transparent drag-to-select overlay for zooming.
 * Maps mouse pixel positions within the chart's data area to domain values
 * and calls onZoom when the user releases a drag of at least 10px.
 */
function ZoomOverlay({
  xDomain,
  padding,
  containerRef: providedContainerRef,
  onZoom,
  children,
}: ZoomOverlayProps) {
  const internalContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = providedContainerRef ?? internalContainerRef;
  const dragStart = useRef<number | null>(null);
  const [selection, setSelection] = useState<{ left: number; width: number } | null>(null);

  const pxToDomain = useCallback(
    (px: number, containerWidth: number): Date => {
      const dataWidth = containerWidth - padding.left - padding.right;
      const fraction = Math.max(0, Math.min(1, (px - padding.left) / dataWidth));
      const ms = xDomain[0].getTime() + fraction * (xDomain[1].getTime() - xDomain[0].getTime());
      return new Date(ms);
    },
    [xDomain, padding],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onZoom) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      dragStart.current = x;
      setSelection({ left: x, width: 0 });
    },
    [onZoom],
  );

  useEffect(() => {
    if (selection === null) return;
    const onMouseMove = (e: MouseEvent) => {
      if (dragStart.current === null || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const left = Math.min(dragStart.current, x);
      const right = Math.max(dragStart.current, x);
      setSelection({ left, width: right - left });
    };
    const onMouseUp = (e: MouseEvent) => {
      if (dragStart.current === null || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const left = Math.min(dragStart.current, x);
      const right = Math.max(dragStart.current, x);
      const dataLeft = Math.max(padding.left, left);
      const dataRight = Math.min(rect.width - padding.right, right);
      dragStart.current = null;
      setSelection(null);
      if (dataRight - dataLeft >= 10 && onZoom) {
        onZoom(pxToDomain(dataLeft, rect.width), pxToDomain(dataRight, rect.width));
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [selection, onZoom, padding, pxToDomain, containerRef]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', cursor: onZoom ? 'crosshair' : 'default' }}
      onMouseDown={onMouseDown}
    >
      {children}
      {/* Selection highlight */}
      {selection && selection.width > 0 && (
        <div
          data-testid="zoom-selection"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: selection.left,
            width: selection.width,
            background: 'rgba(0, 102, 204, 0.15)',
            border: '1px solid rgba(0, 102, 204, 0.4)',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}

function MetricCardBody({
  response,
  height,
  colorScale,
  startTime,
  endTime,
  showLegend = false,
  showSeriesNames = true,
  onZoom,
}: MetricCardBodyProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [leftPadding, setLeftPadding] = useState(CHART_PADDING.left);

  useLayoutEffect(() => {
    const tickLabels = chartContainerRef.current?.querySelectorAll<SVGGraphicsElement>(
      '.metric-card-y-axis-tick',
    );
    if (!tickLabels?.length) return;

    try {
      const widths = Array.from(tickLabels, (label) => label.getBBox().width).filter(
        (width) => Number.isFinite(width) && width > 0,
      );
      if (widths.length === 0) return;

      const measuredPadding = Math.ceil(Math.max(...widths) + Y_AXIS_LABEL_GAP);
      setLeftPadding((currentPadding) =>
        currentPadding === measuredPadding ? currentPadding : measuredPadding,
      );
    } catch {
      setLeftPadding(CHART_PADDING.left);
    }
  }, [response]);

  if (response === undefined) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size="lg" aria-label="Loading metrics" />
      </div>
    );
  }

  if (response.state === 'error') {
    return (
      <EmptyState
        headingLevel="h4"
        icon={ExclamationCircleIcon}
        titleText="Failed to load metrics"
        style={{ height }}
      >
        <EmptyStateBody>{response.message ?? 'An error occurred.'}</EmptyStateBody>
      </EmptyState>
    );
  }

  if (response.state === 'no-data') {
    return (
      <EmptyState
        headingLevel="h4"
        icon={InfoCircleIcon}
        titleText="No data for this range"
        style={{ height }}
      />
    );
  }

  // state=data - render the chart.
  const chartSeries = toChartSeries(response);

  if (chartSeries.length === 0) {
    return (
      <EmptyState
        headingLevel="h4"
        icon={InfoCircleIcon}
        titleText="No data for this range"
        style={{ height }}
      />
    );
  }

  // The x-axis always spans the full requested time window (or zoom window).
  const now = new Date();
  const allPoints = chartSeries.flatMap((s) => s.data);
  const xMin = startTime ?? (allPoints.length > 0 ? allPoints[0].x : now);
  const xMax = endTime ?? now;
  const xDomain: [Date, Date] = [xMin, xMax];

  // Pin each series to a distinct color so the legend symbols always match
  // the line colors, even when Victory's internal cycle order differs.
  const legendData = chartSeries.map((s, i) => ({
    name: s.name,
    symbol: { fill: colorScale[i % colorScale.length] },
  }));

  const rangeMs = xMax.getTime() - xMin.getTime();
  const lineTopHeadroom = chartSeries.length - 1 + LINE_STROKE_HEADROOM;
  const chartPadding = {
    ...CHART_PADDING,
    left: leftPadding,
    top: Math.max(CHART_PADDING.top, lineTopHeadroom),
  };
  const formatTick = (d: number) => {
    const date = new Date(d);
    // Show date + time for ranges > 24h, time only for shorter ranges.
    if (rangeMs > 24 * 60 * 60 * 1000) {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <ZoomOverlay
      xDomain={xDomain}
      onZoom={onZoom}
      padding={chartPadding}
      containerRef={chartContainerRef}
    >
      <Chart
        height={height}
        padding={chartPadding}
        domain={{ x: xDomain }}
        containerComponent={
          <CursorVoronoiContainer
            cursorDimension="x"
            labelComponent={
              <GroupedMetricTooltip
                centerOffset={{
                  x: (tooltipProps) =>
                    (tooltipProps as typeof tooltipProps & { flyoutWidth: number }).flyoutWidth /
                      2 +
                    4,
                }}
                cornerRadius={2}
                flyoutPadding={{ bottom: 3, left: 5, right: 5, top: 3 }}
                orientation="right"
                pointerLength={4}
                pointerWidth={5}
              />
            }
            mouseFollowTooltips
            voronoiDimension="x"
            labels={({
              datum,
            }: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              datum: any;
            }) => {
              const functionName = datum.childName ?? datum.name ?? 'Function';
              const value = `${Number(datum.y).toFixed(3)}`;
              return showSeriesNames ? `${functionName} ${value}` : value;
            }}
          />
        }
      >
        <ChartAxis tickFormat={formatTick} />
        <ChartAxis
          dependentAxis
          tickLabelComponent={<ChartLabel className="metric-card-y-axis-tick" />}
        />
        <ChartGroup colorScale={colorScale}>
          {chartSeries.map((s, index) => (
            <ChartLine
              key={s.name}
              data={s.data}
              dataComponent={
                chartSeries.length > 1 ? <Curve transform={`translate(0, ${-index})`} /> : undefined
              }
              groupComponent={<VictoryClipContainer clipPadding={{ top: lineTopHeadroom }} />}
              x="x"
              y="y"
              name={s.name}
            />
          ))}
        </ChartGroup>
        {showLegend && legendData.length > 0 && (
          <ChartLegend data={legendData} orientation="horizontal" x={80} y={height - 55} />
        )}
      </Chart>
    </ZoomOverlay>
  );
}
