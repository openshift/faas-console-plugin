import { Page, Route } from '@playwright/test';

const MOCK_USER = { login: 'e2e-user', name: 'E2E Test User' };

const MOCK_FUNC_YAML = 'name: e2e-test-func\nruntime: node\nnamespace: default\n';

const MOCK_INDEX_JS = 'module.exports = async (context) => context;';

const MOCK_SEARCH_REPOS = {
  total_count: 1,
  items: [
    {
      owner: { login: 'e2e-user' },
      name: 'e2e-test-func',
      html_url: 'https://github.com/e2e-user/e2e-test-func',
      default_branch: 'main',
    },
  ],
};

const MOCK_FUNC_YAML_CONTENT = {
  content: Buffer.from(MOCK_FUNC_YAML).toString('base64'),
  encoding: 'base64',
  type: 'file',
};

const MOCK_REPO_TREE = {
  sha: 'mock-tree-sha',
  tree: [
    { path: 'func.yaml', type: 'blob', mode: '100644', sha: 'mock-blob-func-yaml' },
    { path: 'index.js', type: 'blob', mode: '100644', sha: 'mock-blob-index-js' },
  ],
};

const MOCK_BLOBS: Record<string, { content: string; encoding: string }> = {
  'mock-blob-func-yaml': {
    content: Buffer.from(MOCK_FUNC_YAML).toString('base64'),
    encoding: 'base64',
  },
  'mock-blob-index-js': {
    content: Buffer.from(MOCK_INDEX_JS).toString('base64'),
    encoding: 'base64',
  },
};

const mockedPages = new WeakSet<Page>();

export async function mockGitHubApi(page: Page): Promise<void> {
  if (mockedPages.has(page)) return;
  mockedPages.add(page);

  await page.route('https://api.github.com/**', (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (method === 'GET' && path === '/user') {
      return route.fulfill({ json: MOCK_USER });
    }

    if (method === 'GET' && path === '/search/repositories') {
      return route.fulfill({ json: MOCK_SEARCH_REPOS });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/contents\/func\.yaml$/.test(path)) {
      return route.fulfill({ json: MOCK_FUNC_YAML_CONTENT });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/trees\//.test(path)) {
      return route.fulfill({ json: MOCK_REPO_TREE });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/blobs\//.test(path)) {
      const sha = path.split('/').pop() ?? '';
      const blob = MOCK_BLOBS[sha] ?? MOCK_BLOBS['mock-blob-func-yaml'];
      return route.fulfill({ json: blob });
    }

    return route.fulfill({
      status: 404,
      json: { message: 'Not Found (e2e mock)' },
    });
  });
}
