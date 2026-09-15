import { describe, it, expect, vi } from 'vitest';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: vi.fn(),
}));

import { renderHook, waitFor } from '@testing-library/react';
import { useBuildStatus } from './useBuildStatus';

interface BuildSnapshotEvent {
  readonly data: string;
}

interface BuildStatusEventSource {
  addEventListener(
    event: 'build-status' | 'error',
    cbk: ((e: BuildSnapshotEvent) => void) | ((e: unknown) => void),
  ): void;
  close(): void;
}

describe('useBuildStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createEventSourceMethods(listeners: Array<(e: BuildSnapshotEvent) => void>) {
    return {
      addEventListener(
        event: 'build-status' | 'error',
        cbk: ((e: BuildSnapshotEvent) => void) | ((e: unknown) => void),
      ) {
        if (event === 'build-status') {
          listeners.push(cbk as (e: BuildSnapshotEvent) => void);
        }
      },
      close() {
        listeners.length = 0;
      },
    };
  }

  function createStubEventSource(
    snapshots: Array<{ functions: Record<string, unknown> }> = [],
  ): BuildStatusEventSource {
    const listeners: Array<(e: BuildSnapshotEvent) => void> = [];

    // Emit all snapshots immediately
    setTimeout(() => {
      snapshots.forEach((snap) => {
        listeners.forEach((cbk) => cbk({ data: JSON.stringify(snap) }));
      });
    }, 0);

    return createEventSourceMethods(listeners);
  }

  function createSequentialStubEventSource(
    snapshots: Array<{ functions: Record<string, unknown> }> = [],
  ): BuildStatusEventSource {
    const listeners: Array<(e: BuildSnapshotEvent) => void> = [];

    // Emit snapshots sequentially over time
    snapshots.forEach((snap, idx) => {
      setTimeout(
        () => {
          listeners.forEach((cbk) => cbk({ data: JSON.stringify(snap) }));
        },
        (idx + 1) * 10,
      );
    });

    return createEventSourceMethods(listeners);
  }

  function createContinuousStubEventSource(): {
    eventSource: BuildStatusEventSource;
    emitSnapshot: (snap: { functions: Record<string, unknown> }) => void;
  } {
    const listeners: Array<(e: BuildSnapshotEvent) => void> = [];
    let closed = false;

    return {
      eventSource: {
        ...createEventSourceMethods(listeners),
        close() {
          closed = true;
          listeners.length = 0;
        },
      },
      emitSnapshot(snap: { functions: Record<string, unknown> }) {
        if (!closed) {
          listeners.forEach((cbk) => cbk({ data: JSON.stringify(snap) }));
        }
      },
    };
  }

  it('parses a build-status frame into a keyed map', async () => {
    const eventSource = createStubEventSource([
      {
        functions: {
          'alice/fn': { buildStatus: 'Building' },
          'alice/gn': { buildStatus: 'Failed', runURL: 'u' },
        },
      },
    ]);

    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    await waitFor(() => expect(Object.keys(result.current).length).toBe(2));
    expect(result.current['alice/fn']?.buildStatus).toBe('Building');
    expect(result.current['alice/gn']?.buildStatus).toBe('Failed');
    expect(result.current['alice/gn']?.runURL).toBe('u');
  });

  it('closes the stream on unmount, stopping updates', async () => {
    const { eventSource, emitSnapshot } = createContinuousStubEventSource();

    const { result, unmount } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ functions: { 'a/b': { buildStatus: 'Building' } } });
    await waitFor(() => expect(Object.keys(result.current).length).toBe(1));

    unmount();

    emitSnapshot({ functions: { 'c/d': { buildStatus: 'Succeeded' } } });

    expect(Object.keys(result.current).length).toBe(1);
  });

  it('updates state when event source emits', async () => {
    const { eventSource, emitSnapshot } = createContinuousStubEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({
      functions: {
        'bob/repo': { buildStatus: 'Succeeded', conclusion: 'success' },
      },
    });

    await waitFor(() => expect(Object.keys(result.current).length).toBe(1));
    expect(result.current['bob/repo']?.buildStatus).toBe('Succeeded');
  });

  it('updates state multiple times as snapshots arrive over time', async () => {
    vi.useFakeTimers();
    const eventSource = createSequentialStubEventSource([
      { functions: { 'x/y': { buildStatus: 'Building' } } },
      { functions: { 'x/y': { buildStatus: 'Succeeded' } } },
    ]);

    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    await vi.advanceTimersByTimeAsync(15);
    expect(result.current['x/y']?.buildStatus).toBe('Building');

    await vi.advanceTimersByTimeAsync(15);
    expect(result.current['x/y']?.buildStatus).toBe('Succeeded');
  });

  it('closes the stream when connectionId changes', async () => {
    const { eventSource, emitSnapshot } = createContinuousStubEventSource();
    let closeCalled = false;
    const originalClose = eventSource.close.bind(eventSource);
    eventSource.close = () => {
      closeCalled = true;
      originalClose();
    };

    const { result, rerender } = renderHook(({ connId }) => useBuildStatus(connId, eventSource), {
      initialProps: { connId: 0 },
    });

    emitSnapshot({ functions: { 'a/b': { buildStatus: 'Building' } } });
    await waitFor(() => expect(Object.keys(result.current).length).toBe(1));

    rerender({ connId: 1 });

    expect(closeCalled).toBe(true);
  });
});
