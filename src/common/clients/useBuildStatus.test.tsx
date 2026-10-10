import { describe, it, expect, vi } from 'vitest';

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: vi.fn(),
}));

import { renderHook, waitFor } from '@testing-library/react';
import { useBuildStatus } from './useBuildStatus';
import { BuildSnapshotEvent, BuildWatchErrorEvent } from './functionsClient';
import { WorkflowRunRecord } from '../types';
import { AppError } from '../errors';

interface BuildStatusEventSource {
  addEventListener(
    event: 'build-status' | 'app-error' | 'open' | 'error',
    cbk: ((e: BuildSnapshotEvent) => void) | ((e: BuildWatchErrorEvent) => void) | (() => void),
  ): void;
  close(): void;
}

describe('useBuildStatus', () => {
  const CLOSED_ERROR = 'emit on closed fake EventSource';

  it('parses a build-status frame into a keyed map', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();

    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({
      'alice/fn': { status: 'Building' },
      'alice/gn': { status: 'Failed', url: 'u' },
    });

    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(2));
    expect(result.current.statuses['alice/fn']?.status).toBe('Building');
    expect(result.current.statuses['alice/gn']?.status).toBe('Failed');
    expect(result.current.statuses['alice/gn']?.url).toBe('u');
  });

  it('closes the stream on unmount, stopping updates', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();

    const { result, unmount } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ 'a/b': { status: 'Building' } });
    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));

    unmount();

    expect(() => {
      emitSnapshot({ 'c/d': { status: 'Succeeded' } });
    }).toThrow(CLOSED_ERROR);
  });

  it('updates state when event source emits', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ 'bob/repo': { status: 'Succeeded' } });

    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));
    expect(result.current.statuses['bob/repo']?.status).toBe('Succeeded');
  });

  it('updates state multiple times as snapshots arrive', async () => {
    const { eventSource, emitSnapshot } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ 'x/y': { status: 'Building' } });
    await waitFor(() => expect(result.current.statuses['x/y']?.status).toBe('Building'));

    emitSnapshot({ 'x/y': { status: 'Succeeded' } });
    await waitFor(() => expect(result.current.statuses['x/y']?.status).toBe('Succeeded'));
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

    emitSnapshot({ 'a/b': { status: 'Building' } });
    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));

    rerender({ connId: 1 });

    expect(closeCalled).toBe(true);
  });

  it('captures error events from the event source', async () => {
    const { eventSource, emitAppError } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitAppError({ message: 'Connection failed' });

    await waitFor(() => expect(result.current.error).toBe('Connection failed'));
  });

  it('preserves statuses while error is present', async () => {
    const { eventSource, emitSnapshot, emitAppError } = createFakeEventSource();
    const { result } = renderHook(() => useBuildStatus(0, eventSource));

    emitSnapshot({ 'repo/owner': { status: 'Building' } });
    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));

    emitAppError({ message: 'Network error' });
    await waitFor(() => expect(result.current.error).toBe('Network error'));

    // Statuses should still be present
    expect(result.current.statuses['repo/owner']?.status).toBe('Building');
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

    emitSnapshot({ 'a/b': { status: 'Building' } });
    await waitFor(() => expect(Object.keys(result.current.statuses).length).toBe(1));

    emitRaw('invalid json data');
    await waitFor(() => expect(result.current.error).toBe('Invalid build status data'));

    // Statuses are preserved
    expect(Object.keys(result.current.statuses).length).toBe(1);
  });

  function createFakeEventSource(): {
    eventSource: BuildStatusEventSource;
    emitSnapshot: (snap: WorkflowRunRecord) => void;
    emitAppError: (err: AppError) => void;
    emitError: () => void;
    emitOpen: () => void;
    emitRaw: (data: string) => void;
  } {
    const listeners: Array<(e: BuildSnapshotEvent) => void> = [];
    const errorAppListeners: Array<(e: BuildWatchErrorEvent) => void> = [];
    const errorListeners: Array<() => void> = [];
    const openListeners: Array<() => void> = [];
    let open = true;

    function invokeListeners<T>(listeners: Array<(e: T) => void>, val: T) {
      if (!open) throw new Error(CLOSED_ERROR);
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
          event: 'build-status' | 'app-error' | 'open' | 'error',
          cbk:
            ((e: BuildSnapshotEvent) => void) | ((e: BuildWatchErrorEvent) => void) | (() => void),
        ) {
          if (event === 'build-status') {
            listeners.push(cbk as (e: BuildSnapshotEvent) => void);
          } else if (event === 'app-error') {
            errorAppListeners.push(cbk as (e: BuildWatchErrorEvent) => void);
          } else if (event === 'open') {
            openListeners.push(cbk as () => void);
          } else if (event === 'error') {
            errorListeners.push(cbk as () => void);
          }
        },
        close() {
          open = false;
          listeners.length = 0;
          errorAppListeners.length = 0;
          openListeners.length = 0;
        },
      },
      emitSnapshot(snap: WorkflowRunRecord) {
        invokeListeners(listeners, { data: JSON.stringify(snap) });
      },
      emitAppError(err: AppError) {
        invokeListeners(errorAppListeners, { data: JSON.stringify(err) });
      },
      emitOpen() {
        invokeListeners(openListeners, undefined);
      },
      emitRaw(data: string) {
        invokeListeners(listeners, { data });
      },
      emitError() {
        invokeListeners(errorListeners, undefined);
      },
    };
  }
});
