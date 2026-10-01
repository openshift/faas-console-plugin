import { isAllNamespacesKey } from '@openshift-console/dynamic-plugin-sdk';
import { sessionFetch, sessionFetchJSON } from './sessionClient';
import { CreateFunctionRequest, FileEntry, FunctionListItem, PROXY_BASE } from '../types';

export async function listFunctions(namespace: string): Promise<FunctionListItem[]> {
  const query = isAllNamespacesKey(namespace)
    ? '?all=true'
    : `?namespace=${encodeURIComponent(namespace)}`;

  return sessionFetchJSON(`${PROXY_BASE}/api/v1/func/list${query}`);
}

export async function createFunction(data: CreateFunctionRequest): Promise<void> {
  await sessionFetch(`${PROXY_BASE}/api/v1/func/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function getFiles(owner: string, name: string, ref?: string): Promise<FileEntry[]> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return sessionFetchJSON(
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
  await sessionFetch(
    `${PROXY_BASE}/api/v1/func/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/files`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files, message, branch }),
    },
  );
}
