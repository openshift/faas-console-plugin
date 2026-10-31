import { isAllNamespacesKey } from '@openshift-console/dynamic-plugin-sdk';
import { AppError, HttpError } from '../errors';
import { customFetch, customFetchJSON } from './httpClient';
import { createSSEEventSource } from '../transport/sseEventSource';
import {
  CreateFunctionRequest,
  FileEntry,
  FunctionMetadata,
  PROXY_BASE,
  WorkflowRunRecord,
} from '../types';

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

  return customFetchJSON(`${PROXY_BASE}/api/v1/func/list${query}`);
}

export async function createFunction(data: CreateFunctionRequest): Promise<void> {
  await customFetch(`${PROXY_BASE}/api/v1/func/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function getFiles(owner: string, name: string, ref?: string): Promise<FileEntry[]> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return customFetchJSON(
    `${PROXY_BASE}/api/v1/func/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/files${query}`,
  );
}

export async function putFiles(
  owner: string,
  name: string,
  files: FileEntry[],
  message: string,
  branch: string,
): Promise<void> {
  await customFetch(
    `${PROXY_BASE}/api/v1/func/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/files`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, message, branch }),
    },
  );
}

/**
 * receiveWorkflowRunEvents opens an SSE connection to the workflow run watch endpoint
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
  const es = createSSEEventSource(`${PROXY_BASE}/api/v1/func/workflow-run/watch`, {
    fetchFn: customFetch,
  });

  es.addEventListener('workflow-run-status', (e) => {
    eventCbk(JSON.parse(e.data) as WorkflowRunRecord);
  });

  es.addEventListener('app-error', (e) => {
    const parsed = JSON.parse(e.data) as AppError;
    if (parsed.code === 401 || parsed.code === 403) {
      errorCbk('Authentication expired. Reconnect to GitHub and refresh.');
      es.close();
    } else errorCbk(parsed.message);
  });

  es.addEventListener('error', (e) => {
    if (e instanceof HttpError) errorCbk(`Server error (${e.status})`);
    else {
      const detail = e instanceof Error ? e.message : 'unknown error';
      errorCbk(`Connection to the server was lost: ${detail}. Reconnecting...`);
    }
  });

  return es.close;
}
