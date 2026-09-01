// Test double for the SSE stream consumed by useBuildStatus.
// Mirrors the setFixtures pattern in useK8sWatchResourceStub.ts:
// a module-level fixture that tests set, and a stub function wired into
// the mocked consoleFetch.
//
// Each element of `frames` is enqueued as a separate ReadableStream chunk, so
// tests can split a single SSE frame across chunk boundaries to exercise the
// hook's cross-read buffering.

let frames: string[] = [];
let error: unknown = null;
let calls = 0;
let nullBodyCalls = 0;

export function setStreamFrames(newFrames: string[]) {
  frames = newFrames;
  error = null;
}

// setNullBodyForNext makes the next n consoleFetch calls resolve 2xx with a null
// body, simulating a body-less response the hook must recover from.
export function setNullBodyForNext(n: number) {
  nullBodyCalls = n;
}

// setStreamError makes the next consoleFetch reject, simulating an HTTP or
// network failure. Attach a `code` (HTTP status) to simulate an auth failure.
export function setStreamError(err: unknown) {
  error = err;
}

export function resetStreamFrames() {
  frames = [];
  error = null;
  calls = 0;
  nullBodyCalls = 0;
}

// streamFetchCalls reports how many times the stubbed consoleFetch was invoked,
// so tests can assert reconnect versus stop behaviour.
export function streamFetchCalls(): number {
  return calls;
}

// buildStatusFrame formats a single SSE build-status event.
export function buildStatusFrame(functions: unknown[]): string {
  return `event: build-status\ndata: ${JSON.stringify({ functions })}\n\n`;
}

// consoleFetchStub stands in for consoleFetch(url, options): it ignores its
// arguments and serves the configured frames (or error) as the response body.
export const consoleFetchStub = (): Promise<Response> => {
  calls++;
  if (error) return Promise.reject(error);
  if (nullBodyCalls > 0) {
    nullBodyCalls--;
    return Promise.resolve(new Response(null, { status: 200 }));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of frames) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return Promise.resolve(new Response(stream, { status: 200 }));
};
