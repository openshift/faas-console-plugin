import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { ClusterError } from '../../common/errors';
import { FunctionSource, WorkflowRun } from '../../common/types';

export interface Function {
  readonly owner: string;
  readonly repoName: string;
  readonly runtime: string;
  readonly source: FunctionSource;
  readonly name: string;
  readonly namespace: string;
  readonly status: FunctionStatus;
  readonly routeURL: string;
  readonly replicas?: number;
  readonly mainResource?: K8sResourceCommon;
}

export interface FunctionStatus {
  cluster: ClusterStatus;
  workflow: WorkflowRun;
}

export interface ClusterStatus {
  status: 'NotDeployed' | 'Deploying' | 'Running' | 'ScaledToZero' | 'Undeploying' | 'Error';
  error?: ClusterError;
}
