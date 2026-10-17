import { AppError } from './errors';

export const PAT_KEY = 'func-console-pat';
export const USER_KEY = 'func-console-user';
export const PROXY_BASE = '/api/proxy/plugin/console-functions-plugin/backend';

export const FUNCTION_NAME_LABEL = 'function.knative.dev/name';
export const REVISION_LABEL = 'serving.knative.dev/revision';

export interface FileEntry {
  path: string;
  mode: '100644' | '100755' | '120000';
  content: string;
  type: 'blob';
  deleted?: boolean;
}

export interface CreateFunctionRequest {
  name: string;
  runtime: string;
  registry: string;
  namespace: string;
  branch: string;
  owner: string;
  repo: string;
  envVars?: EnvVar[];
}

export interface EnvVar {
  name: string;
  source: 'value' | 'secret' | 'configMap';
  value: string;
  resourceName: string;
  resourceKey: string;
}

export interface AuthUser {
  name: string;
  avatarUrl: string;
}

export interface FunctionMetadata {
  owner: string;
  repoName: string;
  repoURL: string;
  defaultBranch: string;
  name: string;
  namespace: string;
  runtime: string;
  source: FunctionSource;
  err?: string;
}

export type FunctionSource = 'repo' | 'cluster';

/**
 * Record of workflow runs, keyed by repository full name (e.g., "owner/repo")
 */
export type WorkflowRunRecord = Record<string, WorkflowRun>;

export interface WorkflowRun {
  status: 'None' | 'Building' | 'Succeeded' | 'Failed';
  url?: string;
  error?: AppError;
}
