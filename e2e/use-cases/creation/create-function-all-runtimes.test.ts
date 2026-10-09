import { test, expect } from '../../fixtures/authenticated-page';
import { Request } from '@playwright/test';
import { navigateToCreatePage } from '../../helpers/navigation';
import { deleteFunction, ensureNamespace } from '../../helpers/cluster';
import { deleteRepoOnFakeGithub, waitForWorkflowRun } from '../../helpers/fakegithub';
import { E2E_USER } from '../../helpers/constants';

const BRANCH = 'main';
const REGISTRY_PREFIX = 'image-registry.openshift-image-registry.svc:5000/';

interface RuntimeCase {
  runtime: string;
  funcName: string;
  namespace: string;
}

const RUNTIMES: RuntimeCase[] = [
  { runtime: 'node', funcName: 'rt-node', namespace: 'rt-node-test' },
  { runtime: 'python', funcName: 'rt-python', namespace: 'rt-python-test' },
  { runtime: 'quarkus', funcName: 'rt-quarkus', namespace: 'rt-quarkus-test' },
  { runtime: 'go', funcName: 'rt-go', namespace: 'rt-go-test' },
];

for (const { runtime, funcName, namespace } of RUNTIMES) {
  test.describe(`Create ${runtime} function`, () => {
    test.afterEach(async ({ page }) => {
      await deleteFunction(page, funcName, namespace);
      await deleteRepoOnFakeGithub(E2E_USER, funcName);
    });

    test(`user creates a ${runtime} function and it deploys successfully`, async ({ page }) => {
      test.setTimeout(600_000);

      const createRequests: Request[] = [];
      page.on('request', (req) => {
        if (req.url().includes('/api/v1/func/create') && req.method() === 'POST') {
          createRequests.push(req);
        }
      });

      await test.step('ensure namespace exists', async () => {
        await ensureNamespace(page, namespace);
      });

      await test.step('navigate to the create page', async () => {
        await navigateToCreatePage(page);
        await expect(page).toHaveURL(/\/faas\/create/);
      });

      await test.step('verify all form fields are present', async () => {
        await expect(page.locator('#owner')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#repo')).toBeVisible();
        await expect(page.locator('#branch')).toBeVisible();
        await expect(page.locator('#name')).toBeVisible();
        await expect(page.locator('#runtime')).toBeVisible();
        await expect(page.locator('#registry')).toBeVisible();
        await expect(page.locator('#namespace')).toBeVisible();
      });

      await test.step('verify submit button is disabled with empty form', async () => {
        const submitBtn = page.getByRole('button', { name: 'Create', exact: true });
        await expect(submitBtn).toBeVisible();
        await expect(submitBtn).toBeDisabled();
      });

      await test.step('verify owner is auto-populated and disabled', async () => {
        const owner = page.locator('#owner');
        await expect(owner).not.toHaveValue('');
        await expect(owner).toBeDisabled();
      });

      await test.step('fill in function details', async () => {
        await page.locator('#repo').fill(funcName);
        await page.locator('#branch').fill(BRANCH);
        await page.locator('#name').fill(funcName);
        await page.locator('#runtime').selectOption(runtime);
        await page.locator('#namespace').fill(namespace);
      });

      await test.step('verify registry is auto-populated from namespace', async () => {
        const registry = page.locator('#registry');
        await expect(registry).toHaveValue(`${REGISTRY_PREFIX}${namespace}`);
        await expect(registry).toBeDisabled();
      });

      await test.step('verify submit button is enabled after filling all fields', async () => {
        await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
      });

      await test.step('submit and verify redirect to overview', async () => {
        await page.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(page).toHaveURL(/\/faas$/, { timeout: 30_000 });
      });

      await test.step('verify function creation request was made', async () => {
        expect(createRequests).toHaveLength(1);
      });

      await test.step('wait for GitHub Actions workflow to deploy the function', async () => {
        const { conclusion, logUrl } = await waitForWorkflowRun('e2e-user', funcName);
        if (conclusion !== 'success') {
          const log = await fetch(logUrl);
          const logBody = await log.text();
          await test.info().attach('workflow-log', { body: logBody, contentType: 'text/plain' });
        }
        expect(conclusion).toBe('success');
      });

      await test.step('verify function shows as deployed in the UI', async () => {
        const grid = page.getByRole('grid', { name: 'Functions' });
        await expect(grid).toBeVisible({ timeout: 30_000 });

        const row = grid.locator(`tbody tr:has(td:text-is("${funcName}"))`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByText(/Running|ScaledToZero/)).toBeVisible({ timeout: 300_000 });
        await expect(row.locator('td[data-label="Runtime"]')).toHaveText(runtime);
      });

      await test.step('invoke the deployed function via its URL', async () => {
        const grid = page.getByRole('grid', { name: 'Functions' });
        const row = grid.locator(`tbody tr:has(td:text-is("${funcName}"))`);
        const urlLink = row.locator('td[data-label="URL"] a');
        await expect(urlLink).toBeVisible({ timeout: 30_000 });
        const href = await urlLink.getAttribute('href');
        expect(href).toBeTruthy();
        const resp = await page.request.get(href!);
        expect(resp.status()).toBe(200);
      });
    });
  });
}
