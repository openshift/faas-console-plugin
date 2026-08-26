import { consoleFetch, consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { CreateFunctionRequest, FileEntry, FunctionListItem, PAT_KEY, PROXY_BASE } from '../types';

function scmHeaders(): HeadersInit {
  const pat = sessionStorage.getItem(PAT_KEY);
  return pat ? { 'X-SCM-Token': pat } : {};
}

/**
 * listFunctions returns a list of function metadata.
 *
 * Test doubles for this function are in src/common/testing/functionsClientStub.ts
 *
 */
export async function listFunctions(): Promise<FunctionListItem[]> {
  return consoleFetchJSON(`${PROXY_BASE}/api/v1/func/list?all=true`, 'GET', {
    headers: scmHeaders(),
  });
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
