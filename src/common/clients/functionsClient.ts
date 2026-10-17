import {
  consoleFetch,
  consoleFetchJSON,
  isAllNamespacesKey,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  CreateFunctionRequest,
  FileEntry,
  FunctionMetadata,
  PAT_KEY,
  PROXY_BASE,
  WorkflowRunRecord,
} from '../types';
import { createSSEEventSource } from '../transport/sseEventSource';
import { AppError, HttpError } from '../errors';

/**
 * listFunctions returns a list of function metadata.
 *
 * Test doubles for this function are in src/common/testing/functionsClientStub.ts
 *
 */
export async function listFunctions(namespace: string): Promise<FunctionMetadata[]> {
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

/**
 * receiveWorkflowRunEvents opens an SSE connection to the build watch endpoint
 * and delivers workflow run updates via eventCbk. Errors (connection failures
 * and backend app-errors) are surfaced via errorCbk as a message string.
 *
 * Auth errors are handled internally: when the backend reports an auth failure
 * via an app-error event, the connection closes itself. The consumer is
 * notified via errorCbk but does not need to manage the connection lifecycle.
 *
 * Returns a close function to tear down the connection.
 */
export function receiveWorkflowRunEvents(
  eventCbk: (runs: WorkflowRunRecord) => void,
  errorCbk: (message: string) => void,
): () => void {
  const es = createSSEEventSource(`${PROXY_BASE}/api/v1/func/build/watch`, {
    headers: scmHeaders(),
    fetchFn: consoleFetch,
  });

  es.addEventListener('build-status', (e) => {
    eventCbk(JSON.parse(e.data) as WorkflowRunRecord);
  });

  es.addEventListener('app-error', (e) => {
    const parsed = JSON.parse(e.data) as AppError;
    if (parsed.code === 401) {
      errorCbk('Authentication expired. Reconnect to GitHub and refresh.');
      es.close();
    } else errorCbk(parsed.message);
  });

  es.addEventListener('error', (e) => {
    if (e instanceof HttpError) errorCbk(`Server error (${e.status})`);
    else {
      const detail = e instanceof Error ? e.message : String(e);
      errorCbk(`Connection to the server was lost: ${detail}. Reconnecting...`);
    }
  });

  return es.close;
}
