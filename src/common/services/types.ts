import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

export const PAT_KEY = 'func-console-pat';
export const USER_KEY = 'func-console-user';

export interface FileEntry {
  path: string;
  mode: '100644' | '100755' | '120000';
  content: string;
  type: 'blob';
}

export interface FunctionConfig {
  name: string;
  runtime: FunctionRuntime;
  registry: string;
  namespace: string;
  branch: string;
  envVars?: EnvVar[];
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

export interface RepoMetadata {
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
}

export interface ForgeUser {
  name: string;
}

export interface RepoSecret {
  name: string;
  value: string;
}

export type FunctionStatus =
  | 'CreatingRepo'
  | 'Pushing'
  | 'PushedToGitHub'
  | 'Deploying'
  | 'Running'
  | 'ScaledToZero'
  | 'Error'
  | 'Unknown'
  | 'NotDeployed';

export interface ClusterFunction {
  readonly name: string;
  readonly status: FunctionStatus;
  readonly url: string;
  readonly replicas: number;
  readonly mainResource: K8sResourceCommon;
}
