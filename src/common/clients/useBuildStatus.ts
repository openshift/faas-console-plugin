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
export function useBuildStatus(
  connectionId = 0,
  eventSource?: BuildStatusEventSource,
): Readonly<Record<string, BuildStatus>> {
  const [statuses, setStatuses] = useState<Record<string, BuildStatus>>({});

  useEffect(() => {
    const es = eventSource ?? createBuildStatusEventSource();

    es.addEventListener('build-status', (e) => {
      const snap = JSON.parse(e.data) as BuildSnapshot;
      setStatuses(snap.functions);
    });

    return () => {
      es.close();
    };
  }, [eventSource, connectionId]);

  return statuses;
}
