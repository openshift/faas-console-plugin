import { K8sResourceKind, WatchK8sResource } from '@openshift-console/dynamic-plugin-sdk';
import { FUNCTION_NAME_LABEL, REVISION_LABEL } from '../types';

type Fixtures = {
  knSvcs: K8sResourceKind[];
  deps: K8sResourceKind[];
  secrets?: K8sResourceKind[];
  configMaps?: K8sResourceKind[];
  knLoaded?: boolean;
  depLoaded?: boolean;
  secretLoaded?: boolean;
  cmLoaded?: boolean;
  knError?: Error;
  depError?: Error;
  secretError?: Error;
  cmError?: Error;
};

const fixtures: Fixtures = {
  knSvcs: [],
  deps: [],
  knLoaded: true,
  depLoaded: true,
  secretLoaded: true,
  cmLoaded: true,
};

export function setFixtures(opts: Partial<Fixtures>) {
  fixtures.knSvcs = opts.knSvcs ?? [];
  fixtures.deps = opts.deps ?? [];
  fixtures.secrets = opts.secrets ?? [];
  fixtures.configMaps = opts.configMaps ?? [];
  fixtures.knLoaded = opts.knLoaded ?? true;
  fixtures.depLoaded = opts.depLoaded ?? true;
  fixtures.secretLoaded = opts.secretLoaded ?? true;
  fixtures.cmLoaded = opts.cmLoaded ?? true;
  fixtures.knError = opts.knError;
  fixtures.depError = opts.depError;
  fixtures.secretError = opts.secretError;
  fixtures.cmError = opts.cmError;
}

export function funcFixture(name: string): Partial<Fixtures> {
  return {
    knSvcs: [ksvcFixture(name, 'True')],
    deps: [deploymentFixture(name, 1, 1)],
  };
}

export function ksvcFixture(
  name: string,
  readyStatus: string,
  url = `https://${name}-demo.apps.example.com`,
  revision = `${name}-00001`,
): K8sResourceKind {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: 'demo',
      labels: { [FUNCTION_NAME_LABEL]: name },
    },
    status: {
      url,
      latestReadyRevisionName: revision,
      conditions: [{ type: 'Ready', status: readyStatus }],
    },
  };
}

export function deploymentFixture(
  name: string,
  specReplicas: number,
  readyReplicas: number,
  revision = `${name}-00001`,
): K8sResourceKind {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: `${revision}-deployment`,
      namespace: 'demo',
      labels: {
        [FUNCTION_NAME_LABEL]: name,
        [REVISION_LABEL]: revision,
      },
    },
    spec: { replicas: specReplicas },
    status: { readyReplicas },
  };
}

export function secretFixture(
  name: string,
  data: {
    [key: string]: string;
  },
  namespace = 'demo',
): K8sResourceKind {
  return configFixture(name, namespace, data, 'Secret');
}

function configFixture(
  name: string,
  namespace: string,
  data: {
    [key: string]: string;
  },
  kind: 'Secret' | 'ConfigMap',
): K8sResourceKind {
  return {
    apiVersion: 'v1',
    kind,
    metadata: {
      name,
      namespace,
    },
    data,
  };
}

export function configMapFixture(
  name: string,
  data: {
    [key: string]: string;
  },
  namespace = 'demo',
): K8sResourceKind {
  return configFixture(name, namespace, data, 'ConfigMap');
}

export const useK8sWatchResourceStub = (config: WatchK8sResource) => {
  if (!config) return [[], true, null];

  const { group, kind } = config.groupVersionKind ?? {};

  if (group === 'serving.knative.dev' && kind === 'Service')
    return [filterBySelector(fixtures.knSvcs, config), fixtures.knLoaded, fixtures.knError];

  if (group === 'apps' && kind === 'Deployment')
    return [filterBySelector(fixtures.deps, config), fixtures.depLoaded, fixtures.depError];

  if (!group && kind === 'Secret')
    return [fixtures.secrets, fixtures.secretLoaded, fixtures.secretError];

  if (!group && kind === 'ConfigMap')
    return [fixtures.configMaps, fixtures.cmLoaded, fixtures.cmError];

  return [[], true, null];

  function filterBySelector(items: K8sResourceKind[], config: WatchK8sResource): K8sResourceKind[] {
    const expr = config?.selector?.matchExpressions?.find(
      (e) => e.key === FUNCTION_NAME_LABEL && e.operator === 'In',
    );

    if (!expr) return items;

    return items.filter((item) => {
      const name = item.metadata?.labels?.[FUNCTION_NAME_LABEL];
      return name != null && expr.values?.includes(name);
    });
  }
};
