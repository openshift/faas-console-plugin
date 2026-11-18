import { Card, CardBody, DrawerPanelContent } from '@patternfly/react-core';
import { GripVerticalIcon, TimesIcon } from '@patternfly/react-icons';
import { useCallback, useEffect, useRef, useState } from 'react';

import { MetricCard } from '../../../common/components/MetricCard';
import { MetricsToolbar } from '../../../common/components/MetricsToolbar';
import {
  DEFAULT_REFRESH_INTERVAL,
  DEFAULT_TIME_RANGE,
  RefreshInterval,
  TimeRange,
  ZoomDomain,
  useMetricsPolling,
} from '../../../common/monitoring/useMetricsPolling';

interface MetricsDrawerProps {
  namespace: string;
}

const HEADER_HEIGHT = 36; // px - combined grip + title bar (also the drag handle)
const MIN_CONTENT_HEIGHT = 160; // px - smallest usable chart area below the header
const MAX_HEIGHT_RATIO = 2 / 3;
const MAX_HEIGHT_PERCENT = '66.6667%';
const DRAG_THRESHOLD = 6; // px - less than this on release is treated as a click

/** Default expanded panel height: 1/3 of the viewport. */
function defaultHeight(): number {
  return typeof window !== 'undefined'
    ? Math.max(MIN_CONTENT_HEIGHT + HEADER_HEIGHT, Math.floor(window.innerHeight / 3))
    : 300;
}

function maxHeight(): number {
  return typeof window !== 'undefined' ? Math.floor(window.innerHeight * MAX_HEIGHT_RATIO) : 600;
}

/**
 * Bottom-sheet monitoring drawer panel.
 *
 * Layout (top to bottom inside the PatternFly bottom drawer):
 *
 *   ┌──────────────────────────────────────┐  <- this edge moves with the cursor
 *   │  ═══  Monitoring             [×]     │  HEADER_HEIGHT - grip + title + close
 *   ├──────────────────────────────────────┤
 *   │  toolbar + charts (scrollable)       │  flex: 1
 *   └──────────────────────────────────────┘  <- constrained by the route's drawer content
 *
 * The header serves as the drag handle, title bar, and collapse toggle.
 *
 * PatternFly owns panel positioning and resizing. Keeping the panel inside the
 * route drawer makes it follow the OpenShift main-content width when the platform
 * sidebar opens or closes.
 */
