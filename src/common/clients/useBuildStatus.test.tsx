import { renderHook, waitFor } from '@testing-library/react';
import { PAT_KEY } from '../types';

const streamStub = await vi.hoisted(async () => import('../testing/consoleFetchStreamStub'));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: streamStub.consoleFetchStub,
}));

import { useBuildStatus } from './useBuildStatus';

describe('useBuildStatus', () => {
  beforeEach(() => {
    sessionStorage.setItem(PAT_KEY, 'test-pat');
    streamStub.resetStreamFrames();
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it('parses a build-status frame into a keyed map', async () => {
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame([
        { key: 'alice/fn', buildStatus: 'Building' },
        { key: 'alice/gn', buildStatus: 'Failed', failureReason: 'build / test', runURL: 'u' },
      ]),
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('alice/fn')?.buildStatus).toBe('Building');
    expect(result.current.get('alice/gn')?.failureReason).toBe('build / test');
  });

  it('ignores heartbeat comment frames', async () => {
    streamStub.setStreamFrames([
      ':\n\n',
      streamStub.buildStatusFrame([{ key: 'alice/fn', buildStatus: 'Succeeded' }]),
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get('alice/fn')?.buildStatus).toBe('Succeeded');
  });

  it('reassembles a frame split across two stream chunks', async () => {
    // A single build-status frame delivered as two separate reader.read() chunks;
    // the split falls in the middle of the JSON payload ("func" | "tions").
    streamStub.setStreamFrames([
      'event: build-status\ndata: {"func',
      'tions":[{"key":"a/b","buildStatus":"Building"}]}\n\n',
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get('a/b')?.buildStatus).toBe('Building');
  });

  it('applies the last snapshot when two frames arrive in one chunk', async () => {
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame([{ key: 'a/b', buildStatus: 'Building' }]) +
        streamStub.buildStatusFrame([{ key: 'a/b', buildStatus: 'Failed' }]),
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get('a/b')?.buildStatus).toBe('Failed');
  });

  it('stops reconnecting after an auth failure', async () => {
    vi.useFakeTimers();
    streamStub.setStreamError(Object.assign(new Error('unauthorized'), { code: 401 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderHook(() => useBuildStatus());
    // Advance well past the 3s backoff window; a stopped stream must not retry.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(streamStub.streamFetchCalls()).toBe(1);
    expect(errorSpy).toHaveBeenCalled();

    unmount();
  });

  it('restarts the stream when connectionId changes', async () => {
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame([{ key: 'alice/fn', buildStatus: 'Building' }]),
    ]);

    const { rerender } = renderHook(({ connectionId }) => useBuildStatus(connectionId), {
      initialProps: { connectionId: 1 },
    });

    await waitFor(() => expect(streamStub.streamFetchCalls()).toBe(1));

    // A new connection (initial login or account switch) must tear down the old
    // stream and open a fresh one carrying the new user's PAT.
    rerender({ connectionId: 2 });

    await waitFor(() => expect(streamStub.streamFetchCalls()).toBe(2));
  });

  it('reconnects with backoff after a transient stream error', async () => {
    vi.useFakeTimers();
    streamStub.setStreamError(new Error('network blip')); // no status code -> transient
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderHook(() => useBuildStatus());
    // 0ms + retries at 3s/6s/9s within the window.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(streamStub.streamFetchCalls()).toBeGreaterThan(1);
    expect(errorSpy).toHaveBeenCalled();

    unmount();
  });
});
