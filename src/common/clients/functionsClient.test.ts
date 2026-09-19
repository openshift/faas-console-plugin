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
import { createBuildStatusEventSource } from './functionsClient';

describe('createBuildStatusEventSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    server.resetHandlers();
    // Reset to default behavior (delegate to fetch) after tests that override it
    vi.mocked(consoleFetch).mockImplementation((url: string, options?: RequestInit) =>
      fetch(url, options),
    );
  });

  it('emits parsed build-status events from SSE stream', async () => {
    const sseFrame =
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n';

    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () =>
        HttpResponse.text(sseFrame, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const eventSource = createBuildStatusEventSource();
    const eventQueue = new AsyncQueue<{ functions: Record<string, { buildStatus: string }> }>();

    eventSource.addEventListener('build-status', (e) => {
      eventQueue.enqueue(JSON.parse(e.data));
    });

    const event = await eventQueue.dequeue();
    expect(event.functions['a/b'].buildStatus).toBe('Building');

    eventSource.close();
  });

  it('ignores frames without build-status event name', async () => {
    const sseFrames =
      'event: message\ndata: {"functions":{"ignored":"data"}}\n\n' +
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Succeeded"}}}\n\n';

    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () =>
        HttpResponse.text(sseFrames, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const eventSource = createBuildStatusEventSource();
    const eventQueue = new AsyncQueue<{ functions: Record<string, { buildStatus: string }> }>();

    eventSource.addEventListener('build-status', (e) => {
      eventQueue.enqueue(JSON.parse(e.data));
    });

    const event = await eventQueue.dequeue();
    expect(event.functions['a/b'].buildStatus).toBe('Succeeded');

    eventSource.close();
  });

  it('ignores a frame with no event name', async () => {
    const sseFrames =
      'data: {"irrelevant":"not a build-status event"}\n\n' +
      'event: build-status\ndata: {"functions":{"c/d":{"buildStatus":"Succeeded"}}}\n\n';

    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () =>
        HttpResponse.text(sseFrames, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const eventSource = createBuildStatusEventSource();
    const eventQueue = new AsyncQueue<{ functions: Record<string, { buildStatus: string }> }>();

    eventSource.addEventListener('build-status', (e) => {
      eventQueue.enqueue(JSON.parse(e.data));
    });

    const event = await eventQueue.dequeue();
    expect(event.functions['c/d'].buildStatus).toBe('Succeeded');

    eventSource.close();
  });

  it('handles heartbeat comment frames', async () => {
    const sseFrames =
      ':\n\nevent: build-status\ndata: {"functions":{"x/y":{"buildStatus":"Failed"}}}\n\n';

    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () =>
        HttpResponse.text(sseFrames, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );

    const eventSource = createBuildStatusEventSource();
    const eventQueue = new AsyncQueue<{ functions: Record<string, { buildStatus: string }> }>();

    eventSource.addEventListener('build-status', (e) => {
      eventQueue.enqueue(JSON.parse(e.data));
    });

    const event = await eventQueue.dequeue();
    expect(event.functions['x/y'].buildStatus).toBe('Failed');

    eventSource.close();
  });

  it('emits error on 401 auth failure', async () => {
    server.use(
      http.get(
        '/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch',
        () => new HttpResponse(null, { status: 401, statusText: 'Unauthorized' }),
      ),
    );

    const eventSource = createBuildStatusEventSource();
    const errorQueue = new AsyncQueue<{ message: string; isAuthError: boolean }>();

    eventSource.addEventListener('error', (e) => {
      errorQueue.enqueue(e);
    });

    const error = await errorQueue.dequeue();
    expect(error.isAuthError).toBe(true);

    eventSource.close();
  });

  it('does not reconnect after 401 auth error', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    let errorCount = 0;
    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () => {
        callCount++;
        return new HttpResponse(null, { status: 401, statusText: 'Unauthorized' });
      }),
    );

    const eventSource = createBuildStatusEventSource();
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

    eventSource.close();
    vi.useRealTimers();
  });

  it('reconnects on transient (5xx) errors', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () => {
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

    const eventSource = createBuildStatusEventSource();
    const errors: Array<{ message: string; isAuthError: boolean }> = [];
    const events: Array<{ functions: Record<string, { buildStatus: string }> }> = [];

    eventSource.addEventListener('error', (e) => {
      errors.push(e);
    });

    eventSource.addEventListener('build-status', (e) => {
      events.push(JSON.parse(e.data));
    });

    // Advance past first 500 error
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].isAuthError).toBe(false);

    // Advance past reconnect delay (3000ms)
    await vi.advanceTimersByTimeAsync(3100);

    // Wait for second request to complete
    await vi.advanceTimersByTimeAsync(100);

    expect(callCount).toBe(2);
    expect(events.length).toBe(1);
    expect(events[0].functions['a/b'].buildStatus).toBe('Building');

    eventSource.close();
    vi.useRealTimers();
  });

  it('reconnects when response has no body', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () => {
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

    const eventSource = createBuildStatusEventSource();
    const events: Array<{ functions: Record<string, { buildStatus: string }> }> = [];

    eventSource.addEventListener('build-status', (e) => {
      events.push(JSON.parse(e.data));
      // Close after first successful event to prevent further retries
      eventSource.close();
    });

    // Advance past reconnect delay (first request is made immediately)
    await vi.advanceTimersByTimeAsync(3100);

    // Wait for second request to complete
    await vi.advanceTimersByTimeAsync(100);

    // Should have made two requests: first returned no body, second succeeded
    expect(callCount).toBe(2);
    expect(events.length).toBe(1);
    expect(events[0].functions['c/d'].buildStatus).toBe('Succeeded');

    vi.useRealTimers();
  });

  it('handles multiple sequential build-status events', async () => {
    const sseFrames =
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n' +
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Succeeded"}}}\n\n' +
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Failed"}}}\n\n';

    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () =>
        HttpResponse.text(sseFrames, { headers: { 'Content-Type': 'text/event-stream' } }),
      ),
    );

    const eventSource = createBuildStatusEventSource();
    const eventQueue = new AsyncQueue<{ functions: Record<string, { buildStatus: string }> }>();

    eventSource.addEventListener('build-status', (e) => {
      eventQueue.enqueue(JSON.parse(e.data));
    });

    const event1 = await eventQueue.dequeue();
    const event2 = await eventQueue.dequeue();
    const event3 = await eventQueue.dequeue();

    expect(event1.functions['a/b'].buildStatus).toBe('Building');
    expect(event2.functions['a/b'].buildStatus).toBe('Succeeded');
    expect(event3.functions['a/b'].buildStatus).toBe('Failed');

    eventSource.close();
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

    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () =>
        HttpResponse.text(sseFrame, { headers: { 'Content-Type': 'text/event-stream' } }),
      ),
    );

    const eventSource = createBuildStatusEventSource();
    const eventQueue = new AsyncQueue<{ functions: Record<string, unknown> }>();

    eventSource.addEventListener('build-status', (e) => {
      eventQueue.enqueue(JSON.parse(e.data));
    });

    const event = await eventQueue.dequeue();

    expect(Object.keys(event.functions).length).toBe(50);
    expect(event.functions['fn0/repo0']).toBeDefined();
    expect(event.functions['fn49/repo49']).toBeDefined();

    eventSource.close();
  });

  it('handles SSE frames split across multiple chunks, including split in delimiter', async () => {
    // Simulate frames arriving fragmented, with the split in the middle of '\n\n' delimiter
    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () => {
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
              // Small delay between chunks to simulate network jitter
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const eventSource = createBuildStatusEventSource();
    const eventQueue = new AsyncQueue<{ functions: Record<string, { buildStatus: string }> }>();

    eventSource.addEventListener('build-status', (e) => {
      eventQueue.enqueue(JSON.parse(e.data));
    });

    const event1 = await eventQueue.dequeue();
    const event2 = await eventQueue.dequeue();

    expect(event1.functions['a/b'].buildStatus).toBe('Building');
    expect(event2.functions['c/d'].buildStatus).toBe('Succeeded');

    eventSource.close();
  });

  it('passes timeout: 0 to prevent default ~60s timeout on long-lived stream', async () => {
    vi.useFakeTimers();

    const sseFrame =
      'event: build-status\ndata: {"functions":{"a/b":{"buildStatus":"Building"}}}\n\n';

    vi.mocked(consoleFetch).mockImplementation(
      (_url: string, _options?: RequestInit, timeout?: number) => {
        // Contract: timeout: 0 means no timeout, any other number means close after that duration
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

    const eventSource = createBuildStatusEventSource();

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

    eventSource.close();

    // Verify the stream succeeded (didn't timeout)
    expect(gotBuildStatus).toBe(true);
    expect(gotError).toBe(false);
  });
});

class AsyncQueue<T> {
  private queue: T[] = [];
  private waiters: ((value: T) => void)[] = [];

  enqueue(value: T): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(value);
    } else {
      this.queue.push(value);
    }
  }

  async dequeue(timeout = 500): Promise<T> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return Promise.race([
      new Promise<T>((resolve) => {
        this.waiters.push(resolve);
      }),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('AsyncQueue timeout')), timeout),
      ),
    ]);
  }
}
