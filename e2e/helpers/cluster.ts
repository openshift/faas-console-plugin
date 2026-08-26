import { Page, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants & API paths
// ---------------------------------------------------------------------------

const K8S = '/api/kubernetes';
const SUBSCRIPTION_NS = 'openshift-serverless';
const SERVING_NS = 'knative-serving';

export function ksvcApiPath(ns: string): string {
  return `${K8S}/apis/serving.knative.dev/v1/namespaces/${ns}/services`;
}

export function deploymentApiPath(ns: string): string {
  return `${K8S}/apis/apps/v1/namespaces/${ns}/deployments`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function getCSRFToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'csrf-token');
  return csrf?.value ?? '';
}

export async function k8sHeaders(page: Page): Promise<Record<string, string>> {
  return { 'X-CSRFToken': await getCSRFToken(page) };
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

export async function ensureNamespace(page: Page, name: string): Promise<void> {
  const headers = await k8sHeaders(page);
  const nsUrl = `${K8S}/api/v1/namespaces/${name}`;

  const check = await page.request.get(nsUrl, { headers });
  if (check.ok()) {
    const ns = await check.json();
    if (ns.status?.phase === 'Terminating') {
      await expect
        .poll(async () => (await page.request.get(nsUrl, { headers })).ok(), {
          timeout: 120_000,
          intervals: [2_000],
        })
        .toBe(false);
    } else {
      return;
    }
  }

  const res = await page.request.post(`${K8S}/api/v1/namespaces`, {
    headers,
    data: { apiVersion: 'v1', kind: 'Namespace', metadata: { name } },
  });
  expect(res.status()).toBe(201);
}

// ---------------------------------------------------------------------------
// Serverless operator
// ---------------------------------------------------------------------------

interface CsvItem {
  metadata: { name: string };
  status?: { phase: string };
}

function isServerlessReady(csv: CsvItem): boolean {
  return csv.metadata.name.startsWith('serverless-operator') && csv.status?.phase === 'Succeeded';
}

async function createResourceIfNotExists(
  page: Page,
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  const headers = await k8sHeaders(page);
  const res = await page.request.post(path, { headers, data });
  if (res.status() !== 201 && res.status() !== 409) {
    expect(res.status()).toBe(201);
  }
}

export async function ensureSecret(
  page: Page,
  namespace: string,
  name: string,
  data: Record<string, string>,
): Promise<void> {
  const encoded = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
  );
  await createResourceIfNotExists(page, `${K8S}/api/v1/namespaces/${namespace}/secrets`, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    data: encoded,
  });
}

export async function ensureConfigMap(
  page: Page,
  namespace: string,
  name: string,
  data: Record<string, string>,
): Promise<void> {
  await createResourceIfNotExists(page, `${K8S}/api/v1/namespaces/${namespace}/configmaps`, {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace },
    data,
  });
}

