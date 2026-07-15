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

const MOCK_PUBLIC_KEY = {
  key_id: 'mock-key-id',
  key: Buffer.from('mock-public-key-exactly-32-bytes').toString('base64'),
};

const mockedPages = new WeakSet<Page>();
let blobCounter = 0;

export async function mockGitHubApi(page: Page): Promise<void> {
  if (mockedPages.has(page)) return;
  mockedPages.add(page);
  blobCounter = 0;

  await page.route('https://api.github.com/**', (route: Route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const method = route.request().method();

    // --- GET endpoints ---

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

    // git.getRef: GET /repos/:owner/:repo/git/ref/heads/:branch (singular)
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\//.test(path)) {
      return route.fulfill({
        json: { ref: path.replace('/git/ref/', '/git/refs/'), object: { sha: 'mock-parent-sha' } },
      });
    }

    // git.getCommit: GET /repos/:owner/:repo/git/commits/:sha
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/commits\//.test(path)) {
      const sha = path.split('/').pop() ?? '';
      return route.fulfill({
        json: { sha, tree: { sha: 'mock-base-tree' }, parents: [] },
      });
    }

    // repos.get (existence check): GET /repos/:owner/:repo
    // Must come after more specific /repos/ patterns above
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      return route.fulfill({ status: 404, json: { message: 'Not Found' } });
    }

    // actions.getRepoPublicKey
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/actions\/secrets\/public-key$/.test(path)) {
      return route.fulfill({ json: MOCK_PUBLIC_KEY });
    }

    // --- POST endpoints ---

    // repos.createForAuthenticatedUser
    if (method === 'POST' && path === '/user/repos') {
      return route.fulfill({
        status: 201,
        json: {
          name: 'new-fn',
          html_url: 'https://github.com/e2e-user/new-fn',
          default_branch: 'main',
          owner: { login: 'e2e-user' },
        },
      });
    }

    // git.createBlob
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/blobs$/.test(path)) {
      blobCounter++;
      return route.fulfill({
        status: 201,
        json: { sha: `mock-blob-${String(blobCounter).padStart(3, '0')}` },
      });
    }

    // git.createTree
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/trees$/.test(path)) {
      return route.fulfill({ status: 201, json: { sha: 'mock-new-tree' } });
    }

    // git.createCommit
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/commits$/.test(path)) {
      return route.fulfill({ status: 201, json: { sha: 'mock-new-commit' } });
    }

    // --- PUT endpoints ---

    // actions.createOrUpdateRepoSecret
    if (method === 'PUT' && /^\/repos\/[^/]+\/[^/]+\/actions\/secrets\//.test(path)) {
      return route.fulfill({ status: 204, body: '' });
    }

    // repos.replaceAllTopics
    if (method === 'PUT' && /^\/repos\/[^/]+\/[^/]+\/topics$/.test(path)) {
      return route.fulfill({ json: { names: ['serverless-function'] } });
    }

    // --- PATCH endpoints ---

    // git.updateRef: PATCH /repos/:owner/:repo/git/refs/heads/:branch (plural)
    if (method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\//.test(path)) {
      return route.fulfill({ json: { object: { sha: 'mock-new-commit' } } });
    }

    // Fallback
    return route.fulfill({
      status: 404,
      json: { message: 'Not Found (e2e mock)' },
    });
  });
}
