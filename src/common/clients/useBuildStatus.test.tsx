import { renderHook, waitFor } from '@testing-library/react';
import { PAT_KEY } from '../types';

const streamStub = await vi.hoisted(async () => import('../testing/sdkTestDoubles'));

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
      streamStub.buildStatusFrame({
        'alice/fn': { buildStatus: 'Building' },
        'alice/gn': { buildStatus: 'Failed', runURL: 'u' },
      }),
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('alice/fn')?.buildStatus).toBe('Building');
    expect(result.current.get('alice/gn')?.buildStatus).toBe('Failed');
    expect(result.current.get('alice/gn')?.runURL).toBe('u');
  });

  it('opens the stream with the request timeout disabled', async () => {
    // consoleFetch applies a default ~60s timeout that aborts the request. For a
    // long-lived SSE stream that would tear the connection down every minute
    // regardless of heartbeats, so the hook must pass timeout 0 to disable it.
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame({ 'alice/fn': { buildStatus: 'Building' } }),
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(streamStub.streamFetchLastArgs()[2]).toBe(0);
  });

  it('ignores heartbeat comment frames', async () => {
    streamStub.setStreamFrames([
      ':\n\n',
      streamStub.buildStatusFrame({ 'alice/fn': { buildStatus: 'Succeeded' } }),
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get('alice/fn')?.buildStatus).toBe('Succeeded');
  });

  it('ignores a frame with no event name', async () => {
    // An unnamed frame is a default "message" event, not our build-status event.
    vi.useFakeTimers();
    streamStub.setStreamFrames(['data: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n']);

    const { result, unmount } = renderHook(() => useBuildStatus());
    // Reconnecting proves the frame was read and dropped, not merely unread yet.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(streamStub.streamFetchCalls()).toBeGreaterThan(1);
    expect(result.current.size).toBe(0);

    unmount();
  });

  it('reassembles a frame split across two stream chunks', async () => {
    // A single build-status frame delivered as two separate reader.read() chunks;
    // the split falls in the middle of the JSON payload ("func" | "tions").
    streamStub.setStreamFrames([
      'event: build-status\ndata: {"func',
      'tions":{"a/b":{"buildStatus":"Building"}}}\n\n',
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get('a/b')?.buildStatus).toBe('Building');
  });

  it('applies the last snapshot when two frames arrive in one chunk', async () => {
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame({ 'a/b': { buildStatus: 'Building' } }) +
        streamStub.buildStatusFrame({ 'a/b': { buildStatus: 'Failed' } }),
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
      streamStub.buildStatusFrame({ 'alice/fn': { buildStatus: 'Building' } }),
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

  it('reconnects after a body-less response instead of stopping', async () => {
    vi.useFakeTimers();
    streamStub.setNullBodyForNext(1); // first connect yields a 2xx with no body

    const { unmount } = renderHook(() => useBuildStatus());
    // A body-less response must not permanently stop the stream: after the 3s
    // backoff the hook reconnects rather than giving up.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(streamStub.streamFetchCalls()).toBeGreaterThan(1);

    unmount();
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