async function ensureServerlessOperator(page: Page): Promise<void> {
  const headers = await k8sHeaders(page);
  const csvPath = `${K8S}/apis/operators.coreos.com/v1alpha1/namespaces/${SUBSCRIPTION_NS}/clusterserviceversions`;

  const csvCheck = await page.request.get(csvPath, { headers });
  const csvReady =
    csvCheck.ok() && (await csvCheck.json()).items?.some((csv: CsvItem) => isServerlessReady(csv));

  if (!csvReady) {
    await ensureNamespace(page, SUBSCRIPTION_NS);

    await createResourceIfNotExists(
      page,
      `${K8S}/apis/operators.coreos.com/v1/namespaces/${SUBSCRIPTION_NS}/operatorgroups`,
      {
        apiVersion: 'operators.coreos.com/v1',
        kind: 'OperatorGroup',
        metadata: { name: 'serverless-operators', namespace: SUBSCRIPTION_NS },
      },
    );

    await createResourceIfNotExists(
      page,
      `${K8S}/apis/operators.coreos.com/v1alpha1/namespaces/${SUBSCRIPTION_NS}/subscriptions`,
      {
        apiVersion: 'operators.coreos.com/v1alpha1',
        kind: 'Subscription',
        metadata: { name: 'serverless-operator', namespace: SUBSCRIPTION_NS },
        spec: {
          channel: 'stable',
          name: 'serverless-operator',
          source: 'redhat-operators',
          sourceNamespace: 'openshift-marketplace',
          installPlanApproval: 'Automatic',
        },
      },
    );

    await expect
      .poll(
        async () => {
          const res = await page.request.get(csvPath, { headers });
          if (!res.ok()) return false;
          const body = await res.json();
          return body.items?.some((csv: CsvItem) => isServerlessReady(csv)) ?? false;
        },
        { timeout: 240_000, intervals: [2_000] },
      )
      .toBe(true);
  }

  await ensureNamespace(page, SERVING_NS);

  await createResourceIfNotExists(
    page,
    `${K8S}/apis/operator.knative.dev/v1beta1/namespaces/${SERVING_NS}/knativeservings`,
    {
      apiVersion: 'operator.knative.dev/v1beta1',
      kind: 'KnativeServing',
      metadata: { name: 'knative-serving', namespace: SERVING_NS },
    },
  );

  const ksvcCrdPath = `${K8S}/apis/apiextensions.k8s.io/v1/customresourcedefinitions/services.serving.knative.dev`;
  await expect
    .poll(async () => (await page.request.get(ksvcCrdPath, { headers })).ok(), {
      timeout: 120_000,
      intervals: [2_000],
    })
    .toBe(true);

  const webhookPath = `${K8S}/apis/apps/v1/namespaces/${SERVING_NS}/deployments/webhook`;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(webhookPath, { headers });
        if (!res.ok()) return 0;
        const body = await res.json();
        return body.status?.readyReplicas ?? 0;
      },
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

// Removes a deployed function's Knative service so it no longer appears in the
// cluster-sourced function list. Safe to call when the service is absent.
export async function deleteFunction(page: Page, name: string, namespace: string): Promise<void> {
  const headers = await k8sHeaders(page);
  const res = await page.request.delete(`${ksvcApiPath(namespace)}/${name}`, { headers });
  if (!res.ok() && res.status() !== 404) {
    expect(res.status()).toBe(200);
  }
}

// ---------------------------------------------------------------------------
// Deploy simulation
// ---------------------------------------------------------------------------

// Simulates what GitHub Actions CI would do: deploy the function as a
// Knative service, then patch the deployment label for the UI's K8s watch.
export async function simulateGitHubActionsDeploy(
  page: Page,
  name: string,
  namespace: string,
  runtime: string,
): Promise<void> {
  const headers = await k8sHeaders(page);
  const path = ksvcApiPath(namespace);

  const check = await page.request.get(`${path}/${name}`, { headers });
  if (!check.ok()) {
    await ensureServerlessOperator(page);

    const ksvc = {
      apiVersion: 'serving.knative.dev/v1',
      kind: 'Service',
      metadata: {
        name,
        namespace,
        labels: {
          'function.knative.dev/name': name,
          'function.knative.dev/runtime': runtime,
        },
      },
      spec: {
        template: {
          spec: {
            containers: [{ image: 'gcr.io/knative-samples/helloworld-go' }],
          },
        },
      },
    };

    const ksvcRes = await page.request.post(path, { data: ksvc, headers });
    expect(ksvcRes.status()).toBe(201);
  }

  // Knative doesn't propagate custom labels to deployments, so patch
  // the deployment with function.knative.dev/name for the UI's K8s watch.
  const depPath = deploymentApiPath(namespace);
  const depSelector = `${depPath}?labelSelector=serving.knative.dev/service=${name}`;

  await expect
    .poll(
      async () => {
        const probe = await page.request.get(depSelector, { headers });
        if (!probe.ok()) return 0;
        const body = await probe.json();
        return body.items?.length ?? 0;
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBeGreaterThan(0);

  const depList = await page.request.get(depSelector, { headers });
  const dep = (await depList.json()).items[0];
  const labels = dep.metadata.labels ?? {};
  if (!labels['function.knative.dev/name']) {
    await page.request.patch(`${depPath}/${dep.metadata.name}`, {
      headers: { ...headers, 'Content-Type': 'application/merge-patch+json' },
      data: { metadata: { labels: { 'function.knative.dev/name': name } } },
    });
  }
}
