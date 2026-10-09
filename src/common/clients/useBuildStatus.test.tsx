import { describe, it, expect, vi } from 'vitest';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: vi.fn(),
}));

import { renderHook, waitFor } from '@testing-library/react';
import { useBuildStatus } from './useBuildStatus';
import { BuildSnapshot } from './functionsClient';

interface BuildSnapshotEvent {
  readonly data: string;
}

interface BuildWatchErrorEvent {
  readonly message: string;
  readonly isAuthError: boolean;
}

interface BuildStatusEventSource {
  addEventListener(
    event: 'build-status' | 'error' | 'open',
    cbk: ((e: BuildSnapshotEvent) => void) | ((e: BuildWatchErrorEvent) => void) | (() => void),
  ): void;
  close(): void;
}

describe('useBuildStatus', () => {
  it('parses a build-status frame into a keyed map', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();

    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({
      functions: {
        'alice/fn': { buildStatus: 'Building' },
        'alice/gn': { buildStatus: 'Failed', runURL: 'u' },
      },
    });

    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(2));
    expect(result.current.statuses['alice/fn']?.buildStatus).toBe('Building');
    expect(result.current.statuses['alice/gn']?.buildStatus).toBe('Failed');
    expect(result.current.statuses['alice/gn']?.runURL).toBe('u');
  });

  it('closes the stream on unmount, stopping updates', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();

    const { result, unmount } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ functions: { 'a/b': { buildStatus: 'Building' } } });
    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));

    unmount();

    emitSnapshot({ functions: { 'c/d': { buildStatus: 'Succeeded' } } });

    expect(Object.keys(result.current.statuses).length).toBe(1);
  });

  it('updates state when event source emits', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({
      functions: {
        'bob/repo': { buildStatus: 'Succeeded', conclusion: 'success' },
      },
    });

    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));
    expect(result.current.statuses['bob/repo']?.buildStatus).toBe('Succeeded');
  });

  it('updates state multiple times as snapshots arrive', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ functions: { 'x/y': { buildStatus: 'Building' } } });
    await waitFor(() => expect(result.current.statuses['x/y']?.buildStatus).toBe('Building'));

    emitSnapshot({ functions: { 'x/y': { buildStatus: 'Succeeded' } } });
    await waitFor(() => expect(result.current.statuses['x/y']?.buildStatus).toBe('Succeeded'));
  });

  it('closes the stream when connectionId changes', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();
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
    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));

    rerender({ connId: 1 });

    expect(closeCalled).toBe(true);
  });

  it('captures error events from the event source', async () => {
    const { eventSource, emitError } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitError({ message: 'Connection failed', isAuthError: false });

    await waitFor(() => expect(result.current.error).toBe('Connection failed'));
  });

  it('preserves statuses while error is present', async () => {
    const { eventSource, emitSnapshot, emitError } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ functions: { 'repo/owner': { buildStatus: 'Building' } } });
    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));

    emitError({ message: 'Network error', isAuthError: false });
    await waitFor(() => expect(result.current.error).toBe('Network error'));

    // Statuses should still be present
    expect(result.current.statuses['repo/owner']?.buildStatus).toBe('Building');
  });

  it('clears error when open event is emitted', async () => {
    const { eventSource, emitError, emitOpen } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitError({ message: 'Connection failed', isAuthError: false });
    await waitFor(() => expect(result.current.error).toBe('Connection failed'));

    emitOpen();
    await waitFor(() => expect(result.current.error).toBeUndefined());
  });

  it('does not set up stream when connectionId is undefined', () => {
    const eventSource = {
      addEventListener: vi.fn(),
      close: vi.fn(),
    };

    const { result } = renderHook(() => useBuildStatus(undefined, eventSource));

    // Event source should not be registered with
    expect(eventSource.addEventListener).not.toHaveBeenCalled();
    expect(eventSource.close).not.toHaveBeenCalled();

    // Hook returns empty state
    expect(result.current.statuses).toEqual({});
    expect(result.current.error).toBeUndefined();
  });

  it('sets error when build-status event data is malformed JSON', async () => {
    const { eventSource, emitSnapshot, emitRaw } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ functions: { 'a/b': { buildStatus: 'Building' } } });
    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));

    emitRaw('invalid json data');
    await waitFor(() => expect(result.current.error).toBe('Invalid build status data'));

    // Statuses are preserved
    expect(Object.keys(result.current.statuses).length).toBe(1);
  });

  function createFakeEventSource(): {
    eventSource: BuildStatusEventSource;
    emitSnapshot: (snap: BuildSnapshot) => void;
    emitError: (err: BuildWatchErrorEvent) => void;
    emitOpen: () => void;
    emitRaw: (data: string) => void;
  } {
    const listeners: Array<(e: BuildSnapshotEvent) => void> = [];
    const errorListeners: Array<(e: BuildWatchErrorEvent) => void> = [];
    const openListeners: Array<() => void> = [];
    let open = true;

    function invokeListeners<T>(listeners: Array<(e: T) => void>, val: T) {
      queueMicrotask(() => {
        if (!open) return;
        listeners.forEach((cbk) => {
          try {
            cbk(val);
          } catch (e: unknown) {
            console.error('listener thrown:', e);
          }
        });
      });
    }

    return {
      eventSource: {
        addEventListener(
          event: 'build-status' | 'error' | 'open',
          cbk:
            ((e: BuildSnapshotEvent) => void) | ((e: BuildWatchErrorEvent) => void) | (() => void),
        ) {
          if (event === 'build-status') {
            listeners.push(cbk as (e: BuildSnapshotEvent) => void);
          } else if (event === 'error') {
            errorListeners.push(cbk as (e: BuildWatchErrorEvent) => void);
          } else if (event === 'open') {
            openListeners.push(cbk as () => void);
          }
        },
        close() {
          open = false;
          listeners.length = 0;
          errorListeners.length = 0;
          openListeners.length = 0;
        },
      },
      emitSnapshot(snap: BuildSnapshot) {
        invokeListeners(listeners, { data: JSON.stringify(snap) });
      },
      emitError(err: BuildWatchErrorEvent) {
        invokeListeners(errorListeners, err);
      },
      emitOpen() {
        invokeListeners(openListeners, undefined);
      },
      emitRaw(data: string) {
        invokeListeners(listeners, { data });
      },
    };
  }
});
