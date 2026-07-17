import { Page, Route } from '@playwright/test';

export const PRESEEDED_FUNC_NAME = 'preseeded-test-func';

const MOCK_USER = { login: 'e2e-user', name: 'E2E Test User' };

const MOCK_INDEX_JS = 'module.exports = async (context) => context;';

const SEED_REPOS = [
  {
    owner: { login: 'e2e-user' },
    name: PRESEEDED_FUNC_NAME,
    html_url: `https://github.com/e2e-user/${PRESEEDED_FUNC_NAME}`,
    default_branch: 'main',
    funcYaml: `name: ${PRESEEDED_FUNC_NAME}\nruntime: node\nnamespace: default\n`,
  },
];

const MOCK_PUBLIC_KEY = {
  key_id: 'mock-key-id',
  key: Buffer.from('mock-public-key-exactly-32-bytes').toString('base64'),
};

interface CreatedRepo {
  name: string;
  branch: string;
  funcYaml: string | null;
}

export async function mockGitHubApi(page: Page): Promise<void> {
  let blobCounter = 0;
  const createdRepos: CreatedRepo[] = [];
  let pendingRepo: CreatedRepo | null = null;

  function funcYamlForRepo(repoName: string): string {
    const created = createdRepos.find((r) => r.name === repoName);
    if (created?.funcYaml) return created.funcYaml;
    const seed = SEED_REPOS.find((r) => r.name === repoName);
    if (seed) return seed.funcYaml;
    return SEED_REPOS[0].funcYaml;
  }

  function buildSearchResults() {
    const items = [
      ...SEED_REPOS.map((r) => ({
        owner: r.owner,
        name: r.name,
        html_url: r.html_url,
        default_branch: r.default_branch,
      })),
      ...createdRepos.map((r) => ({
        owner: { login: 'e2e-user' },
        name: r.name,
        html_url: `https://github.com/e2e-user/${r.name}`,
        default_branch: r.branch,
      })),
    ];
    return { total_count: items.length, items };
  }

  await page.route('https://api.github.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const method = route.request().method();

    // --- GET endpoints ---

    if (method === 'GET' && path === '/user') {
      return route.fulfill({ json: MOCK_USER });
    }

    if (method === 'GET' && path === '/search/repositories') {
      return route.fulfill({ json: buildSearchResults() });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/contents\/func\.yaml$/.test(path)) {
      const repoName = path.split('/')[3];
      const yaml = funcYamlForRepo(repoName);
      return route.fulfill({
        json: {
          content: Buffer.from(yaml).toString('base64'),
          encoding: 'base64',
          type: 'file',
        },
      });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/trees\//.test(path)) {
      return route.fulfill({
        json: {
          sha: 'mock-tree-sha',
          tree: [
            { path: 'func.yaml', type: 'blob', mode: '100644', sha: 'mock-blob-func-yaml' },
            { path: 'index.js', type: 'blob', mode: '100644', sha: 'mock-blob-index-js' },
          ],
        },
      });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/blobs\//.test(path)) {
      const sha = path.split('/').pop() ?? '';
      const repoName = path.split('/')[3];
      const created = createdRepos.find((r) => r.name === repoName);
      if (created?.funcYaml && sha === 'mock-blob-func-yaml') {
        return route.fulfill({
          json: {
            content: Buffer.from(created.funcYaml).toString('base64'),
            encoding: 'base64',
          },
        });
      }
      if (sha === 'mock-blob-index-js') {
        return route.fulfill({
          json: {
            content: Buffer.from(MOCK_INDEX_JS).toString('base64'),
            encoding: 'base64',
          },
        });
      }
      const yaml = funcYamlForRepo(repoName);
      return route.fulfill({
        json: {
          content: Buffer.from(yaml).toString('base64'),
          encoding: 'base64',
        },
      });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\//.test(path)) {
      return route.fulfill({
        json: { ref: path.replace('/git/ref/', '/git/refs/'), object: { sha: 'mock-parent-sha' } },
      });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/git\/commits\//.test(path)) {
      const sha = path.split('/').pop() ?? '';
      return route.fulfill({
        json: { sha, tree: { sha: 'mock-base-tree' }, parents: [] },
      });
    }

    // repos.get (existence check): must come after more specific /repos/ patterns
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      const repoName = path.split('/')[3];
      if (createdRepos.some((r) => r.name === repoName)) {
        return route.fulfill({
          json: { name: repoName, default_branch: 'main', owner: { login: 'e2e-user' } },
        });
      }
      return route.fulfill({ status: 404, json: { message: 'Not Found' } });
    }

    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/actions\/secrets\/public-key$/.test(path)) {
      return route.fulfill({ json: MOCK_PUBLIC_KEY });
    }

    // --- POST endpoints ---

    if (method === 'POST' && path === '/user/repos') {
      const body = route.request().postDataJSON();
      const repoName = body?.name ?? 'unknown-repo';
      pendingRepo = { name: repoName, branch: 'main', funcYaml: null };
      return route.fulfill({
        status: 201,
        json: {
          name: repoName,
          html_url: `https://github.com/e2e-user/${repoName}`,
          default_branch: 'main',
          owner: { login: 'e2e-user' },
        },
      });
    }

    // git.createBlob: capture func.yaml content from blobs
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/blobs$/.test(path)) {
      blobCounter++;
      const body = route.request().postDataJSON();
      if (pendingRepo && body?.content) {
        const raw =
          body.encoding === 'base64'
            ? Buffer.from(body.content, 'base64').toString('utf-8')
            : body.content;
        if (raw.includes('name:') && raw.includes('runtime:')) {
          pendingRepo.funcYaml = raw;
        }
      }
      return route.fulfill({
        status: 201,
        json: { sha: `mock-blob-${String(blobCounter).padStart(3, '0')}` },
      });
    }

    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/trees$/.test(path)) {
      return route.fulfill({ status: 201, json: { sha: 'mock-new-tree' } });
    }

    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/git\/commits$/.test(path)) {
      return route.fulfill({ status: 201, json: { sha: 'mock-new-commit' } });
    }

    // --- PUT endpoints ---

    if (method === 'PUT' && /^\/repos\/[^/]+\/[^/]+\/actions\/secrets\//.test(path)) {
      return route.fulfill({ status: 204, body: '' });
    }

    if (method === 'PUT' && /^\/repos\/[^/]+\/[^/]+\/topics$/.test(path)) {
      return route.fulfill({ json: { names: ['serverless-function'] } });
    }

    // --- PATCH endpoints ---

    // git.updateRef: last step of createRepoWithSecret, finalize the repo
    if (method === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\//.test(path)) {
      if (pendingRepo) {
        createdRepos.push(pendingRepo);
        pendingRepo = null;
        blobCounter = 0;
      }
      return route.fulfill({ json: { object: { sha: 'mock-new-commit' } } });
    }

    return route.fulfill({
      status: 404,
      json: { message: 'Not Found (e2e mock)' },
    });
  });
}
