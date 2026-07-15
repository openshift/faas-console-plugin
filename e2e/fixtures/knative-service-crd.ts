export const KNATIVE_SERVICE_CRD = {
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: 'services.serving.knative.dev' },
  spec: {
    group: 'serving.knative.dev',
    names: {
      kind: 'Service',
      listKind: 'ServiceList',
      plural: 'services',
      singular: 'service',
      shortNames: ['ksvc'],
      categories: ['all', 'knative', 'serving'],
    },
    scope: 'Namespaced',
    versions: [
      {
        name: 'v1',
        served: true,
        storage: true,
        subresources: { status: {} },
        schema: {
          openAPIV3Schema: {
            type: 'object' as const,
            'x-kubernetes-preserve-unknown-fields': true,
          },
        },
      },
    ],
  },
};
