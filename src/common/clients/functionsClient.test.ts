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
import { BuildStatusEventSource, createBuildStatusEventSource } from './functionsClient';
import { WorkflowRunRecord } from '../types';
import { AsyncQueue } from '../utils/AsyncQueue';
import { AppError } from '../errors';

const BUILD_WATCH_URL =
  '/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch';

describe('createBuildStatusEventSource', () => {
  afterEach(() => {
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
      frames: 'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n',
      expectedKey: 'a/b',
      expectedStatus: 'Building',
    },
    {
      description: 'ignores frames without build-status event name',
      frames:
        'event: message\ndata: {"ignored":"data"}}\n\n' +
        'event: build-status\ndata: {"a/b":{"status":"Succeeded"}}\n\n',
      expectedKey: 'a/b',
      expectedStatus: 'Succeeded',
    },
    {
      description: 'ignores a frame with no event name',
      frames:
        'data: {"irrelevant":"not a build-status event"}\n\n' +
        'event: build-status\ndata: {"c/d":{"status":"Succeeded"}}\n\n',
      expectedKey: 'c/d',
      expectedStatus: 'Succeeded',
    },
    {
      description: 'handles heartbeat comment frames',
      frames: ':\n\nevent: build-status\ndata: {"x/y":{"status":"Failed"}}\n\n',
      expectedKey: 'x/y',
      expectedStatus: 'Failed',
    },
  ])('$description', async ({ frames, expectedKey, expectedStatus }) => {
    useStaticEventStream(frames);

    using eventSource = createEventSource();
    using eventQueue = captureBuildStatuses(eventSource);

    const event = await eventQueue.dequeue();
    expect(event[expectedKey].status).toBe(expectedStatus);
  });

  it('emits error event from SSE stream', async () => {
    const sseFrames =
      'event: app-error\ndata: {"message":"github API rate limited","code":429}\n\n';
    useStaticEventStream(sseFrames);

    using eventSource = createEventSource();
    using errorQueue = captureErrors(eventSource);

    const error = await errorQueue.dequeue();
    expect(error.message).toBe('github API rate limited');
    expect(error.code).toBe(429);
  });

  it('emits error on 401 auth failure', async () => {
    server.use(
      http.get(
        '/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch',
        () => new HttpResponse(null, { status: 401, statusText: 'Unauthorized' }),
      ),
    );

    using eventSource = createEventSource();
    using errorQueue = captureErrors(eventSource);

    const error = await errorQueue.dequeue();
    expect(error.code).toBe(401);
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

    using eventSource = createEventSource();
    using openQueue = new AsyncQueue<void>();
    eventSource.addEventListener('open', () => {
      openQueue.enqueue(undefined);
    });

    await expect(openQueue.dequeue()).resolves.toBeUndefined();
  });

  it('logs listener errors and continues streaming', async () => {
    useStaticEventStream(
      'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n' +
        'event: build-status\ndata: {"a/b":{"status":"Succeeded"}}\n\n',
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    using eventSource = createEventSource();

    // Listener that throws
    eventSource.addEventListener('build-status', () => {
      throw new Error('listener boom');
    });

    // Successful listener (proves stream continues after error)
    using eventQueue = captureBuildStatuses(eventSource);

    const event1 = await eventQueue.dequeue();
    const event2 = await eventQueue.dequeue();

    expect(event1['a/b'].status).toBe('Building');
    expect(event2['a/b'].status).toBe('Succeeded');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('BuildStatusEventSource'),
      expect.any(Error),
    );
  });

  it('does not reconnect after 401 auth error', async () => {
    vi.useFakeTimers();
    let errorCount = 0;
    server.use(
      http.get(BUILD_WATCH_URL, () => {
        return new HttpResponse(null, { status: 401, statusText: 'Unauthorized' });
      }),
    );

    using eventSource = createEventSource();
    eventSource.addEventListener('app-error', () => {
      errorCount++;
    });

    // Advance past first error
    await vi.advanceTimersByTimeAsync(100);
    expect(errorCount).toBe(1);

    // Advance past reconnect delay (3000ms) — should NOT make second request
    await vi.advanceTimersByTimeAsync(3100);
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
        const sseFrame = 'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n';
        return HttpResponse.text(sseFrame, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    using eventSource = createEventSource();
    using errorQueue = captureErrors(eventSource);
    using eventQueue = captureBuildStatuses(eventSource);

    // First error arrives immediately
    const error = await errorQueue.dequeue();
    expect(error.code).toBe(500);

    // Advance past reconnect delay (3000ms)
    await vi.advanceTimersByTimeAsync(3100);

    // Event arrives on successful reconnect
    const event = await eventQueue.dequeue();
    expect(event['a/b'].status).toBe('Building');
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
        const sseFrame = 'event: build-status\ndata: {"c/d":{"status":"Succeeded"}}\n\n';
        return HttpResponse.text(sseFrame, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    using eventSource = createEventSource();
    using eventQueue = captureBuildStatuses(eventSource);

    // Advance past reconnect delay (first request is made immediately)
    await vi.advanceTimersByTimeAsync(3100);

    // Event arrives on successful reconnect
    const event = await eventQueue.dequeue();
    expect(event['c/d'].status).toBe('Succeeded');
  });

  it('handles multiple sequential build-status events', async () => {
    const sseFrames =
      'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n' +
      'event: build-status\ndata: {"a/b":{"status":"Succeeded"}}\n\n' +
      'event: build-status\ndata: {"a/b":{"status":"Failed"}}\n\n';
    useStaticEventStream(sseFrames);

    using eventSource = createEventSource();
    using eventQueue = captureBuildStatuses(eventSource);

    const event1 = await eventQueue.dequeue();
    const event2 = await eventQueue.dequeue();
    const event3 = await eventQueue.dequeue();

    expect(event1['a/b'].status).toBe('Building');
    expect(event2['a/b'].status).toBe('Succeeded');
    expect(event3['a/b'].status).toBe('Failed');
  });

  it('handles large payload in single frame', async () => {
    // Large function map to ensure decoder handles bigger payloads
    const largePayload = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `fn${i}/repo${i}`,
        { status: 'Building', url: `http://example.com/${i}` },
      ]),
    );
    const sseFrame = `event: build-status\ndata: ${JSON.stringify(largePayload)}\n\n`;
    useStaticEventStream(sseFrame);

    using eventSource = createEventSource();
    using eventQueue = captureBuildStatuses(eventSource);

    const event = await eventQueue.dequeue();

    expect(Object.keys(event).length).toBe(50);
    expect(event['fn0/repo0']).toBeDefined();
    expect(event['fn49/repo49']).toBeDefined();
    expect(event['fn49/repo49'].status).toBe('Building');
    expect(event['fn49/repo49'].url).toBe('http://example.com/49');
  });

  it('handles SSE frames split across multiple chunks, including split in delimiter', async () => {
    // Simulate frames arriving fragmented, with the split in the middle of '\n\n' delimiter
    server.use(
      http.get(BUILD_WATCH_URL, () => {
        const chunks = [
          'event: build-status\ndata: {"a/b":{"status":"Building"}}\n',
          '\nevent: build-',
          'status\ndata: {"c/d":{"status":"Succeeded"',
          '}}\n\n',
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

    using eventSource = createEventSource();
    using eventQueue = captureBuildStatuses(eventSource);

    const event1 = await eventQueue.dequeue();
    const event2 = await eventQueue.dequeue();

    expect(event1['a/b'].status).toBe('Building');
    expect(event2['c/d'].status).toBe('Succeeded');
  });

  it('passes timeout: 0 to prevent default ~60s timeout on long-lived stream', async () => {
    vi.useFakeTimers();

    const sseFrame =
      'event: build-status\ndata: {"statuses":{"a/b":{"buildStatus":"Building"}}}\n\n';

    vi.mocked(consoleFetch).mockImplementation(
      (_url: string, _options?: RequestInit, timeout?: number) => {
        if (timeout === undefined) timeout = 60_000;
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

    using eventSource = createEventSource();

    let gotBuildStatus = false;
    let gotError = false;

    eventSource.addEventListener('build-status', () => {
      gotBuildStatus = true;
    });

    eventSource.addEventListener('app-error', () => {
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
        const sseFrame = 'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n';
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

    using eventSource = createEventSource();
    using eventQueue = captureBuildStatuses(eventSource);

    const event = await eventQueue.dequeue();
    expect(event['a/b'].status).toBe('Building');

    eventSource.close();

    expect(abortHandlerCalled).toBe(true);
  });

  it('stops receiving events after close() is called', async () => {
    using frameQueue = new AsyncQueue<string>();

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

    using eventSource = createEventSource();
    using eventQueue = captureBuildStatuses(eventSource);

    frameQueue.enqueue('event: build-status\ndata: {"a/b":{"status":"None"}}\n\n');
    const event = await eventQueue.dequeue();
    expect(event['a/b'].status).toBe('None');

    eventSource.close();

    // emit after close
    frameQueue.enqueue('event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n');

    const raceResult = await Promise.race([
      eventQueue.dequeue().then(() => 'event received'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    expect(raceResult).toBe('timeout');
  });

  // makes our EventSource disposable so we can use automatic 'using' cleanup
  function createEventSource(): BuildStatusEventSource & Disposable {
    const source = createBuildStatusEventSource();
    return Object.assign(source, {
      [Symbol.dispose]() {
        source.close();
      },
    });
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
    const queue = new AsyncQueue<WorkflowRunRecord>();
    eventSource.addEventListener('build-status', (e) => {
      queue.enqueue(JSON.parse(e.data));
    });
    return queue;
  }

  function captureErrors(eventSource: ReturnType<typeof createBuildStatusEventSource>) {
    const queue = new AsyncQueue<AppError>();
    eventSource.addEventListener('app-error', (e) => {
      try {
        const error = JSON.parse(e.data) as AppError;
        queue.enqueue(error);
      } catch {
        queue.enqueue({ message: 'captureErrors failed to parse the event' });
      }
    });
    return queue;
  }
});
