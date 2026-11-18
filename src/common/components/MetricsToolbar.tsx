import {
  Button,
  MenuToggle,
  Select,
  SelectList,
  SelectOption,
  Spinner,
} from '@patternfly/react-core';
import { SyncAltIcon } from '@patternfly/react-icons';
import { useState } from 'react';

import {
  REFRESH_INTERVALS,
  RefreshInterval,
  TIME_RANGES,
  TimeRange,
} from '../monitoring/useMetricsPolling';

interface MetricsToolbarProps {
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  interval: RefreshInterval;
  onIntervalChange: (interval: RefreshInterval) => void;
  onRefresh: () => void;
  loading: boolean;
  /** When true, shows a "Reset zoom" button to restore the full time range. */
  isZoomed?: boolean;
  onResetZoom?: () => void;
}

/**
 * Metrics toolbar matching the OCP monitoring-dashboards dropdown pattern:
 * a small title text stacked above each dropdown, all in a horizontal flex row.
 * Mirrors the .monitoring-dashboards__dropdown-wrap convention from the console.
 */
export function MetricsToolbar({
  range,
  onRangeChange,
  interval,
  onIntervalChange,
  onRefresh,
  loading,
  isZoomed = false,
  onResetZoom,
}: MetricsToolbarProps) {
  const [rangeOpen, setRangeOpen] = useState(false);
  const [intervalOpen, setIntervalOpen] = useState(false);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'flex-end',
        gap: '1px',
        marginBottom: '0.75rem',
      }}
    >
      {/* Reset zoom — always present on the left, same label+control height as the dropdowns */}
      <div style={{ display: 'flex', flexDirection: 'column', marginRight: '20px' }}>
        <span
          style={{
            fontSize: 'var(--pf-t--global--font--size--sm, 0.75rem)',
            color: 'var(--pf-t--global--text--color--subtle, #6a6e73)',
            marginBottom: '4px',
            textTransform: 'capitalize',
          }}
        ></span>
        <Button
          variant="secondary"
          size="sm"
          onClick={onResetZoom}
          isDisabled={!isZoomed}
          style={{ height: '36px', alignSelf: 'flex', alignItems: 'center' }}
        >
          Reset zoom
        </Button>
      </div>

      {/* Time range dropdown — label above, matching monitoring-dashboards__dropdown-wrap */}
      <div style={{ display: 'flex', flexDirection: 'column', marginRight: '20px' }}>
        <span
          style={{
            fontSize: 'var(--pf-t--global--font--size--sm, 0.75rem)',
            color: 'var(--pf-t--global--text--color--subtle, #6a6e73)',
            marginBottom: '4px',
            textTransform: 'capitalize',
          }}
        >
          Time range
        </span>
        <Select
          isOpen={rangeOpen}
          onOpenChange={setRangeOpen}
          onSelect={(_e, value) => {
            const selected = TIME_RANGES.find((r) => r.label === value);
            if (selected) {
              onRangeChange(selected);
            }
            setRangeOpen(false);
          }}
          selected={range.label}
          toggle={(ref) => (
            <MenuToggle ref={ref} onClick={() => setRangeOpen((o) => !o)} isExpanded={rangeOpen}>
              {range.label}
            </MenuToggle>
          )}
        >
          <SelectList>
            {TIME_RANGES.map((r) => (
              <SelectOption key={r.label} value={r.label} isSelected={r.label === range.label}>
                {r.label}
              </SelectOption>
            ))}
          </SelectList>
        </Select>
      </div>

      {/* Refresh interval dropdown */}
      <div style={{ display: 'flex', flexDirection: 'column', marginRight: '20px' }}>
        <span
          style={{
            fontSize: 'var(--pf-t--global--font--size--sm, 0.75rem)',
            color: 'var(--pf-t--global--text--color--subtle, #6a6e73)',
            marginBottom: '4px',
            textTransform: 'capitalize',
          }}
        >
          Refresh interval
        </span>
        <Select
          isOpen={intervalOpen}
          onOpenChange={setIntervalOpen}
          onSelect={(_e, value) => {
            const selected = REFRESH_INTERVALS.find((i) => i.label === value);
            if (selected) {
              onIntervalChange(selected);
            }
            setIntervalOpen(false);
          }}
          selected={interval.label}
          toggle={(ref) => (
            <MenuToggle
              ref={ref}
              onClick={() => setIntervalOpen((o) => !o)}
              isExpanded={intervalOpen}
            >
              {interval.label}
            </MenuToggle>
          )}
        >
          <SelectList>
            {REFRESH_INTERVALS.map((i) => (
              <SelectOption key={i.label} value={i.label} isSelected={i.label === interval.label}>
                {i.label}
              </SelectOption>
            ))}
          </SelectList>
        </Select>
      </div>

      {/* Manual refresh button — aligned to the bottom of the dropdowns */}
      <div style={{ paddingBottom: '2px' }}>
        <Button
          variant="plain"
          aria-label="Refresh metrics now"
          onClick={onRefresh}
          isDisabled={loading}
          icon={loading ? <Spinner size="sm" /> : <SyncAltIcon />}
        />
      </div>
    </div>
  );
}
