import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

const SA_NAME = 'func-github';
const ROLE_NAME = 'func-github-deployer';
const TOKEN_EXPIRY_SECONDS = 31536000; // 1 year; token rotation is not yet implemented
const PROXY_BASE = '/api/proxy/plugin/console-functions-plugin/backend';

export class OcpClusterService {
  /**
   * Generates a kubeconfig for GitHub Actions CI/CD so the workflow runner
   * can authenticate to the cluster and run func deploy. Creates the
   * necessary ServiceAccount, Role, and RoleBindings in the target
   * namespace if they do not already exist.
   *
   * The kubeconfig embeds the cluster CA certificate when the API
   * server uses a private CA (not trusted by the system trust store).
   * When the cert is publicly trusted, the CA is omitted and the
   * runner's system trust store handles verification.
   */
  async generateKubeconfig(namespace: string): Promise<string> {
    await this.#createServiceAccount(namespace);
    await this.#createRole(namespace);
    await this.#createRoleBinding(namespace);
    await this.#createImageBuilderBinding(namespace);

    const token = await this.#requestToken(namespace);
    const apiServerURL = this.#getApiServerURL();
    const ca = await this.#fetchClusterCA(apiServerURL);

    return this.#buildKubeconfig(apiServerURL, token, namespace, ca);
  }

  async #createServiceAccount(namespace: string): Promise<void> {
    await this.#createIgnoringConflict(
      `/api/kubernetes/api/v1/namespaces/${namespace}/serviceaccounts`,
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: SA_NAME, namespace },
      },
    );
  }

  async #createRole(namespace: string): Promise<void> {
    await this.#createIgnoringConflict(
      `/api/kubernetes/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles`,
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: ROLE_NAME, namespace },
        rules: [
          {
            apiGroups: [''],
            resources: ['pods', 'pods/exec', 'services', 'configmaps'],
            verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
          },
          {
            apiGroups: ['apps'],
            resources: ['deployments'],
            verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
          },
          {
            apiGroups: ['image.openshift.io'],
            resources: ['imagestreams', 'imagestreamtags'],
            verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
          },
          {
            apiGroups: ['serving.knative.dev'],
            resources: ['services', 'routes', 'revisions'],
            verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
          },
        ],
      },
    );
  }

  async #createRoleBinding(namespace: string): Promise<void> {
    await this.#createIgnoringConflict(
      `/api/kubernetes/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: ROLE_NAME, namespace },
        subjects: [{ kind: 'ServiceAccount', name: SA_NAME, namespace }],
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: ROLE_NAME,
        },
      },
    );
  }

  async #createImageBuilderBinding(namespace: string): Promise<void> {
    await this.#createIgnoringConflict(
      `/api/kubernetes/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: `${SA_NAME}-image-builder`, namespace },
        subjects: [{ kind: 'ServiceAccount', name: SA_NAME, namespace }],
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'system:image-builder',
        },
      },
    );
  }

  async #requestToken(namespace: string): Promise<string> {
    const result = await consoleFetchJSON.post(
      `/api/kubernetes/api/v1/namespaces/${namespace}/serviceaccounts/${SA_NAME}/token`,
      {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenRequest',
        spec: { expirationSeconds: TOKEN_EXPIRY_SECONDS },
      },
    );
    return result.status.token;
  }

  async #fetchClusterCA(server: string): Promise<string | null> {
    const result = await consoleFetchJSON(
      `${PROXY_BASE}/api/cluster/ca?server=${encodeURIComponent(server)}`,
    );
    return (result as { ca: string | null }).ca;
  }

  #getApiServerURL(): string {
    const serverFlags = (window as unknown as Record<string, unknown>).SERVER_FLAGS as
      | { kubeAPIServerURL?: string }
      | undefined;
    if (!serverFlags?.kubeAPIServerURL) {
      throw new Error('Cannot determine API server URL from console');
    }
    return serverFlags.kubeAPIServerURL;
  }

  #buildKubeconfig(server: string, token: string, namespace: string, ca: string | null): string {
    const clusterEntry: Record<string, unknown> = { server };
    if (ca) {
      clusterEntry['certificate-authority-data'] = ca;
    }

    return JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          cluster: clusterEntry,
          name: 'cluster',
        },
      ],
      contexts: [
        {
          context: {
            cluster: 'cluster',
            namespace,
            user: SA_NAME,
          },
          name: SA_NAME,
        },
      ],
      'current-context': SA_NAME,
      users: [
        {
          name: SA_NAME,
          user: { token },
        },
      ],
    });
  }

  async #createIgnoringConflict(url: string, body: unknown): Promise<void> {
    try {
      await consoleFetchJSON.post(url, body);
    } catch (err) {
      if (!this.#isConflict(err)) {
        throw err;
      }
    }
  }

  #isConflict(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) {
      return false;
    }
    const record = err as Record<string, unknown>;
    // K8s Status object (consoleFetchJSON may throw this directly)
    if (record.code === 409 || record.reason === 'AlreadyExists') {
      return true;
    }
    // Standard HTTP error with response property
    if (
      typeof record.response === 'object' &&
      record.response !== null &&
      (record.response as Record<string, unknown>).status === 409
    ) {
      return true;
    }
    return false;
  }
}
