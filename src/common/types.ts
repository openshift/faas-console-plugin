import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

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

export type EnvVarSource = 'value' | 'secret' | 'configMap';

export interface EnvVar {
  name: string;
  source: EnvVarSource;
  value: string;
  resourceName: string;
  resourceKey: string;
}

export interface PlainEnvVar {
  name: string;
  value: string;
}

export interface ResourceEnvVar {
  name: string;
  resourceName: string;
  resourceKey: string;
}

export interface K8sKeyedResource {
  name: string;
  keys: string[];
}

export type FunctionRuntime = 'node' | 'python' | 'go' | 'quarkus';

export interface AuthUser {
  name: string;
  avatarUrl: string;
}

export type FunctionSource = 'repo' | 'cluster';

export interface FunctionListItem {
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

export type FunctionStatus =
  'Deploying' | 'Running' | 'ScaledToZero' | 'Error' | 'BuildFailed' | 'Unknown' | 'NotDeployed';

export interface ClusterFunction {
  readonly name: string;
  readonly namespace: string;
  readonly status: FunctionStatus;
  readonly url: string;
  readonly replicas: number;
  readonly mainResource: K8sResourceCommon;
}

export interface Function {
  readonly owner: string;
  readonly repoName: string;
  readonly runtime: string;
  readonly source: FunctionSource;
  readonly name: string;
  readonly namespace: string;
  readonly status: FunctionStatusV2;
  readonly repoURL: string;
  readonly routeURL: string;
  readonly replicas?: number;
  readonly mainResource?: K8sResourceCommon;
  readonly error?: Error;
}

export interface FunctionStatusV2 {
  cluster: ClusterStatus;
  workflow: WorkflowRun;
}

export interface ClusterStatus {
  status:
    'None' | 'NotDeployed' | 'Deploying' | 'Running' | 'ScaledToZero' | 'Undeploying' | 'Error';
  errorMessage?: string;
}

export interface WorkflowRun {
  status: 'None' | 'Building' | 'Succeeded' | 'Failed';
  url?: string;
  error?: string;
}

/**
 * Record of workflow runs, keyed by repository full name (e.g., "owner/repo")
 */
export type WorkflowRunRecord = Record<string, WorkflowRun>;
