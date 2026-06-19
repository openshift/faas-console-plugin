import { http, HttpResponse } from 'msw';
import { server } from '../../../../testing/msw/server';
import { OcpClusterService } from './OcpClusterService';

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

  return { consoleFetchJSON };
});

const K8S_API = 'http://localhost/api/kubernetes';
const BACKEND_API = 'http://localhost/api/proxy/plugin/console-functions-plugin/backend';

function setupK8sHandlers(namespace: string) {
  server.use(
    http.get(`${BACKEND_API}/api/cluster/ca`, () => HttpResponse.json({ ca: 'dGVzdC1jYQ==' })),
    http.post(`${K8S_API}/api/v1/namespaces/${namespace}/serviceaccounts`, () =>
      HttpResponse.json({}),
    ),
    http.post(`${K8S_API}/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles`, () =>
      HttpResponse.json({}),
    ),
    http.post(
      `${K8S_API}/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
      () => HttpResponse.json({}),
    ),
    http.post(`${K8S_API}/api/v1/namespaces/${namespace}/serviceaccounts/func-github/token`, () =>
      HttpResponse.json({ status: { token: 'sa-token-value' } }),
    ),
  );
}

describe('OcpClusterService', () => {
  const namespace = 'my-ns';

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).SERVER_FLAGS = {
      kubeAPIServerURL: 'https://api.cluster.example.com:6443',
    };
    setupK8sHandlers(namespace);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).SERVER_FLAGS;
  });

  it('creates SA, Role, RoleBinding, gets token, and returns kubeconfig', async () => {
    const svc = new OcpClusterService();
    const kubeconfig = await svc.generateKubeconfig(namespace);

    const parsed = JSON.parse(kubeconfig);
    expect(parsed.apiVersion).toBe('v1');
    expect(parsed.kind).toBe('Config');
    expect(parsed.clusters[0].cluster.server).toBe('https://api.cluster.example.com:6443');
    expect(parsed.clusters[0].cluster['certificate-authority-data']).toBe('dGVzdC1jYQ==');
    expect(parsed.clusters[0].cluster['insecure-skip-tls-verify']).toBeUndefined();
    expect(parsed.users[0].user.token).toBe('sa-token-value');
    expect(parsed.contexts[0].context.namespace).toBe(namespace);
  });

  it('omits CA fields when cluster uses a publicly trusted certificate', async () => {
    server.use(http.get(`${BACKEND_API}/api/cluster/ca`, () => HttpResponse.json({ ca: null })));

    const svc = new OcpClusterService();
    const kubeconfig = await svc.generateKubeconfig(namespace);

    const parsed = JSON.parse(kubeconfig);
    expect(parsed.clusters[0].cluster['certificate-authority-data']).toBeUndefined();
    expect(parsed.clusters[0].cluster['insecure-skip-tls-verify']).toBeUndefined();
    expect(parsed.clusters[0].cluster.server).toBe('https://api.cluster.example.com:6443');
  });

  it('treats 409 Conflict on SA/Role/RoleBinding as success', async () => {
    const conflict = { code: 409, reason: 'AlreadyExists', message: 'already exists' };
    server.use(
      http.post(`${K8S_API}/api/v1/namespaces/${namespace}/serviceaccounts`, () =>
        HttpResponse.json(conflict, { status: 409 }),
      ),
      http.post(`${K8S_API}/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles`, () =>
        HttpResponse.json(conflict, { status: 409 }),
      ),
      http.post(
        `${K8S_API}/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
        () => HttpResponse.json(conflict, { status: 409 }),
      ),
    );

    const svc = new OcpClusterService();
    const kubeconfig = await svc.generateKubeconfig(namespace);

    expect(JSON.parse(kubeconfig).users[0].user.token).toBe('sa-token-value');
  });

  it('propagates non-409 API errors', async () => {
    server.use(
      http.post(`${K8S_API}/api/v1/namespaces/${namespace}/serviceaccounts`, () =>
        HttpResponse.json(
          { code: 403, reason: 'Forbidden', message: 'Forbidden' },
          { status: 403 },
        ),
      ),
    );

    const svc = new OcpClusterService();
    await expect(svc.generateKubeconfig(namespace)).rejects.toMatchObject({ code: 403 });
  });

  it('throws when SERVER_FLAGS is missing', async () => {
    delete (window as unknown as Record<string, unknown>).SERVER_FLAGS;

    const svc = new OcpClusterService();
    await expect(svc.generateKubeconfig(namespace)).rejects.toThrow(
      'Cannot determine API server URL from console',
    );
  });
});
