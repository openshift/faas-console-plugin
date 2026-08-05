import { Page, Route } from '@playwright/test';

export const PRESEEDED_FUNC_NAME = 'preseeded-test-func';

/** Glob pattern matching all backend proxy requests. Use in test-level overrides with `page.route()`. */
export const BACKEND_ROUTE = '**/api/proxy/plugin/console-functions-plugin/backend/api/v1/**';

const MOCK_USER = { login: 'e2e-user', avatarUrl: '' };

const MOCK_INDEX_JS = 'module.exports = async (context) => context;';

interface SeedRepo {
  owner: string;
  repoName: string;
  url: string;
  defaultBranch: string;
  funcYaml: string;
}

const SEED_REPOS: SeedRepo[] = [
  {
    owner: 'e2e-user',
    repoName: PRESEEDED_FUNC_NAME,
    url: `https://github.com/e2e-user/${PRESEEDED_FUNC_NAME}`,
    defaultBranch: 'main',
    funcYaml: `name: ${PRESEEDED_FUNC_NAME}\nruntime: node\nnamespace: default\n`,
  },
];

interface CreatedRepo {
  owner: string;
  repoName: string;
  url: string;
  defaultBranch: string;
  funcYaml: string;
}

function parseFuncYaml(yaml: string) {
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const namespaceMatch = yaml.match(/^namespace:\s*(.+)$/m);
  const runtimeMatch = yaml.match(/^runtime:\s*(.+)$/m);
  return {
    name: nameMatch?.[1] ?? '',
    namespace: namespaceMatch?.[1] ?? '',
    runtime: runtimeMatch?.[1] ?? '',
  };
}

export async function mockBackendApi(page: Page): Promise<void> {
  const createdRepos: CreatedRepo[] = [];

  function buildListResponse() {
    return [
      ...SEED_REPOS.map((r) => ({
        owner: r.owner,
        repoName: r.repoName,
        url: r.url,
        defaultBranch: r.defaultBranch,
        ...parseFuncYaml(r.funcYaml),
      })),
      ...createdRepos.map((r) => ({
        owner: r.owner,
        repoName: r.repoName,
        url: r.url,
        defaultBranch: r.defaultBranch,
        ...parseFuncYaml(r.funcYaml),
      })),
    ];
  }

  function funcYamlForRepo(repoName: string): string {
    const created = createdRepos.find((r) => r.repoName === repoName);
    if (created) return created.funcYaml;
    const seed = SEED_REPOS.find((r) => r.repoName === repoName);
    if (seed) return seed.funcYaml;
    return SEED_REPOS[0].funcYaml;
  }

  function filesForRepo(repoName: string) {
    return [
      { path: 'func.yaml', mode: '100644', content: funcYamlForRepo(repoName), type: 'blob' },
      { path: 'index.js', mode: '100644', content: MOCK_INDEX_JS, type: 'blob' },
    ];
  }

  await page.route(BACKEND_ROUTE, async (route: Route) => {
    const url = new URL(route.request().url());
    const fullPath = url.pathname;
    const method = route.request().method();

    // Strip the proxy prefix to get the API path
    const idx = fullPath.indexOf('/api/v1/');
    if (idx < 0) {
      return route.fulfill({ status: 404, json: { message: 'Not Found (e2e mock)' } });
    }
    const apiPath = fullPath.substring(idx);

    // --- GET endpoints ---

    if (method === 'GET' && apiPath === '/api/v1/auth/user') {
      return route.fulfill({ json: MOCK_USER });
    }

    if (method === 'GET' && apiPath === '/api/v1/func/list') {
      return route.fulfill({ json: buildListResponse() });
    }

    const filesMatch = apiPath.match(/^\/api\/v1\/func\/([^/]+)\/([^/]+)\/files$/);

    if (method === 'GET' && filesMatch) {
      const repoName = decodeURIComponent(filesMatch[2]);
      return route.fulfill({ json: filesForRepo(repoName) });
    }

    // --- POST endpoints ---

    if (method === 'POST' && apiPath === '/api/v1/func/create') {
      const body = route.request().postDataJSON();
      const repoName = body?.repo ?? body?.name ?? 'unknown';
      const runtime = body?.runtime ?? 'node';
      const namespace = body?.namespace ?? 'default';
      const branch = body?.branch ?? 'main';
      const owner = body?.owner ?? 'e2e-user';

      createdRepos.push({
        owner,
        repoName,
        url: `https://github.com/${owner}/${repoName}`,
        defaultBranch: branch,
        funcYaml: `name: ${repoName}\nruntime: ${runtime}\nnamespace: ${namespace}\n`,
      });

      return route.fulfill({ status: 201, body: '' });
    }

    // --- PUT endpoints ---

    if (method === 'PUT' && filesMatch) {
      const repoName = decodeURIComponent(filesMatch[2]);
      const body = route.request().postDataJSON();
      if (body?.files) {
        const funcYamlFile = (body.files as { path: string; content: string }[]).find(
          (f) => f.path === 'func.yaml',
        );
        if (funcYamlFile) {
          const created = createdRepos.find((r) => r.repoName === repoName);
          if (created) created.funcYaml = funcYamlFile.content;
        }
      }
      return route.fulfill({ status: 204, body: '' });
    }

    return route.fulfill({ status: 404, json: { message: 'Not Found (e2e mock)' } });
  });
}
