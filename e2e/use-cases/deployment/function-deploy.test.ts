import { test, expect, Page } from '@playwright/test';
import { dismissDialogs, navigateToFunctionsList, waitForLoadingComplete } from '../../helpers';
import { KNATIVE_SERVICE_CRD } from '../../fixtures/knative-service-crd';

const KSVC_NAME = 'e2e-test-func';
const NAMESPACE = 'default';
const KSVC_API_PATH = `/api/kubernetes/apis/serving.knative.dev/v1/namespaces/${NAMESPACE}/services`;
const CRD_API_PATH = '/api/kubernetes/apis/apiextensions.k8s.io/v1/customresourcedefinitions';

async function getCSRFToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'csrf-token');
  return csrf?.value ?? '';
}

async function k8sHeaders(page: Page): Promise<Record<string, string>> {
  return { 'X-CSRFToken': await getCSRFToken(page) };
}

async function ensureKnativeCrd(page: Page): Promise<void> {
  const headers = await k8sHeaders(page);
  const check = await page.request.get(`${CRD_API_PATH}/${KNATIVE_SERVICE_CRD.metadata.name}`, {
    headers,
  });
  if (check.ok()) return;

  const res = await page.request.post(CRD_API_PATH, {
    data: KNATIVE_SERVICE_CRD,
    headers,
  });
  expect(res.status()).toBe(201);

  // Wait for the API to become available
  for (let i = 0; i < 10; i++) {
    const probe = await page.request.get(KSVC_API_PATH, { headers });
    if (probe.ok()) return;
    await page.waitForTimeout(500);
  }
}

const DEPLOY_API_PATH = `/api/kubernetes/apis/apps/v1/namespaces/${NAMESPACE}/deployments`;
const DEPLOY_NAME = `${KSVC_NAME}-00001-deployment`;

async function deleteTestResources(page: Page): Promise<void> {
  const headers = await k8sHeaders(page);
  await page.request.delete(`${KSVC_API_PATH}/${KSVC_NAME}`, { headers }).catch(() => {});
  await page.request.delete(`${DEPLOY_API_PATH}/${DEPLOY_NAME}`, { headers }).catch(() => {});
}

async function createTestResources(page: Page): Promise<void> {
  const headers = await k8sHeaders(page);
  await deleteTestResources(page);

  const ksvc = {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: KSVC_NAME,
      namespace: NAMESPACE,
      labels: { 'function.knative.dev/name': KSVC_NAME },
    },
    spec: {
      template: {
        spec: {
          containers: [{ image: 'gcr.io/knative-samples/helloworld-go' }],
        },
      },
    },
  };

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: DEPLOY_NAME,
      namespace: NAMESPACE,
      labels: { 'function.knative.dev/name': KSVC_NAME },
    },
    spec: {
      replicas: 0,
      selector: { matchLabels: { app: KSVC_NAME } },
      template: {
        metadata: { labels: { app: KSVC_NAME } },
        spec: {
          containers: [{ name: 'user-container', image: 'gcr.io/knative-samples/helloworld-go' }],
        },
      },
    },
  };

  const ksvcRes = await page.request.post(KSVC_API_PATH, { data: ksvc, headers });
  expect(ksvcRes.status()).toBe(201);

  const depRes = await page.request.post(DEPLOY_API_PATH, { data: deployment, headers });
  expect(depRes.status()).toBe(201);
}

test.describe('Deploy and undeploy function', () => {
  test.afterEach(async ({ page }) => {
    await deleteTestResources(page);
  });

  test('delete button is disabled for undeployed functions', async ({ page }) => {
    await navigateToFunctionsList(page);

    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });
    const firstRow = grid.locator('tbody tr').first();

    await expect(firstRow.getByText('NotDeployed')).toBeVisible();
    await expect(firstRow.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  test('deployed function shows in the list', async ({ page }) => {
    test.skip(!!process.env.BRIDGE_GITHUB_PAT, 'uses mock GitHub repos');
    await navigateToFunctionsList(page);

    await ensureKnativeCrd(page);
    await createTestResources(page);
    await page.reload({ waitUntil: 'networkidle' });
    await dismissDialogs(page);
    await waitForLoadingComplete(page);

    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    const row = grid.locator('tbody tr').filter({ hasText: KSVC_NAME });
    await expect(row.getByText('NotDeployed')).not.toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole('button', { name: 'Delete' })).toBeEnabled({ timeout: 10_000 });
  });

  test('undeploy removes function from cluster', async ({ page }) => {
    test.skip(!!process.env.BRIDGE_GITHUB_PAT, 'uses mock GitHub repos');
    await navigateToFunctionsList(page);

    await ensureKnativeCrd(page);
    await createTestResources(page);
    await page.reload({ waitUntil: 'networkidle' });
    await dismissDialogs(page);
    await waitForLoadingComplete(page);

    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    const row = grid.locator('tbody tr').filter({ hasText: KSVC_NAME });
    const undeployBtn = row.getByRole('button', { name: 'Delete' });
    await expect(undeployBtn).toBeEnabled({ timeout: 10_000 });
    await undeployBtn.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await modal.getByRole('button', { name: /undeploy/i }).click();

    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('NotDeployed')).toBeVisible({ timeout: 30_000 });
  });
});
