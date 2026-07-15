import { Page, Route } from '@playwright/test';

const MOCK_GENERATED_FILES = [
  {
    path: 'func.yaml',
    mode: '100644',
    content: 'name: new-fn\nruntime: node\nnamespace: e2e-ns\n',
    type: 'blob',
  },
  {
    path: 'index.js',
    mode: '100644',
    content: 'module.exports = async (context) => context;',
    type: 'blob',
  },
  {
    path: 'package.json',
    mode: '100644',
    content: '{"name":"new-fn","version":"1.0.0","main":"index.js"}',
    type: 'blob',
  },
];

const MOCK_KSVC = {
  apiVersion: 'serving.knative.dev/v1',
  kind: 'Service',
  metadata: {
    name: 'e2e-test-func',
    namespace: 'default',
    uid: 'mock-ksvc-uid',
    labels: { 'function.knative.dev/name': 'e2e-test-func' },
  },
  status: {
    url: 'https://e2e-test-func.default.example.com',
    latestReadyRevisionName: 'e2e-test-func-00001',
    conditions: [{ type: 'Ready', status: 'True' }],
  },
};

const MOCK_DEPLOYMENT = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'e2e-test-func-00001-deployment',
    namespace: 'default',
    uid: 'mock-deployment-uid',
    labels: {
      'function.knative.dev/name': 'e2e-test-func',
      'serving.knative.dev/revision': 'e2e-test-func-00001',
    },
  },
  spec: { replicas: 1 },
  status: { readyReplicas: 1 },
};

export async function mockDeployedFunction(page: Page): Promise<void> {
  await page.route('**/apis/serving.knative.dev/v1/services**', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          apiVersion: 'serving.knative.dev/v1',
          kind: 'ServiceList',
          metadata: { resourceVersion: '1000' },
          items: [MOCK_KSVC],
        },
      });
    }
    return route.continue();
  });

  await page.route('**/apis/apps/v1/deployments**', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          apiVersion: 'apps/v1',
          kind: 'DeploymentList',
          metadata: { resourceVersion: '1001' },
          items: [MOCK_DEPLOYMENT],
        },
      });
    }
    return route.continue();
  });

  await page.route('**/apis/serving.knative.dev/v1/namespaces/*/services/**', (route: Route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({
        json: { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Success' },
      });
    }
    return route.continue();
  });
}

const mockedPages = new WeakSet<Page>();

export async function mockClusterApis(page: Page): Promise<void> {
  if (mockedPages.has(page)) return;
  mockedPages.add(page);

  // Backend proxy: function scaffolding
  await page.route('**/api/proxy/**/api/function/create', (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ json: MOCK_GENERATED_FILES });
    }
    return route.continue();
  });

  // Backend proxy: cluster CA certificate
  await page.route('**/api/proxy/**/api/cluster/ca**', (route: Route) => {
    return route.fulfill({ json: { ca: null } });
  });

  // K8s: ServiceAccount token request (must come before generic serviceaccounts route)
  await page.route('**/api/kubernetes/**/serviceaccounts/func-github/token', (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        json: {
          kind: 'TokenRequest',
          status: { token: 'mock-sa-token', expirationTimestamp: '2027-01-01T00:00:00Z' },
        },
      });
    }
    return route.continue();
  });

  // K8s: ServiceAccount creation
  await page.route('**/api/kubernetes/**/serviceaccounts', (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        json: { kind: 'ServiceAccount', metadata: { name: 'func-github' } },
      });
    }
    return route.continue();
  });

  // K8s: Role creation
  await page.route('**/api/kubernetes/**/roles', (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        json: { kind: 'Role', metadata: { name: 'func-github-deployer' } },
      });
    }
    return route.continue();
  });

  // K8s: RoleBinding creation
  await page.route('**/api/kubernetes/**/rolebindings', (route: Route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        json: { kind: 'RoleBinding', metadata: { name: 'func-github-deployer' } },
      });
    }
    return route.continue();
  });
}