export function MetricsDrawer({ namespace }: MetricsDrawerProps) {
  const [panelHeight, setPanelHeight] = useState(HEADER_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const movedRef = useRef(0);

  const [range, setRange] = useState<TimeRange>(DEFAULT_TIME_RANGE);
  const [refreshInterval, setRefreshInterval] = useState<RefreshInterval>(DEFAULT_REFRESH_INTERVAL);
  const [zoom, setZoom] = useState<ZoomDomain | undefined>();

  const queries = [{ metric: 'request-rate', namespace }];
  const { results, loading, refresh, startTime, endTime } = useMetricsPolling(
    queries,
    range,
    refreshInterval,
    zoom,
  );

  const requestRateKey = `request-rate:${namespace}:`;
  const response = results[requestRateKey];

  const onZoom = useCallback((start: Date, end: Date) => setZoom({ start, end }), []);
  const onResetZoom = useCallback(() => setZoom(undefined), []);
  const isOpen = panelHeight > HEADER_HEIGHT;

  const startDrag = useCallback(
    (clientY: number) => {
      dragStartY.current = clientY;
      dragStartHeight.current = panelHeight;
      movedRef.current = 0;
      setIsDragging(true);
    },
    [panelHeight],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startDrag(e.clientY);
    },
    [startDrag],
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      startDrag(e.touches[0].clientY);
    },
    [startDrag],
  );

  useEffect(() => {
    if (!isDragging) return;

    const move = (clientY: number) => {
      const delta = dragStartY.current - clientY;
      movedRef.current = Math.abs(delta);
      const rawHeight = dragStartHeight.current + delta;
      setPanelHeight(Math.min(Math.max(HEADER_HEIGHT, rawHeight), maxHeight()));
    };

    const finishDrag = () => {
      setIsDragging(false);
      if (movedRef.current < DRAG_THRESHOLD) {
        setPanelHeight((height) => (height > HEADER_HEIGHT ? HEADER_HEIGHT : defaultHeight()));
        return;
      }

      setPanelHeight((height) => {
        if (height <= HEADER_HEIGHT + MIN_CONTENT_HEIGHT / 2) return HEADER_HEIGHT;
        if (height < HEADER_HEIGHT + MIN_CONTENT_HEIGHT) {
          return HEADER_HEIGHT + MIN_CONTENT_HEIGHT;
        }
        return Math.min(height, maxHeight());
      });
    };

    const onMouseMove = (e: MouseEvent) => move(e.clientY);
    const onTouchMove = (e: TouchEvent) => move(e.touches[0].clientY);

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', finishDrag);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', finishDrag);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', finishDrag);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', finishDrag);
    };
  }, [isDragging]);

  const close = useCallback(() => setPanelHeight(HEADER_HEIGHT), []);

  const onHeaderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setPanelHeight((height) => (height > HEADER_HEIGHT ? HEADER_HEIGHT : defaultHeight()));
    }
  }, []);

  return (
    <DrawerPanelContent
      minSize={`${HEADER_HEIGHT}px`}
      maxSize={MAX_HEIGHT_PERCENT}
      defaultSize={`${panelHeight}px`}
      style={{ overflow: 'hidden', background: 'Canvas', padding: 0, rowGap: 0 }}
    >
      {/*
       * HEADER - this is the top edge of the drawer, so it physically moves
       * upward while resizing. It doubles as the drag handle, title bar, and collapse toggle.
       */}
      <div
        role="button"
        tabIndex={0}
        aria-label={isOpen ? 'Collapse monitoring panel' : 'Expand monitoring panel'}
        aria-expanded={isOpen}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        onKeyDown={onHeaderKeyDown}
        style={{
          height: `${HEADER_HEIGHT}px`,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0 1rem',
          cursor: isDragging ? 'grabbing' : 'ns-resize',
          borderTop: '2px solid var(--pf-v6-global--BorderColor--100)',
          borderBottom: isOpen ? '1px solid var(--pf-v6-global--BorderColor--100)' : undefined,
        }}
      >
        <GripVerticalIcon
          style={{ transform: 'rotate(90deg)', flexShrink: 0 }}
          aria-hidden="true"
        />
        <span style={{ fontWeight: 600, fontSize: '0.875rem', flex: 1 }}>Monitoring Overview</span>
        {isOpen && (
          <button
            aria-label="Close monitoring panel"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: '4px',
              flexShrink: 0,
            }}
          >
            <TimesIcon />
          </button>
        )}
      </div>

      {/* Scrollable chart content - only present when open */}
      {isOpen && (
        <Card
          style={{
            flex: 1,
            overflowY: 'auto',
            borderRadius: 0,
            border: 'none',
          }}
        >
          <CardBody>
            <MetricsToolbar
              range={range}
              onRangeChange={(r) => {
                setZoom(undefined);
                setRange(r);
              }}
              interval={refreshInterval}
              onIntervalChange={setRefreshInterval}
              onRefresh={() => {
                setZoom(undefined);
                refresh();
              }}
              loading={loading}
              isZoomed={!!zoom}
              onResetZoom={onResetZoom}
            />
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 calc(33.333% - 0.667rem)', minWidth: '280px' }}>
                <MetricCard
                  title="Request Rate"
                  response={response}
                  height={180}
                  startTime={startTime}
                  endTime={endTime}
                  onZoom={onZoom}
                />
              </div>
            </div>
          </CardBody>
        </Card>
      )}
    </DrawerPanelContent>
  );
}
