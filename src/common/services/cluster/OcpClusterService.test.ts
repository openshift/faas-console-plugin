import { OcpClusterService } from './OcpClusterService';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('@openshift-console/dynamic-plugin-sdk', () => {
  const fn = (...args: unknown[]) => mockGet(...args);
  fn.post = (...args: unknown[]) => mockPost(...args);
  return { consoleFetchJSON: fn };
});

describe('OcpClusterService', () => {
  const namespace = 'my-ns';

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).SERVER_FLAGS = {
      kubeAPIServerURL: 'https://api.cluster.example.com:6443',
    };
    // GET call: cluster CA endpoint
    mockGet.mockResolvedValueOnce({ ca: 'dGVzdC1jYQ==' });
    // POST calls: SA, Role, RoleBinding, ImageBuilderBinding, TokenRequest
    mockPost
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ status: { token: 'sa-token-value' } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).SERVER_FLAGS;
  });

  it('creates SA, Role, RoleBinding, gets token, and returns kubeconfig', async () => {
    const svc = new OcpClusterService();
    const kubeconfig = await svc.generateKubeconfig(namespace);

    // Verify SA creation
    expect(mockPost).toHaveBeenCalledWith(
      `/api/kubernetes/api/v1/namespaces/${namespace}/serviceaccounts`,
      expect.objectContaining({
        metadata: { name: 'func-github', namespace },
      }),
    );

    // Verify Role creation
    expect(mockPost).toHaveBeenCalledWith(
      `/api/kubernetes/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles`,
      expect.objectContaining({
        metadata: { name: 'func-github-deployer', namespace },
      }),
    );

    // Verify RoleBinding creation
    expect(mockPost).toHaveBeenCalledWith(
      `/api/kubernetes/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
      expect.objectContaining({
        metadata: { name: 'func-github-deployer', namespace },
      }),
    );

    // Verify image-builder RoleBinding
    expect(mockPost).toHaveBeenCalledWith(
      `/api/kubernetes/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
      expect.objectContaining({
        metadata: { name: 'func-github-image-builder', namespace },
        roleRef: expect.objectContaining({
          kind: 'ClusterRole',
          name: 'system:image-builder',
        }),
      }),
    );

    // Verify TokenRequest
    expect(mockPost).toHaveBeenCalledWith(
      `/api/kubernetes/api/v1/namespaces/${namespace}/serviceaccounts/func-github/token`,
      expect.objectContaining({
        kind: 'TokenRequest',
        spec: { expirationSeconds: 31536000 },
      }),
    );

    // Verify CA endpoint was called
    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/api/cluster/ca?server='));

    // Verify kubeconfig structure
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
    mockGet.mockReset().mockResolvedValueOnce({ ca: null });

    const svc = new OcpClusterService();
    const kubeconfig = await svc.generateKubeconfig(namespace);

    const parsed = JSON.parse(kubeconfig);
    expect(parsed.clusters[0].cluster['certificate-authority-data']).toBeUndefined();
    expect(parsed.clusters[0].cluster['insecure-skip-tls-verify']).toBeUndefined();
    expect(parsed.clusters[0].cluster.server).toBe('https://api.cluster.example.com:6443');
  });

  it('treats 409 Conflict (response.status) on SA/Role/RoleBinding as success', async () => {
    const conflict = Object.assign(new Error('Conflict'), { response: { status: 409 } });

    mockGet.mockReset().mockResolvedValueOnce({ ca: 'dGVzdC1jYQ==' });
    mockPost
      .mockReset()
      .mockRejectedValueOnce(conflict) // SA already exists
      .mockRejectedValueOnce(conflict) // Role already exists
      .mockRejectedValueOnce(conflict) // RoleBinding already exists
      .mockRejectedValueOnce(conflict) // ImageBuilderBinding already exists
      .mockResolvedValueOnce({ status: { token: 'sa-token-value' } }); // TokenRequest

    const svc = new OcpClusterService();
    const kubeconfig = await svc.generateKubeconfig(namespace);

    expect(JSON.parse(kubeconfig).users[0].user.token).toBe('sa-token-value');
  });

  it('treats K8s Status object with code 409 as success', async () => {
    const k8sConflict = { code: 409, reason: 'AlreadyExists', message: 'already exists' };

    mockGet.mockReset().mockResolvedValueOnce({ ca: 'dGVzdC1jYQ==' });
    mockPost
      .mockReset()
      .mockRejectedValueOnce(k8sConflict)
      .mockRejectedValueOnce(k8sConflict)
      .mockRejectedValueOnce(k8sConflict)
      .mockRejectedValueOnce(k8sConflict)
      .mockResolvedValueOnce({ status: { token: 'sa-token-value' } });

    const svc = new OcpClusterService();
    const kubeconfig = await svc.generateKubeconfig(namespace);

    expect(JSON.parse(kubeconfig).users[0].user.token).toBe('sa-token-value');
  });

  it('propagates non-409 API errors', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), { response: { status: 403 } });

    mockPost.mockReset().mockRejectedValueOnce(forbidden);

    const svc = new OcpClusterService();
    await expect(svc.generateKubeconfig(namespace)).rejects.toThrow('Forbidden');
  });

  it('throws when SERVER_FLAGS is missing', async () => {
    delete (window as unknown as Record<string, unknown>).SERVER_FLAGS;

    const svc = new OcpClusterService();
    await expect(svc.generateKubeconfig(namespace)).rejects.toThrow(
      'Cannot determine API server URL from console',
    );
  });
});
