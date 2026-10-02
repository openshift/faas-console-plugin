import { http, HttpResponse } from 'msw';
import { server } from '../testing/mswServer';
import { AsyncQueue } from '../utils/AsyncQueue';
import { HttpError } from '../errors';
import { createSSEEventSource, SSEEventSource, SSEEvent } from './sseEventSource';

describe('createSSEEventSource', () => {
  const TEST_URL =
    'http://localhost/api/proxy/plugin/console-functions-plugin/backend/api/v1/func/build/watch';

  afterEach(() => {
    vi.useRealTimers();
    server.resetHandlers();
  });

  describe('SSE frame parsing', () => {
    it.each<{
      description: string;
      frames: string;
      expectedData: string;
    }>([
      {
        description: 'emits parsed events from SSE stream',
        frames: 'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n',
        expectedData: '{"a/b":{"status":"Building"}}',
      },
      {
        description: 'ignores frames without matching event name',
        frames:
          'event: message\ndata: {"ignored":"data"}}\n\n' +
          'event: build-status\ndata: {"a/b":{"status":"Succeeded"}}\n\n',
        expectedData: '{"a/b":{"status":"Succeeded"}}',
      },
      {
        description: 'ignores a frame with no event name',
        frames:
          'data: {"irrelevant":"not a named event"}\n\n' +
          'event: build-status\ndata: {"c/d":{"status":"Succeeded"}}\n\n',
        expectedData: '{"c/d":{"status":"Succeeded"}}',
      },
      {
        description: 'handles heartbeat comment frames',
        frames: ':\n\nevent: build-status\ndata: {"x/y":{"status":"Failed"}}\n\n',
        expectedData: '{"x/y":{"status":"Failed"}}',
      },
    ])('$description', async ({ frames, expectedData }) => {
      useStaticEventStream(frames);

      using es = createEventSource();
      using events = captureEvents(es, 'build-status');

      const data = await events.dequeue();
      expect(data).toBe(expectedData);
    });

    it('passes through app-error as a generic event', async () => {
      useStaticEventStream(
        'event: app-error\ndata: {"message":"github API rate limited","isAuthError":false}\n\n',
      );

      using es = createEventSource();
      using events = captureEvents(es, 'app-error');

      const data = await events.dequeue();
      expect(data).toBe('{"message":"github API rate limited","isAuthError":false}');
    });

    it('handles multiple sequential events', async () => {
      useStaticEventStream(
        'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n' +
          'event: build-status\ndata: {"a/b":{"status":"Succeeded"}}\n\n' +
          'event: build-status\ndata: {"a/b":{"status":"Failed"}}\n\n',
      );

      using es = createEventSource();
      using events = captureEvents(es, 'build-status');

      expect(await events.dequeue()).toBe('{"a/b":{"status":"Building"}}');
      expect(await events.dequeue()).toBe('{"a/b":{"status":"Succeeded"}}');
      expect(await events.dequeue()).toBe('{"a/b":{"status":"Failed"}}');
    });

    it('handles large payload in single frame', async () => {
      const largePayload = Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [
          `fn${i}/repo${i}`,
          { status: 'Building', url: `http://example.com/${i}` },
        ]),
      );
      const sseFrame = `event: build-status\ndata: ${JSON.stringify(largePayload)}\n\n`;
      useStaticEventStream(sseFrame);

      using es = createEventSource();
      using events = captureEvents(es, 'build-status');

      const data = await events.dequeue();
      const parsed = JSON.parse(data);
      expect(Object.keys(parsed).length).toBe(50);
      expect(parsed['fn0/repo0']).toBeDefined();
      expect(parsed['fn49/repo49']).toBeDefined();
    });

    it('handles SSE frames split across multiple chunks, including split in delimiter', async () => {
      server.use(
        http.get(TEST_URL, () => {
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

      using es = createEventSource();
      using events = captureEvents(es, 'build-status');

      expect(await events.dequeue()).toBe('{"a/b":{"status":"Building"}}');
      expect(await events.dequeue()).toBe('{"c/d":{"status":"Succeeded"}}');
    });
  });

  describe('connection lifecycle', () => {
    it('emits open event on successful connection', async () => {
      server.use(
        http.get(TEST_URL, () => {
          const stream = new ReadableStream<Uint8Array>({ start() {} });
          return new Response(stream, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }),
      );

      using es = createEventSource();
      using openQueue = new AsyncQueue<void>();
      es.addEventListener('open', () => openQueue.enqueue(undefined));

      await expect(openQueue.dequeue()).resolves.toBeUndefined();
    });

    it('emits HttpError with status code on non-ok response', async () => {
      server.use(
        http.get(
          TEST_URL,
          () => new HttpResponse(null, { status: 401, statusText: 'Unauthorized' }),
        ),
      );

      using es = createEventSource();
      using errors = captureErrors(es);

      const error = await errors.dequeue();
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(401);
    });

    it('reconnects on transient 5xx errors', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      server.use(
        http.get(TEST_URL, () => {
          callCount++;
          if (callCount === 1) {
            return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
          }
          return HttpResponse.text('event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }),
      );

      using es = createEventSource();
      using errors = captureErrors(es);
      using events = captureEvents(es, 'build-status');

      const error = await errors.dequeue();
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(500);

      await vi.advanceTimersByTimeAsync(3100);

      expect(await events.dequeue()).toBe('{"a/b":{"status":"Building"}}');
    });

    it('reconnects after 401 (transport always reconnects, consumer decides)', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      server.use(
        http.get(TEST_URL, () => {
          callCount++;
          if (callCount === 1) {
            return new HttpResponse(null, { status: 401, statusText: 'Unauthorized' });
          }
          return HttpResponse.text('event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }),
      );

      using es = createEventSource();
      using errors = captureErrors(es);
      using events = captureEvents(es, 'build-status');

      const error = await errors.dequeue();
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(401);

      await vi.advanceTimersByTimeAsync(3100);

      expect(await events.dequeue()).toBe('{"a/b":{"status":"Building"}}');
    });

    it('reconnects when response has no body', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      server.use(
        http.get(TEST_URL, () => {
          callCount++;
          if (callCount === 1) {
            return new HttpResponse(null, { status: 200 });
          }
          return HttpResponse.text(
            'event: build-status\ndata: {"c/d":{"status":"Succeeded"}}\n\n',
            {
              headers: { 'Content-Type': 'text/event-stream' },
            },
          );
        }),
      );

      using es = createEventSource();
      using events = captureEvents(es, 'build-status');

      await vi.advanceTimersByTimeAsync(3100);

      expect(await events.dequeue()).toBe('{"c/d":{"status":"Succeeded"}}');
    });
  });

  describe('listener resilience', () => {
    it('continues streaming when a listener throws', async () => {
      useStaticEventStream(
        'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n' +
          'event: build-status\ndata: {"a/b":{"status":"Succeeded"}}\n\n',
      );

      vi.spyOn(console, 'error').mockImplementation(() => {});

      using es = createEventSource();

      es.addEventListener('build-status', () => {
        throw new Error('listener boom');
      });

      using events = captureEvents(es, 'build-status');

      expect(await events.dequeue()).toBe('{"a/b":{"status":"Building"}}');
      expect(await events.dequeue()).toBe('{"a/b":{"status":"Succeeded"}}');
    });
  });

  describe('close', () => {
    it('stops receiving events after close() is called', async () => {
      vi.useFakeTimers();

      using frameQueue = new AsyncQueue<string>();

      server.use(
        http.get(TEST_URL, () => {
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

      using es = createEventSource();
      let received = false;
      es.addEventListener('build-status', () => {
        received = true;
      });

      es.close();

      frameQueue.enqueue('event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n');

      await vi.advanceTimersByTimeAsync(100);
      expect(received).toBe(false);
    });
  });

  describe('timeout', () => {
    it('passes timeout 0 to fetchFn to prevent default timeout on long-lived stream', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const sseFrame = 'event: build-status\ndata: {"a/b":{"status":"Building"}}\n\n';
      const mockFetchFn = vi.fn(
        (_url: string, _init: RequestInit, timeout: number): Promise<Response> => {
          const effectiveTimeout = timeout === 0 ? undefined : (timeout ?? 60_000);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(sseFrame));
              if (effectiveTimeout) {
                setTimeout(() => controller.error(new Error('Request timeout')), effectiveTimeout);
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

      const source = createSSEEventSource(TEST_URL, { fetchFn: mockFetchFn });
      using es = Object.assign(source, {
        [Symbol.dispose]() {
          source.close();
        },
      });

      using events = captureEvents(es, 'build-status');
      let errorReceived = false;
      es.addEventListener('error', () => {
        errorReceived = true;
      });

      // The event should arrive immediately
      expect(await events.dequeue()).toBe('{"a/b":{"status":"Building"}}');

      // Advance past the 60s default timeout. If timeout 0 wasn't passed,
      // the stream would error here.
      await vi.advanceTimersByTimeAsync(65_000);

      expect(errorReceived).toBe(false);
    });
  });

  // --- Helpers ---

  function createEventSource(
    url: string = TEST_URL,
    opts?: { reconnectDelayMs?: number },
  ): SSEEventSource & Disposable {
    const source = createSSEEventSource(url, {
      fetchFn: (u, init) => fetch(u, init),
      ...opts,
    });
    return Object.assign(source, {
      [Symbol.dispose]() {
        source.close();
      },
    });
  }

  function captureEvents(es: SSEEventSource, type: string): AsyncQueue<string> & Disposable {
    const queue = new AsyncQueue<string>();
    es.addEventListener(type, (e: SSEEvent) => queue.enqueue(e.data));
    return queue;
  }

  function captureErrors(es: SSEEventSource): AsyncQueue<Error> & Disposable {
    const queue = new AsyncQueue<Error>();
    es.addEventListener('error', (e: Error) => queue.enqueue(e));
    return queue;
  }

  function useStaticEventStream(frames: string) {
    server.use(
      http.get(TEST_URL, () =>
        HttpResponse.text(frames, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
  }
});
