import { VitestUtils } from 'vitest';

export function timerFake(): {
  advance: (ms: number) => Promise<VitestUtils>;
  [Symbol.dispose](): void;
} {
  // shouldAdvanceTime lets real time advance in the background so React's
  // internal microtask/Promise processing keeps working. Without it, components
  // that use setTimeout (e.g. SSE reconnect delays) stall because Promise
  // resolution depends on timers in some environments.
  // See https://github.com/testing-library/react-testing-library/issues/1198
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return {
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    [Symbol.dispose]() {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    },
  };
}
