import { HttpError } from '../errors';

interface SSEEventSourceOptions {
  fetchFn: (url: string, init: RequestInit, timeout: number) => Promise<Response>;
  headers?: HeadersInit;
  reconnectDelayMs?: number;
}

export interface SSEEventSource {
  addEventListener(type: 'open', cbk: () => void): void;
  addEventListener(type: 'error', cbk: (e: Error) => void): void;
  addEventListener(type: string, cbk: (e: SSEEvent) => void): void;
  close(): void;
}

export interface SSEEvent {
  readonly type: string;
  readonly data: string;
}

// createSSEEventSource is a custom implementation of the browser's EventSource
// API (https://developer.mozilla.org/en-US/docs/Web/API/EventSource). We cannot
// use native EventSource because it does not support custom headers or a custom
// fetch function, which we need to pass the SCM token and to use consoleFetch
// (the OpenShift Console SDK's fetch wrapper).
//
// Similarities with native EventSource:
// - addEventListener('open', ...) fires on successful connection.
// - addEventListener('<type>', ...) receives server-sent events by type.
// - close() tears down the connection.
// - Automatic reconnection with a delay on connection loss.
// - Heartbeat/comment frames (lines starting with ':') are ignored.
//
// Differences from native EventSource:
// - Accepts a custom fetchFn, headers, and reconnectDelayMs via options.
// - The 'error' listener receives an Error object (or HttpError with status
//   code) instead of a bare Event with no context. This is a deliberate
//   deviation: native EventSource hides the HTTP status on failure, but our
//   custom fetch gives us the Response, so we surface it. Consumers can
//   instanceof-check for HttpError to detect specific HTTP failures (e.g. 401).
// - The transport always reconnects, including on HTTP errors like 401/403.
//   The consumer is responsible for calling close() on terminal errors.
//
// Migration path to native EventSource:
// - Once the backend uses HTTP-only session cookies instead of PAT headers,
//   native EventSource can be used (no custom headers needed).
// - The 'error' listener would lose the HttpError context. Auth errors must
//   then be detected via 'app-error' events sent by the backend before the
//   connection closes. The backend already sends these.
// - The consumer API (addEventListener, close) stays the same.
export function createSSEEventSource(url: string, options: SSEEventSourceOptions): SSEEventSource {
  const eventListeners = new Map<string, Array<(e: SSEEvent) => void>>();
  const browserErrorListeners: Array<(e: Error) => void> = [];
  const openListeners: Array<() => void> = [];
  const controller = new AbortController();
  let isReceiving = true;

  run(); // Fire and forget; runs until close() is called

  return {
    addEventListener(type, cbk) {
      if (!isReceiving) return;

      switch (type) {
        case 'open':
          openListeners.push(cbk as () => void);
          break;
        case 'error':
          // 'error' event is fired by the browser if the connection fails
          // do not send error events to this subject
          browserErrorListeners.push(cbk as (e: Error) => void);
          break;
        default:
          if (eventListeners.has(type))
            eventListeners.get(type)?.push(cbk as (e: SSEEvent) => void);
          else eventListeners.set(type, [cbk as (e: SSEEvent) => void]);
          break;
      }
    },
    close() {
      isReceiving = false;
      controller.abort();
      eventListeners.clear();
      browserErrorListeners.length = 0;
      openListeners.length = 0;
    },
  };

  async function run() {
    while (isReceiving) {
      try {
        const res = await options.fetchFn(
          url,
          {
            headers: options.headers,
            signal: controller.signal,
          },
          0, // no timeout; the default ~60s would abort this long-lived stream
        );

        if (!res.ok) throw new HttpError(res.status, res.statusText);

        if (!res.body) continue;

        if (!isReceiving) return;
        openListeners.forEach((cbk) => {
          try {
            cbk();
          } catch (err) {
            console.error(err);
          }
        });

        for await (const event of readEventStream(res.body)) {
          if (!isReceiving) break;

          const listeners = eventListeners.get(event.type);
          if (listeners) notify(listeners, event);
        }
      } catch (err) {
        if (!isReceiving) return;

        const _err = err instanceof Error ? err : new Error(String(err) || 'Unknown error');

        notify(browserErrorListeners, _err);
      }

      if (isReceiving) await delay();
    }
  }

  function notify<T>(listeners: Array<(arg: T) => void>, arg: T) {
    if (!isReceiving) return;
    listeners.forEach((cbk) => {
      try {
        cbk(arg);
      } catch (err) {
        console.error(err);
      }
    });
  }

  function delay(): Promise<void> {
    return new Promise((resolve) => {
      if (controller.signal.aborted) return resolve();
      const onAbort = () => {
        clearTimeout(id);
        resolve();
      };
      const id = setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, options.reconnectDelayMs ?? 3000);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

async function* readEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for await (const value of body) {
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = deserializeFrame(frame);
        if (event) yield event;
      }
    }
  } finally {
    body.cancel().catch(() => {});
  }

  function deserializeFrame(frame: string): { type: string; data: string } | null {
    let event = '';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // heartbeat / comment
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (!event || dataLines.length === 0) return null;
    return { type: event, data: dataLines.join('\n') };
  }
}
