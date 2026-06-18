import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../testing/msw/server';
import { MemoryRouter } from 'react-router-dom';
import FunctionCreatePage from './FunctionCreatePage';
import { PAT_KEY, USER_KEY } from '../../common/services/types';

const mockNavigate = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openshift-console/dynamic-plugin-sdk', () => {
  async function handleResponse(res: Response) {
    const json = await res.json();
    if (!res.ok) throw json;
    return json;
  }

  const consoleFetchJSON = Object.assign(
    async (url: string) => {
      const res = await fetch(new URL(url, 'http://localhost').href);
      return handleResponse(res);
    },
    {
      post: async (url: string, body: unknown) => {
        const res = await fetch(new URL(url, 'http://localhost').href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return handleResponse(res);
      },
    },
  );

  return {
    DocumentTitle: ({ children }: { children: string }) => children,
    ListPageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => (
      <>
        {title}
        {children}
      </>
    ),
    consoleFetchJSON,
    useK8sWatchResource: vi.fn().mockReturnValue([[], true, null]),
  };
});

vi.mock('react-router-dom-v5-compat', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../../common/components/UserAvatar', () => ({
  UserAvatar: ({ enableReconnect }: { enableReconnect: boolean }) => (
    <span data-testid="user-avatar">{enableReconnect ? 'reconnect' : 'no-reconnect'}</span>
  ),
}));

vi.mock('libsodium-wrappers', () => ({
  default: {
    ready: Promise.resolve(),
    base64_variants: { ORIGINAL: 1 },
    from_base64: () => new Uint8Array([10, 20, 30]),
    from_string: () => new Uint8Array([5, 6, 7]),
    crypto_box_seal: () => new Uint8Array([1, 2, 3, 4]),
    to_base64: () => 'AQIDBA==',
  },
}));

const GITHUB_API = 'https://api.github.com';
const K8S_API = 'http://localhost/api/kubernetes';
const BACKEND_API = 'http://localhost/api/proxy/plugin/console-functions-plugin/backend';

function setupCreateFlowHandlers() {
  const repoName = 'my-repo';
  const owner = 'testuser';

  server.use(
    // Backend: generate function files
    http.post(`${BACKEND_API}/api/function/create`, () =>
      HttpResponse.json([
        { path: 'func.yaml', mode: '100644', content: 'name: f', type: 'blob' },
      ]),
    ),

    // GitHub: check repo doesn't exist
    http.get(`${GITHUB_API}/repos/${owner}/${repoName}`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),

    // GitHub: create repo
    http.post(`${GITHUB_API}/user/repos`, () =>
      HttpResponse.json({ name: repoName, owner: { login: owner }, default_branch: 'main' }),
    ),

    // GitHub: get public key for secrets
    http.get(`${GITHUB_API}/repos/${owner}/${repoName}/actions/secrets/public-key`, () =>
      HttpResponse.json({ key_id: 'key-1', key: btoa('x'.repeat(32)) }),
    ),

    // GitHub: create secret
    http.put(
      `${GITHUB_API}/repos/${owner}/${repoName}/actions/secrets/:name`,
      () => new HttpResponse(null, { status: 204 }),
    ),

    // GitHub: set topics
    http.put(`${GITHUB_API}/repos/${owner}/${repoName}/topics`, () =>
      HttpResponse.json({ names: ['serverless-function'] }),
    ),

    // GitHub: create blob
    http.post(`${GITHUB_API}/repos/${owner}/${repoName}/git/blobs`, () =>
      HttpResponse.json({ sha: 'blob-sha' }),
    ),

    // GitHub: get ref
    http.get(`${GITHUB_API}/repos/${owner}/${repoName}/git/ref/:ref+`, () =>
      HttpResponse.json({ object: { sha: 'head-sha' } }),
    ),

    // GitHub: get commit
    http.get(`${GITHUB_API}/repos/${owner}/${repoName}/git/commits/:sha`, () =>
      HttpResponse.json({ sha: 'head-sha', tree: { sha: 'parent-tree-sha' } }),
    ),

    // GitHub: create tree
    http.post(`${GITHUB_API}/repos/${owner}/${repoName}/git/trees`, () =>
      HttpResponse.json({ sha: 'tree-sha' }),
    ),

    // GitHub: create commit
    http.post(`${GITHUB_API}/repos/${owner}/${repoName}/git/commits`, () =>
      HttpResponse.json({ sha: 'commit-sha' }),
    ),

    // GitHub: update ref
    http.patch(`${GITHUB_API}/repos/${owner}/${repoName}/git/refs/:ref+`, () =>
      HttpResponse.json({}),
    ),

    // K8s: create SA
    http.post(`${K8S_API}/api/v1/namespaces/:ns/serviceaccounts`, () => HttpResponse.json({})),

    // K8s: create Role
    http.post(`${K8S_API}/apis/rbac.authorization.k8s.io/v1/namespaces/:ns/roles`, () =>
      HttpResponse.json({}),
    ),

    // K8s: create RoleBindings
    http.post(`${K8S_API}/apis/rbac.authorization.k8s.io/v1/namespaces/:ns/rolebindings`, () =>
      HttpResponse.json({}),
    ),

    // K8s: token request
    http.post(`${K8S_API}/api/v1/namespaces/:ns/serviceaccounts/func-github/token`, () =>
      HttpResponse.json({ status: { token: 'sa-token-value' } }),
    ),
  );
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <FunctionCreatePage />
    </MemoryRouter>,
  );

const fillForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByRole('textbox', { name: /Repository/ }), 'my-repo');
  await user.type(screen.getByRole('textbox', { name: /Branch/ }), 'main');
  await user.type(screen.getByRole('textbox', { name: /^Name$/ }), 'my-func');
  await user.type(screen.getByRole('textbox', { name: /Namespace/ }), 'default');
};

describe('FunctionCreatePage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    (window as unknown as Record<string, unknown>).SERVER_FLAGS = {
      kubeAPIServerURL: 'https://api.cluster.example.com:6443',
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).SERVER_FLAGS;
  });

  afterAll(() => {
    sessionStorage.clear();
  });

  it('renders CreateFunctionForm', () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');

    renderPage();

    expect(screen.getByRole('textbox', { name: /Owner/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/ })).toBeInTheDocument();
  });

  it('generates function, creates repo with secrets, then navigates on submit', async () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: 'testuser' }));
    const user = userEvent.setup();
    setupCreateFlowHandlers();

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/faas');
    });
  });

  it('shows an alert on error', async () => {
    sessionStorage.setItem(PAT_KEY, 'ghp_test');
    sessionStorage.setItem(USER_KEY, JSON.stringify({ name: 'testuser' }));
    const user = userEvent.setup();

    server.use(
      http.post(`${BACKEND_API}/api/function/create`, () =>
        HttpResponse.json('Backend error', { status: 500 }),
      ),
    );

    renderPage();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /Create/ }));

    await waitFor(() => {
      expect(screen.getByText(/Backend error/)).toBeInTheDocument();
    });
  });

  it('renders UserAvatar in header', () => {
    renderPage();

    expect(screen.getByTestId('user-avatar')).toBeInTheDocument();
  });

  it('shows warning and hides form when no PAT is set', () => {
    renderPage();

    expect(
      screen.getByText(/A GitHub Personal Access Token is required to create functions/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Owner/ })).not.toBeInTheDocument();
  });
});
