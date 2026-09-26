import { describe, it, expect, afterEach, vi } from 'vitest';

// Prevent loading SDK components (which have .scss imports that fail in test env)
// but keep the exported functions by providing mocked implementations.
vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: vi.fn((url: string, options?: RequestInit) => fetch(url, options)),
  consoleFetchJSON: vi.fn(),
  isAllNamespacesKey: vi.fn(),
}));

import { http, HttpResponse } from 'msw';
import { server } from '../testing/mswServer';
import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';
import { BuildSnapshot, createBuildStatusEventSource } from './functionsClient';
import { AsyncQueue } from '../utils/AsyncQueue';

const BUILD_WATCH_URL =
  '/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch';

describe('createBuildStatusEventSource', () => {
  const createdSources: ReturnType<typeof createBuildStatusEventSource>[] = [];

  afterEach(() => {
    createdSources.forEach((source) => source.close());
    createdSources.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    server.resetHandlers();
    // Reset to default behavior (delegate to fetch) after tests that override it
    vi.mocked(consoleFetch).mockImplementation((url: string, options?: RequestInit) =>
      fetch(url, options),
    );
  });

  it.each<{
    description: string;
    frames: string;
    expectedKey: string;
    expectedStatus: string;
  }>([
    {
      description: 'emits parsed build-status events from SSE stream',
      frames: 'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n',
      expectedKey: 'a/b',
      expectedStatus: 'Building',
    },
    {
      description: 'ignores frames without build-status event name',
      frames:
        'event: message\ndata: {"functions":{"ignored":"data"}}\n\n' +
        'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Succeeded"}}}\n\n',
      expectedKey: 'a/b',
      expectedStatus: 'Succeeded',
    },
    {
      description: 'ignores a frame with no event name',
      frames:
        'data: {"irrelevant":"not a build-status event"}\n\n' +
        'event: build-status\ndata: {"functions":{"c/d":{"buildStatus":"Succeeded"}}}\n\n',
      expectedKey: 'c/d',
      expectedStatus: 'Succeeded',
    },
    {
      description: 'handles heartbeat comment frames',
      frames: ':\n\nevent: build-status\ndata: {"functions":{"x/y":{"buildStatus":"Failed"}}}\n\n',
      expectedKey: 'x/y',
      expectedStatus: 'Failed',
    },
  ])('$description', async ({ frames, expectedKey, expectedStatus }) => {
    useStaticEventStream(frames);

    const eventSource = createTrackedSource();
    await using eventQueue = captureBuildStatuses(eventSource);

    const event = await eventQueue.dequeue();
    expect(event.functions[expectedKey].buildStatus).toBe(expectedStatus);
  });

  it('emits error event from SSE stream', async () => {
    const sseFrames = 'event: error\ndata: github API rate limited\n\n';
    useStaticEventStream(sseFrames);

    const eventSource = createTrackedSource();
    await using errorQueue = captureErrors(eventSource);

    const error = await errorQueue.dequeue();
    expect(error.message).toBe('github API rate limited');
    expect(error.isAuthError).toBe(false);
  });

  it('emits error on 401 auth failure', async () => {
    server.use(
      http.get(
        '/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch',
        () => new HttpResponse(null, { status: 401, statusText: 'Unauthorized' }),
      ),
    );

    const eventSource = createTrackedSource();
    await using errorQueue = captureErrors(eventSource);

    const error = await errorQueue.dequeue();
    expect(error.isAuthError).toBe(true);
  });

  it('emits open event on successful connection', async () => {
    server.use(
      http.get(BUILD_WATCH_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          start() {
            // Open connection but send nothing
          },
        });
        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const eventSource = createTrackedSource();
    await using openQueue = new AsyncQueue<void>();
    eventSource.addEventListener('open', () => {
      openQueue.enqueue(undefined);
    });

    await openQueue.dequeue();
  });

  it('logs listener errors and continues streaming', async () => {
    useStaticEventStream(
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n' +
        'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Succeeded"}}}\n\n',
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const eventSource = createTrackedSource();

    // Listener that throws
    eventSource.addEventListener('build-status', () => {
      throw new Error('listener boom');
    });

    // Successful listener (proves stream continues after error)
    await using eventQueue = captureBuildStatuses(eventSource);

    const event1 = await eventQueue.dequeue();
    const event2 = await eventQueue.dequeue();

    expect(event1.functions['a/b'].buildStatus).toBe('Building');
    expect(event2.functions['a/b'].buildStatus).toBe('Succeeded');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('BuildStatusEventSource'),
      expect.any(Error),
    );
  });

  it('does not reconnect after 401 auth error', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    let errorCount = 0;
    server.use(
      http.get(BUILD_WATCH_URL, () => {
        callCount++;
        return new HttpResponse(null, { status: 401, statusText: 'Unauthorized' });
      }),
    );

    const eventSource = createTrackedSource();
    eventSource.addEventListener('error', () => {
      errorCount++;
    });

    // Advance past first error
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1);
    expect(errorCount).toBe(1);

    // Advance past reconnect delay (3000ms) — should NOT make second request
    await vi.advanceTimersByTimeAsync(3100);

    expect(callCount).toBe(1);
    expect(errorCount).toBe(1);
  });

  it('reconnects on transient (5xx) errors', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    server.use(
      http.get(BUILD_WATCH_URL, () => {
        callCount++;
        if (callCount === 1) {
          return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
        }
        // Second call succeeds
        const sseFrame =
          'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n';
        return HttpResponse.text(sseFrame, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const eventSource = createTrackedSource();
    await using errorQueue = captureErrors(eventSource);
    await using eventQueue = captureBuildStatuses(eventSource);

    // First error arrives immediately
    const error = await errorQueue.dequeue();
    expect(error.isAuthError).toBe(false);

    // Advance past reconnect delay (3000ms)
    await vi.advanceTimersByTimeAsync(3100);

    // Event arrives on successful reconnect
    const event = await eventQueue.dequeue();
    expect(event.functions['a/b'].buildStatus).toBe('Building');

    expect(callCount).toBe(2);
  });

  it('reconnects when response has no body', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    server.use(
      http.get(BUILD_WATCH_URL, () => {
        callCount++;
        if (callCount === 1) {
          // First call: 200 with no body
          return new HttpResponse(null, { status: 200 });
        }
        // Subsequent calls succeed with SSE frame
        const sseFrame =
          'event: build-status\ndata: {"functions":{"c/d":{"buildStatus":"Succeeded"}}}\n\n';
        return HttpResponse.text(sseFrame, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const eventSource = createTrackedSource();
    await using eventQueue = captureBuildStatuses(eventSource);

    // Advance past reconnect delay (first request is made immediately)
    await vi.advanceTimersByTimeAsync(3100);

    // Event arrives on successful reconnect
    const event = await eventQueue.dequeue();
    expect(event.functions['c/d'].buildStatus).toBe('Succeeded');
  });

  it('handles multiple sequential build-status events', async () => {
    const sseFrames =
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n' +
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Succeeded"}}}\n\n' +
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Failed"}}}\n\n';
    useStaticEventStream(sseFrames);

    const eventSource = createTrackedSource();
    await using eventQueue = captureBuildStatuses(eventSource);

    const event1 = await eventQueue.dequeue();
    const event2 = await eventQueue.dequeue();
    const event3 = await eventQueue.dequeue();

    expect(event1.functions['a/b'].buildStatus).toBe('Building');
    expect(event2.functions['a/b'].buildStatus).toBe('Succeeded');
    expect(event3.functions['a/b'].buildStatus).toBe('Failed');
  });

  it('handles large payload in single frame', async () => {
    // Large function map to ensure decoder handles bigger payloads
    const largePayload = {
      functions: Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [
          `fn${i}/repo${i}`,
          { buildStatus: `Status${i}`, runURL: `http://example.com/${i}` },
        ]),
      ),
    };
    const sseFrame = `event: build-status\ndata: ${JSON.stringify(largePayload)}\n\n`;
    useStaticEventStream(sseFrame);

    const eventSource = createTrackedSource();
    await using eventQueue = captureBuildStatuses(eventSource);

    const event = await eventQueue.dequeue();

    expect(Object.keys(event.functions).length).toBe(50);
    expect(event.functions['fn0/repo0']).toBeDefined();
    expect(event.functions['fn49/repo49']).toBeDefined();
  });

  it('handles SSE frames split across multiple chunks, including split in delimiter', async () => {
    // Simulate frames arriving fragmented, with the split in the middle of '\n\n' delimiter
    server.use(
      http.get(BUILD_WATCH_URL, () => {
        const chunks = [
          'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n',
          '\nevent: build-',
          'status\ndata: {"functions":{"c/d":{"buildStatus":"Succeeded"',
          '}}}\n\n',
        ];

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const eventSource = createTrackedSource();
    await using eventQueue = captureBuildStatuses(eventSource);

    const event1 = await eventQueue.dequeue();
    const event2 = await eventQueue.dequeue();

    expect(event1.functions['a/b'].buildStatus).toBe('Building');
    expect(event2.functions['c/d'].buildStatus).toBe('Succeeded');
  });

  it('passes timeout: 0 to prevent default ~60s timeout on long-lived stream', async () => {
    vi.useFakeTimers();

    const sseFrame =
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n';

    vi.mocked(consoleFetch).mockImplementation(
      (_url: string, _options?: RequestInit, timeout?: number) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(sseFrame));

            // If timeout is not 0, simulate the stream closing after that duration
            if (timeout) {
              setTimeout(() => controller.error(new Error('Request timeout')), timeout);
            }
          },
        });

        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      },
    );

    const eventSource = createTrackedSource();

    let gotBuildStatus = false;
    let gotError = false;

    eventSource.addEventListener('build-status', () => {
      gotBuildStatus = true;
    });

    eventSource.addEventListener('error', () => {
      gotError = true;
    });

    // Advance time past the 60-second default timeout threshold.
    // If timeout: 0 was not passed, the stream would error and data would be cleared.
    await vi.advanceTimersByTimeAsync(65000);

    // Verify the stream succeeded (didn't timeout)
    expect(gotBuildStatus).toBe(true);
    expect(gotError).toBe(false);
  });

  it('aborts the HTTP connection when close() is called', async () => {
    let abortHandlerCalled = false;
    server.use(
      http.get(BUILD_WATCH_URL, ({ request }) => {
        request.signal.addEventListener('abort', () => {
          abortHandlerCalled = true;
        });
        const sseFrame =
          'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n';
        let intervalId: NodeJS.Timeout | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(sseFrame));
            intervalId = setInterval(() => {
              controller.enqueue(encoder.encode(':\n\n'));
            }, 100);
          },
          cancel() {
            if (intervalId) clearInterval(intervalId);
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );

    const eventSource = createTrackedSource();
    await using eventQueue = captureBuildStatuses(eventSource);

    const event = await eventQueue.dequeue();
    expect(event.functions['a/b'].buildStatus).toBe('Building');

    eventSource.close();

    expect(abortHandlerCalled).toBe(true);
  });

  it('stops receiving events after close() is called', async () => {
    await using frameQueue = new AsyncQueue<string>();

    server.use(
      http.get(BUILD_WATCH_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            for await (const frame of frameQueue) {
              controller.enqueue(encoder.encode(frame));
            }
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );

    const eventSource = createTrackedSource();
    await using eventQueue = captureBuildStatuses(eventSource);

    frameQueue.enqueue(
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"None"}}}\n\n',
    );
    const event = await eventQueue.dequeue();
    expect(event.functions['a/b'].buildStatus).toBe('None');

    eventSource.close();

    // emit after close
    frameQueue.enqueue(
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n',
    );

    const raceResult = await Promise.race([
      eventQueue.dequeue().then(() => 'event received'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    expect(raceResult).toBe('timeout');
  });

  function createTrackedSource() {
    const source = createBuildStatusEventSource();
    createdSources.push(source);
    return source;
  }

  function useStaticEventStream(frames: string) {
    server.use(
      http.get(BUILD_WATCH_URL, () =>
        HttpResponse.text(frames, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
  }

  function captureBuildStatuses(eventSource: ReturnType<typeof createBuildStatusEventSource>) {
    const queue = new AsyncQueue<BuildSnapshot>();
    eventSource.addEventListener('build-status', (e) => {
      queue.enqueue(JSON.parse(e.data));
    });
    return queue;
  }

  function captureErrors(eventSource: ReturnType<typeof createBuildStatusEventSource>) {
    const queue = new AsyncQueue<{ message: string; isAuthError: boolean }>();
    eventSource.addEventListener('error', (e) => {
      queue.enqueue(e);
    });
    return queue;
  }
});
