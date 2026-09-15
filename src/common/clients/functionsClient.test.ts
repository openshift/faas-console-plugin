import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Prevent loading SDK components (which have .scss imports that fail in test env)
// but keep the exported functions by providing mocked implementations.
// consoleFetch will delegate to real fetch, which MSW can intercept.
vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: (url: string, options?: RequestInit) => fetch(url, options),
  consoleFetchJSON: vi.fn(),
  isAllNamespacesKey: vi.fn(),
}));

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createBuildStatusEventSource } from './functionsClient';

const server = setupServer();

describe('createBuildStatusEventSource', () => {
  beforeEach(() => {
    server.listen();
  });

  afterEach(() => {
    server.resetHandlers();
    server.close();
    vi.useRealTimers();
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
    const events: Array<{ functions: Record<string, { buildStatus: string }> }> = [];

    await new Promise<void>((resolve) => {
      eventSource.addEventListener('build-status', (e) => {
        events.push(JSON.parse(e.data));
        if (events.length === 1) resolve();
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0].functions['a/b'].buildStatus).toBe('Building');

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
    const events: Array<{ functions: Record<string, { buildStatus: string }> }> = [];

    await new Promise<void>((resolve) => {
      eventSource.addEventListener('build-status', (e) => {
        events.push(JSON.parse(e.data));
        if (events.length === 1) resolve();
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0].functions['a/b'].buildStatus).toBe('Succeeded');

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
    const events: Array<{ functions: Record<string, { buildStatus: string }> }> = [];

    await new Promise<void>((resolve) => {
      eventSource.addEventListener('build-status', (e) => {
        events.push(JSON.parse(e.data));
        if (events.length === 1) resolve();
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0].functions['x/y'].buildStatus).toBe('Failed');

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
    const errors: unknown[] = [];

    await new Promise<void>((resolve) => {
      eventSource.addEventListener('error', (e) => {
        errors.push(e);
        if (errors.length === 1) resolve();
      });

      // Give the error listener time to fire
      setTimeout(() => {
        if (errors.length === 0) resolve();
      }, 500);
    });

    eventSource.close();

    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not reconnect after 401 auth error', async () => {
    let callCount = 0;
    server.use(
      http.get('/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch', () => {
        callCount++;
        return new HttpResponse(null, { status: 401, statusText: 'Unauthorized' });
      }),
    );

    const eventSource = createBuildStatusEventSource();

    await new Promise<void>((resolve) => {
      eventSource.addEventListener('error', () => {
        resolve();
      });

      setTimeout(() => {
        resolve();
      }, 500);
    });

    eventSource.close();

    // Should only have called once, not retried
    expect(callCount).toBe(1);
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
    const errors: unknown[] = [];
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
    expect(errors.length).toBe(1);

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
    const events: Array<{ functions: Record<string, { buildStatus: string }> }> = [];

    await new Promise<void>((resolve) => {
      eventSource.addEventListener('build-status', (e) => {
        events.push(JSON.parse(e.data));
        if (events.length === 3) resolve();
      });

      setTimeout(() => {
        if (events.length < 3) resolve();
      }, 500);
    });

    expect(events).toHaveLength(3);
    expect(events[0].functions['a/b'].buildStatus).toBe('Building');
    expect(events[1].functions['a/b'].buildStatus).toBe('Succeeded');
    expect(events[2].functions['a/b'].buildStatus).toBe('Failed');

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
    const events: Array<{ functions: Record<string, unknown> }> = [];

    await new Promise<void>((resolve) => {
      eventSource.addEventListener('build-status', (e) => {
        events.push(JSON.parse(e.data));
        if (events.length === 1) resolve();
      });

      setTimeout(() => {
        if (events.length === 0) resolve();
      }, 500);
    });

    expect(events).toHaveLength(1);
    expect(Object.keys(events[0].functions).length).toBe(50);
    expect(events[0].functions['fn0/repo0']).toBeDefined();
    expect(events[0].functions['fn49/repo49']).toBeDefined();

    eventSource.close();
  });
});
