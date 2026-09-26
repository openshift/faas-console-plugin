import {
  consoleFetch,
  consoleFetchJSON,
  isAllNamespacesKey,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  BuildStatus,
  CreateFunctionRequest,
  FileEntry,
  FunctionListItem,
  PAT_KEY,
  PROXY_BASE,
} from '../types';

const RECONNECT_DELAY_MS = 3000;

export interface BuildStatusItem {
  buildStatus: BuildStatus['buildStatus'];
  conclusion?: string;
  runURL?: string;
}

export interface BuildSnapshot {
  // Keyed by "owner/repo", the identifier a function is correlated on.
  functions: Record<string, BuildStatusItem>;
}

export interface BuildSnapshotEvent {
  // JSON string containing a BuildSnapshot; parse with JSON.parse(data) as BuildSnapshot
  readonly data: string;
}

export interface BuildWatchErrorEvent {
  readonly message: string;
  readonly isAuthError: boolean;
}

// BuildStatusEventSource is a minimal subset of the standard EventSource interface we require.
export interface BuildStatusEventSource {
  addEventListener(_: 'build-status', cbk: (e: BuildSnapshotEvent) => void): void;
  addEventListener(_: 'error', cbk: (e: BuildWatchErrorEvent) => void): void;
  addEventListener(_: 'open', cbk: () => void): void;
  close(): void;
}

/**
 * listFunctions returns a list of function metadata.
 *
 * Test doubles for this function are in src/common/testing/functionsClientStub.ts
 *
 */
export async function listFunctions(namespace: string): Promise<FunctionListItem[]> {
  const query = isAllNamespacesKey(namespace)
    ? '?all=true'
    : `?namespace=${encodeURIComponent(namespace)}`;

  return consoleFetchJSON(`${PROXY_BASE}/api/v1/func/list${query}`, 'GET', {
    headers: scmHeaders(),
  });
}

function scmHeaders(): HeadersInit {
  const pat = sessionStorage.getItem(PAT_KEY);
  return pat ? { 'X-SCM-Token': pat } : {};
}

export async function createFunction(data: CreateFunctionRequest): Promise<void> {
  await consoleFetch(`${PROXY_BASE}/api/v1/func/create`, {
    method: 'POST',
    headers: { ...scmHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function getFiles(owner: string, name: string, ref?: string): Promise<FileEntry[]> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return consoleFetchJSON(
    `${PROXY_BASE}/api/v1/func/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/files${query}`,
    'GET',
    { headers: scmHeaders() },
  );
}

export async function putFiles(
  owner: string,
  name: string,
  files: FileEntry[],
  message: string,
  branch: string,
): Promise<void> {
  await consoleFetch(
    `${PROXY_BASE}/api/v1/func/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/files`,
    {
      method: 'PUT',
      headers: { ...scmHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, message, branch }),
    },
  );
}

// createBuildStatusEventSource returns a BuildStatusEventSource that manages the complete
// SSE stream lifecycle: fetch, parsing, event emission, error handling, and reconnection
// with fixed backoff. The stream runs fire-and-forget until close() is called.
// Auth errors (401/403) are terminal; transient errors reconnect after RECONNECT_DELAY_MS.
//
// Ideally we would use standard EventSource instead of our own implementation.
// The standard EventSource however does not support custom fetch function that we need.
export function createBuildStatusEventSource(): BuildStatusEventSource {
  const listeners: Array<(e: BuildSnapshotEvent) => void> = [];
  const errorListeners: Array<(e: BuildWatchErrorEvent) => void> = [];
  const openListeners: Array<() => void> = [];
  let streaming = true;
  const controller = new AbortController();

  async function run() {
    while (streaming) {
      try {
        const res = await connectBuildWatch(controller.signal);
        if (!res.body) continue;
        invokeListeners(openListeners, undefined, 'open');
        for await (const event of readEventStream(res.body)) {
          if (!streaming) break;
          switch (event.type) {
            case 'build-status':
              invokeListeners(listeners, { data: event.data }, 'build-status');
              break;
            case 'error':
              invokeListeners(errorListeners, { message: event.data, isAuthError: false }, 'error');
              break;
          }
        }
      } catch (err: unknown) {
        if (!streaming) return;
        const message = (err instanceof Error && err.message) || String(err) || 'Unknown error';
        invokeListeners(errorListeners, { message, isAuthError: isAuthError(err) }, 'error');
        if (isAuthError(err)) return;
      }
      if (streaming) {
        await delay(RECONNECT_DELAY_MS, controller.signal);
      }
    }
  }
  function invokeListeners<T>(listeners: Array<(arg: T) => void>, arg: T, label = 'listener') {
    if (!streaming) return;
    listeners.forEach((cbk) => {
      try {
        cbk(arg);
      } catch (err) {
        console.error(`BuildStatusEventSource ${label} listener error:`, err);
      }
    });
  }

  run(); // Fire and forget; runs until close() is called

  return {
    addEventListener(event: 'build-status' | 'error' | 'open', cbk) {
      if (!streaming) return;
      if (event === 'build-status') {
        listeners.push(cbk as (e: BuildSnapshotEvent) => void);
      } else if (event === 'error') {
        errorListeners.push(cbk as (e: BuildWatchErrorEvent) => void);
      } else if (event === 'open') {
        openListeners.push(cbk as () => void);
      }
    },
    close() {
      streaming = false;
      controller.abort();
      listeners.length = 0;
      errorListeners.length = 0;
      openListeners.length = 0;
    },
  };
}

async function connectBuildWatch(abortSignal: AbortSignal): Promise<Response> {
  const res = await consoleFetch(
    `${PROXY_BASE}/api/v1/func/build/watch`,
    {
      headers: scmHeaders(),
      signal: abortSignal,
    },
    0, // no timeout; the default ~60s would abort this long-lived stream
  );

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${res.statusText}`) as Error & {
      code?: number;
    };
    err.code = res.status;
    throw err;
  }

  return res;
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

function isAuthError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; response?: { status?: number } };
  const status = e.code ?? e.response?.status;
  return status === 401 || status === 403;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
