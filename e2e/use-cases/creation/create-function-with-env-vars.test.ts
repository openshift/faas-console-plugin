import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToCreatePage } from '../../helpers/navigation';
import { ensureConfigMap, ensureNamespace, ensureSecret } from '../../helpers/cluster';
import { fakeGithubUrl } from '../../helpers/fakegithub';

const FUNC_NAME = 'env-var-func';
const NAMESPACE = 'env-var-test';
const BRANCH = 'main';

const SECRET_NAME = 'my-db-secret';
const SECRET_KEY = 'DB_PASSWORD';
const SECRET2_NAME = 'my-api-secret';
const SECRET2_KEY = 'API_TOKEN';

const CONFIGMAP_NAME = 'my-app-config';
const CONFIGMAP_KEY = 'APP_MODE';

test.describe('Create function with environment variables', () => {
  test('user creates a function with plain, Secret, and ConfigMap env vars', async ({ page }) => {
    test.setTimeout(600_000);

    await test.step('ensure namespace with Secret and ConfigMap', async () => {
      await ensureNamespace(page, NAMESPACE);
      await ensureSecret(page, NAMESPACE, SECRET_NAME, { [SECRET_KEY]: 's3cret' });
      await ensureSecret(page, NAMESPACE, SECRET2_NAME, { [SECRET2_KEY]: 'tok3n' });
      await ensureConfigMap(page, NAMESPACE, CONFIGMAP_NAME, { [CONFIGMAP_KEY]: 'production' });
    });

    await test.step('navigate to the create page', async () => {
      await navigateToCreatePage(page);
      await expect(page.locator('#owner')).toBeVisible({ timeout: 10_000 });
    });

    await test.step('fill in function details without namespace', async () => {
      await page.locator('#repo').fill(FUNC_NAME);
      await page.locator('#branch').fill(BRANCH);
      await page.locator('#name').fill(FUNC_NAME);
      await page.locator('#runtime').selectOption('node');
    });

    await test.step('expand the env var section and verify resource dropdowns are disabled', async () => {
      await page.getByRole('button', { name: 'Add environment variable' }).click();
      await expect(page.locator('#env-name-0')).toBeVisible();

      await expect(page.locator('#secret-resource-0')).toBeDisabled();
      await expect(page.locator('#configmap-resource-0')).toBeDisabled();
    });

    await test.step('fill namespace and verify resource dropdowns become enabled', async () => {
      await page.locator('#namespace').fill(NAMESPACE);

      await expect(page.locator('#secret-resource-0')).toBeEnabled({ timeout: 10_000 });
      await expect(page.locator('#configmap-resource-0')).toBeEnabled({ timeout: 10_000 });
    });

    await test.step('add a plain key/value env var', async () => {
      await page.locator('#env-name-0').fill('LOG_LEVEL');
      await page.locator('#env-value-0').fill('debug');
    });

    await test.step('verify key dropdown is disabled until a resource is selected', async () => {
      await expect(page.locator('#secret-key-0')).toBeDisabled();
      await expect(page.locator('#configmap-key-0')).toBeDisabled();
    });

    await test.step('add a Secret env var', async () => {
      const secretResource = page.locator('#secret-resource-0');
      await expect(secretResource.locator(`option[value="${SECRET_NAME}"]`)).toBeAttached({
        timeout: 30_000,
      });

      await page.locator('#secret-name-0').fill('DB_PASS');
      await secretResource.selectOption(SECRET_NAME);

      const secretKey = page.locator('#secret-key-0');
      await expect(secretKey).toBeEnabled();
      await expect(secretKey.locator(`option[value="${SECRET_KEY}"]`)).toBeAttached();
      await secretKey.selectOption(SECRET_KEY);
    });

    await test.step('add a ConfigMap env var', async () => {
      const cmResource = page.locator('#configmap-resource-0');
      await expect(cmResource.locator(`option[value="${CONFIGMAP_NAME}"]`)).toBeAttached({
        timeout: 30_000,
      });

      await page.locator('#configmap-name-0').fill('APP_CONFIG');
      await cmResource.selectOption(CONFIGMAP_NAME);

      const cmKey = page.locator('#configmap-key-0');
      await expect(cmKey).toBeEnabled();
      await expect(cmKey.locator(`option[value="${CONFIGMAP_KEY}"]`)).toBeAttached();
      await cmKey.selectOption(CONFIGMAP_KEY);
    });

    await test.step('changing resource clears the key selection', async () => {
      const secretKey = page.locator('#secret-key-0');
      await expect(secretKey).toHaveValue(SECRET_KEY);

      await page.locator('#secret-resource-0').selectOption(SECRET2_NAME);

      await expect(secretKey).toHaveValue('');
      await expect(secretKey).toBeEnabled();
      await expect(secretKey.locator(`option[value="${SECRET2_KEY}"]`)).toBeAttached();

      await page.locator('#secret-resource-0').selectOption(SECRET_NAME);
      await secretKey.selectOption(SECRET_KEY);
    });

    await test.step('namespace change resets resource selections', async () => {
      await expect(page.locator('#secret-resource-0')).toHaveValue(SECRET_NAME);
      await expect(page.locator('#secret-key-0')).toHaveValue(SECRET_KEY);
      await expect(page.locator('#configmap-resource-0')).toHaveValue(CONFIGMAP_NAME);
      await expect(page.locator('#configmap-key-0')).toHaveValue(CONFIGMAP_KEY);

      await page.locator('#namespace').fill('other-ns');

      await expect(page.locator('#secret-resource-0')).toHaveValue('');
      await expect(page.locator('#secret-key-0')).toHaveValue('');
      await expect(page.locator('#secret-key-0')).toBeDisabled();
      await expect(page.locator('#configmap-resource-0')).toHaveValue('');
      await expect(page.locator('#configmap-key-0')).toHaveValue('');
      await expect(page.locator('#configmap-key-0')).toBeDisabled();

      await page.locator('#namespace').fill(NAMESPACE);
      await expect(
        page.locator('#secret-resource-0').locator(`option[value="${SECRET_NAME}"]`),
      ).toBeAttached({ timeout: 30_000 });
      await expect(
        page.locator('#configmap-resource-0').locator(`option[value="${CONFIGMAP_NAME}"]`),
      ).toBeAttached({ timeout: 30_000 });
      await page.locator('#secret-resource-0').selectOption(SECRET_NAME);
      await page.locator('#secret-key-0').selectOption(SECRET_KEY);
      await page.locator('#configmap-resource-0').selectOption(CONFIGMAP_NAME);
      await page.locator('#configmap-key-0').selectOption(CONFIGMAP_KEY);
    });

    await test.step('verify submit button is enabled', async () => {
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    });

    await test.step('submit and verify redirect to overview', async () => {
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page).toHaveURL(/\/faas$/, { timeout: 30_000 });
    });

    await test.step('verify func.yaml on fake GitHub contains env vars', async () => {
      const url = fakeGithubUrl();
      const resp = await fetch(`${url}/repos/e2e-user/${FUNC_NAME}/contents/func.yaml`, {
        headers: { Authorization: 'token placeholder-pat' },
      });
      expect(resp.ok).toBe(true);

      const json = await resp.json();
      const content = Buffer.from(json.content, 'base64').toString('utf-8');

      expect(content).toContain('LOG_LEVEL');
      expect(content).toContain('debug');
      expect(content).toContain('DB_PASS');
      expect(content).toContain(`{{ secret:${SECRET_NAME}:${SECRET_KEY} }}`);
      expect(content).toContain('APP_CONFIG');
      expect(content).toContain(`{{ configMap:${CONFIGMAP_NAME}:${CONFIGMAP_KEY} }}`);
    });
  });
});
