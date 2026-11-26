export interface PlainEnvVar {
  name: string;
  value: string;
}

export interface ResourceEnvVar {
  name: string;
  resourceName: string;
  resourceKey: string;
}

export interface CreateFunctionFormData {
  owner: string;
  repo: string;
  branch: string;
  name: string;
  runtime: FunctionRuntime;
  registry: string;
  namespace: string;
  plainEnvVars: PlainEnvVar[];
  secretEnvVars: ResourceEnvVar[];
  configMapEnvVars: ResourceEnvVar[];
}

export type FunctionRuntime = 'node' | 'python' | 'go' | 'quarkus';
