import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';
import { useEffect, useState } from 'react';
import { BuildStatus, PAT_KEY, PROXY_BASE } from '../types';

const RECONNECT_DELAY_MS = 3000;

interface BuildStatusItem {
  key: string;
  buildStatus: BuildStatus['buildStatus'];
  conclusion?: string;
  runURL?: string;
  failureReason?: string;
}

interface BuildSnapshot {
  functions: BuildStatusItem[];
}

// useBuildStatus streams per-function GitHub Actions build status over SSE and
// returns it keyed by "owner/repo". The backend scopes the stream to the
// authenticated user. Pass the auth connectionId so the stream tears down and
// reconnects (with the current PAT) on in-place login and account switch.
export function useBuildStatus(connectionId = 0): ReadonlyMap<string, BuildStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, BuildStatus>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function run() {
      while (!cancelled) {
        const pat = sessionStorage.getItem(PAT_KEY);
        if (!pat) return;
        try {
          const res = await consoleFetch(`${PROXY_BASE}/api/v1/func/build/watch`, {
            headers: { 'X-SCM-Token': pat },
            signal: controller.signal,
          });
          if (!res.body) return;
          await readStream(res.body, (snap) => {
            if (!cancelled) setStatuses(toMap(snap));
          });
        } catch (err) {
          if (cancelled) return;
          if (isAuthError(err)) {
            // A bad or expired PAT will not recover on retry, so stop the stream
            // instead of reconnecting in a tight loop. The console has no logger
            // utility, so we surface the diagnostic via console.error.
            console.error(
              'useBuildStatus: build status stream unauthorized, not reconnecting',
              err,
            );
            return;
          }
          // Transient stream/network error: log so it is not silent, then fall
          // through to the backoff-and-reconnect below.
          console.error('useBuildStatus: build status stream error, reconnecting', err);
        }
        // Stream ended or errored transiently; back off, then reconnect.
        await delay(RECONNECT_DELAY_MS, controller.signal);
      }
    }

    run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connectionId]);

  return statuses;
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  onSnapshot: (snap: BuildSnapshot) => void,
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
      const snap = parseFrame(frame);
      if (snap) onSnapshot(snap);
    }
  }
}

function parseFrame(frame: string): BuildSnapshot | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat / comment
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (event && event !== 'build-status') return null;
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as BuildSnapshot;
  } catch {
    return null;
  }
}

function toMap(snap: BuildSnapshot): ReadonlyMap<string, BuildStatus> {
  return new Map(
    (snap.functions ?? []).map((f) => [
      f.key,
      {
        buildStatus: f.buildStatus,
        conclusion: f.conclusion,
        runURL: f.runURL,
        failureReason: f.failureReason,
      },
    ]),
  );
}

// isAuthError reports whether a consoleFetch failure is a 401/403. consoleFetch
// throws an HttpError carrying the status on `code`; we also check `response.status`
// defensively without depending on the SDK error class at runtime.
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
