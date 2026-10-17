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
