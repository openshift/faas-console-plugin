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

// BuildStatusEventSource is a minimal subset of the standard EventSource interface we require.
export interface BuildStatusEventSource {
  addEventListener(_: 'build-status', cbk: (e: BuildSnapshotEvent) => void): void;
  addEventListener(_: 'error', cbk: (e: unknown) => void): void;
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
  const errorListeners: Array<(e: unknown) => void> = [];
  let cancelled = false;
  const controller = new AbortController();

  async function run() {
    while (!cancelled) {
      try {
        const res = await consoleFetch(
          `${PROXY_BASE}/api/v1/func/build/watch`,
          {
            headers: scmHeaders(),
            signal: controller.signal,
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

        if (res.body) {
          await readStream(res.body, (jsonString) => {
            if (!cancelled) {
              listeners.forEach((cbk) => {
                try {
                  cbk({ data: jsonString });
                } catch (err) {
                  console.error('BuildStatusEventSource listener error:', err);
                }
              });
            }
          });
        }
      } catch (err) {
        if (cancelled) return;
        errorListeners.forEach((cbk) => {
          try {
            cbk(err);
          } catch (listenerErr) {
            console.error('BuildStatusEventSource error listener threw:', listenerErr);
          }
        });
        if (isAuthError(err)) {
          console.error('BuildStatusEventSource: stream unauthorized, not reconnecting', err);
          return;
        }
        console.error('BuildStatusEventSource: stream error, reconnecting', err);
      }

      if (!cancelled) {
        await delay(RECONNECT_DELAY_MS, controller.signal);
      }
    }
  }

  run(); // Fire and forget; runs until cancelled

  return {
    addEventListener(
      event: 'build-status' | 'error',
      cbk: ((e: BuildSnapshotEvent) => void) | ((e: unknown) => void),
    ) {
      if (event === 'build-status') {
        listeners.push(cbk as (e: BuildSnapshotEvent) => void);
      } else if (event === 'error') {
        errorListeners.push(cbk as (e: unknown) => void);
      }
    },
    close() {
      cancelled = true;
      controller.abort();
    },
  };
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  onSnapshot: (jsonString: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const jsonString = parseFrame(frame);
      if (jsonString) onSnapshot(jsonString);
    }
  }
}

function parseFrame(frame: string): string | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat / comment
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (event !== 'build-status') return null;
  if (dataLines.length === 0) return null;
  const jsonString = dataLines.join('\n');
  try {
    JSON.parse(jsonString); // Validate it's valid JSON
    return jsonString;
  } catch {
    return null;
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
