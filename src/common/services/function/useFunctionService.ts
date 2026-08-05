import { consoleFetch, consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { useMemo } from 'react';
import { CreateFunctionRequest, FileEntry, FunctionListItem, PAT_KEY } from '../types';

const PROXY_BASE = '/api/proxy/plugin/console-functions-plugin/backend';

function scmHeaders(): HeadersInit {
  const pat = sessionStorage.getItem(PAT_KEY);
  return pat ? { 'X-SCM-Token': pat } : {};
}

interface FunctionService {
  listFunctions(): Promise<FunctionListItem[]>;
  createFunction(data: CreateFunctionRequest): Promise<void>;
  getFiles(owner: string, name: string, ref?: string): Promise<FileEntry[]>;
  putFiles(
    owner: string,
    name: string,
    files: FileEntry[],
    message: string,
    branch: string,
  ): Promise<void>;
}

export function useFunctionService(): FunctionService {
  return useMemo(
    () => ({
      async listFunctions(): Promise<FunctionListItem[]> {
        return consoleFetchJSON(`${PROXY_BASE}/api/v1/func/list`, 'GET', {
          headers: scmHeaders(),
        });
      },

      async createFunction(data: CreateFunctionRequest): Promise<void> {
        await consoleFetch(`${PROXY_BASE}/api/v1/func/create`, {
          method: 'POST',
          headers: { ...scmHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      },

      async getFiles(owner: string, name: string, ref?: string): Promise<FileEntry[]> {
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
        return consoleFetchJSON(
          `${PROXY_BASE}/api/v1/func/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/files${query}`,
          'GET',
          { headers: scmHeaders() },
        );
      },

      async putFiles(
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
      },
    }),
    [],
  );
}
