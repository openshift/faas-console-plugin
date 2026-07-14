import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { FunctionStatus } from '../types';

export interface ClusterFunction {
  readonly name: string;
  readonly status: FunctionStatus;
  readonly url: string | undefined;
  readonly replicas: number;
  readonly mainResource: K8sResourceCommon;
}
