import { useEffect, useState } from 'react';
import { BuildStatus } from '../types';
import {
  BuildSnapshot,
  BuildStatusEventSource,
  createBuildStatusEventSource,
} from './functionsClient';

// useBuildStatus streams GitHub Actions build status over SSE, keyed by
// "owner/repo". Pass the auth connectionId so the stream tears down and
// reconnects with the current PAT on in-place login and account switch.
// If connectionId is undefined, no stream is created (unauthenticated).
export function useBuildStatus(
  connectionId?: number,
  eventSource?: BuildStatusEventSource,
): { statuses: Readonly<Record<string, BuildStatus>>; error?: string } {
  const [statuses, setStatuses] = useState<Record<string, BuildStatus>>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (connectionId === undefined) return;

    const es: BuildStatusEventSource = eventSource ?? createBuildStatusEventSource();

    es.addEventListener('build-status', (e) => {
      try {
        const snap = JSON.parse(e.data) as BuildSnapshot;
        setStatuses(snap.functions);
      } catch {
        setError('Invalid build status data');
      }
    });

    es.addEventListener('error', (e) => {
      setError(e.message);
    });

    es.addEventListener('open', () => {
      // clear the error on the re-connect
      setError(undefined);
    });

    return () => {
      es.close();
    };
  }, [eventSource, connectionId]);

  return { statuses, error };
}
