# OCP Dynamic Plugin Reference

Reference for OpenShift Console dynamic plugin mechanics. For styling rules, see `docs/STYLEGUIDE.md`.

Source: [OCP 4.21 Dynamic Plugins Documentation](https://docs.redhat.com/en/documentation/openshift_container_platform/4.21/html/web_console/dynamic-plugins)

---

## What is a Dynamic Plugin?

A dynamic plugin is a separately deployed UI bundle that the OCP Console loads at runtime from a remote HTTP server. It is decoupled from the Console release cycle, so you ship updates independently.

The plugin runs inside the Console's React app but is loaded dynamically via webpack module federation. The Console discovers plugins through a `ConsolePlugin` custom resource on the cluster.

## How It Works

```txt
1. Operator installs -> creates Deployment + Service (HTTP server hosting plugin JS/CSS)
2. Operator creates ConsolePlugin CR -> tells Console "load plugin from this service"
3. Console fetches plugin-manifest.json from the service
4. Console loads plugin's JS modules at runtime
5. Plugin's extensions (nav items, pages, etc.) appear in the Console UI
```

## Key Files

- `console-extensions.json`: Declares what the plugin adds to console (routes, nav items, etc.)
- `package.json` `consolePlugin` section: Plugin metadata and exposed modules mapping
- `webpack.config.ts`: Configures module federation and build

**Critical:** Any component referenced in `console-extensions.json` must have a corresponding entry in `package.json` under `consolePlugin.exposedModules`.

## ConsolePlugin CR

The K8s custom resource that registers your plugin with Console:

```yaml
apiVersion: console.openshift.io/v1
kind: ConsolePlugin
metadata:
  name: my-plugin
spec:
  backend:
    service:
      name: my-plugin
      namespace: my-plugin
      port: 9443
      basePath: /
    type: Service
  displayName: My Plugin
  i18n:
    loadType: Preload          # or Lazy
```

## console-extensions.json and $codeRef

Declares what your plugin contributes to Console. Each entry is an extension with a `type` and `properties`. Components are referenced via `$codeRef`, which maps to `exposedModules` in `package.json`:

```json
[
  {
    "type": "console.navigation/section",
    "properties": {
      "id": "my-section",
      "name": "My Section"
    }
  },
  {
    "type": "console.page/route",
    "properties": {
      "path": "/my-plugin/functions",
      "component": { "$codeRef": "FunctionsListPage" }
    }
  }
]
```

```json
"consolePlugin": {
  "name": "console-functions-plugin",
  "exposedModules": {
    "FunctionsListPage": "./pages/function-list/FunctionsListPage",
    "FunctionCreatePage": "./pages/function-create/FunctionCreatePage",
    "FunctionEditPage": "./pages/function-edit/FunctionEditPage"
  }
}
```

## Extension Types

See [OpenShift Console Extension Types](https://github.com/openshift/console/blob/main/frontend/packages/console-dynamic-plugin-sdk/docs/console-extensions.md) for all available types.

| Extension Type | Purpose |
|---------------|---------|
| `console.navigation/section` | Add nav sections |
| `console.navigation/href` | Add nav items |
| `console.page/route` | Register pages |
| `console.tab` | Add tabs to resource pages |
| `console.action/provider` | Add actions to resources |
| `console.flag` | Feature flags |
| `console.flag/model` | Feature flag based on CRD presence |

## SDK APIs

### Data & K8s

| API | Purpose |
|-----|---------|
| `useK8sWatchResource` | Watch K8s resources reactively |
| `k8sListResource` | List K8s resources (imperative) |
| `useActiveNamespace` | Get/set active namespace |
| `consoleFetch` / `consoleFetchJSON` | Make HTTP requests with Console headers |

### UI Components

| API | Purpose |
|-----|---------|
| `ListPageHeader` | Page header with title |
| `CodeEditor` | Monaco-based code editor (lazy loaded) |
| `ErrorStatus` | Error status popover |
| `ProgressStatus` | In-progress status popover |
| `InfoStatus` | Info status popover |
| `SuccessStatus` | Success status popover |
| `ErrorBoundaryFallbackPage` | Full-page error display |
| `useDeleteModal` | Delete confirmation modal |

> **Note:** `VirtualizedTable` and `ListPageFilter` are deprecated in SDK 4.21.
> Use PatternFly's [Data view](https://www.patternfly.org/extensions/data-view/overview/) instead.

## Plugin Service Proxy

If your plugin needs to talk to an in-cluster backend service, declare it in `ConsolePlugin.spec.proxy`:

```yaml
spec:
  proxy:
    - alias: my-backend
      authorization: UserToken    # passes user's OCP token
      endpoint:
        service:
          name: my-backend-service
          namespace: my-namespace
          port: 8080
        type: Service
```

Then call from JS: `/api/proxy/plugin/my-plugin/my-backend/endpoint`

## Internationalization (i18n)

**Namespace convention:** `plugin__<plugin-name>` (e.g., `plugin__console-functions-plugin`)

i18n namespace must match ConsolePlugin resource name with `plugin__` prefix.

### In React Components

```tsx
const { t } = useTranslation('plugin__console-functions-plugin');
return <h1>{t('Hello, World!')}</h1>;
```

### In console-extensions.json

```json
"name": "%plugin__console-functions-plugin~My Label%"
```

**After adding/changing messages:** Run `yarn i18n` to update locale files in `/locales`.

## Common Development Tasks

### Adding a New Page

1. Create component in `src/pages/my-feature/MyFeaturePage.tsx`
2. Add to `package.json` `exposedModules`: `"MyFeaturePage": "./pages/my-feature/MyFeaturePage"`
3. Add route in `console-extensions.json`:

   ```json
   {
     "type": "console.page/route",
     "properties": {
       "path": "/my-feature",
       "component": { "$codeRef": "MyFeaturePage" }
     }
   }
   ```

4. Optional: Add nav item in `console-extensions.json`
5. Run `yarn i18n` if you added translatable strings

### Adding a Navigation Item

```json
{
  "type": "console.navigation/href",
  "properties": {
    "id": "my-nav-item",
    "name": "%plugin__console-functions-plugin~My Page%",
    "href": "/my-page",
    "perspective": "admin",
    "section": "home"
  }
}
```

## Constraints & Gotchas

1. Module federation requires exact module mapping: `exposedModules` must match `$codeRef` values
2. No webpack HMR for extensions: changes to `console-extensions.json` require restart
3. React 17, not 18: matches console's React version

## Plugin Inventory

[OCP Dynamic Plugin Inventory](https://docs.google.com/spreadsheets/d/1wcCdc1s4ewzxtUJ42VdRhAJ9wFA8UwoTajGSftrr5fM/edit?gid=0#gid=0)

| Plugin | Repo | Description |
|--------|------|-------------|
| Console Plugin Template | [openshift/console-plugin-template](https://github.com/openshift/console-plugin-template) | Starter template for OCP dynamic plugins |
| Console Demo Plugin | [openshift/console (demo)](https://github.com/openshift/console/tree/main/dynamic-demo-plugin) | SDK feature testing and reference |
| KubeVirt | [kubevirt-ui/kubevirt-plugin](https://github.com/kubevirt-ui/kubevirt-plugin) | Virtual machine management UI |
| Forklift | [kubev2v/forklift-console-plugin](https://github.com/kubev2v/forklift-console-plugin) | VM migration from other platforms to KubeVirt |
| Monitoring | [openshift/monitoring-plugin](https://github.com/openshift/monitoring-plugin) | Prometheus monitoring dashboards and alerts |
| Logging | [openshift/logging-view-plugin](https://github.com/openshift/logging-view-plugin) | Log viewing and querying |
| Distributed Tracing | [openshift/distributed-tracing-console-plugin](https://github.com/openshift/distributed-tracing-console-plugin) | Distributed tracing with Tempo/Jaeger |
| Console Dashboards | [openshift/console-dashboards-plugin](https://github.com/openshift/console-dashboards-plugin) | Custom dashboard support for OCP console |
| Troubleshooting Panel | [openshift/troubleshooting-panel-console-plugin](https://github.com/openshift/troubleshooting-panel-console-plugin) | Guided troubleshooting for cluster issues |
| Networking | [openshift/networking-console-plugin](https://github.com/openshift/networking-console-plugin) | Network policies, routes, and services |
| Network Observability | [netobserv/network-observability-console-plugin](https://github.com/netobserv/network-observability-console-plugin) | Network traffic flow visualization |
| OpenShift Pipelines | [openshift-pipelines/console-plugin](https://github.com/openshift-pipelines/console-plugin) | Tekton pipeline builder and viewer |
| OpenShift GitOps | [redhat-developer/gitops-console-plugin](https://github.com/redhat-developer/gitops-console-plugin) | ArgoCD/GitOps application status |
| OpenShift Data Foundation | [red-hat-storage/odf-console](https://github.com/red-hat-storage/odf-console) | Ceph/NooBaa storage management |
| Service Mesh (Kiali) | [kiali/openshift-servicemesh-plugin](https://github.com/kiali/openshift-servicemesh-plugin) | Istio service mesh observability |
| ACM / MCE | [stolostron/console](https://github.com/stolostron/console) | Advanced Cluster Management multi-cluster UI |
| Cluster Templates | [stolostron/cluster-templates-operator](https://github.com/stolostron/cluster-templates-operator) | Cluster provisioning templates |
| Crane (Migration) | [migtools/crane-ui-plugin](https://github.com/migtools/crane-ui-plugin) | Application migration toolkit |
| NMState | [nmstate/nmstate-console-plugin](https://github.com/nmstate/nmstate-console-plugin) | Declarative node network configuration |
| Console Telemetry | [christianvogt/console-telemetry-plugin](https://github.com/christianvogt/console-telemetry-plugin) | Usage telemetry collection for console |
| Lightspeed | [openshift/lightspeed-console](https://github.com/openshift/lightspeed-console) | AI assistant for OpenShift |
| Cryostat | [cryostatio/cryostat-openshift-console-plugin](https://github.com/cryostatio/cryostat-openshift-console-plugin) | JFR profiling and recording management |
| Node Remediation | [medik8s/node-remediation-console](https://github.com/medik8s/node-remediation-console) | Automated node health check and remediation |
| Skupper | [bartoval/skupper-site-console](https://github.com/bartoval/skupper-site-console) | Multi-cluster service connectivity |
| Kuadrant | [Kuadrant/kuadrant-console-plugin](https://github.com/Kuadrant/kuadrant-console-plugin) | API gateway policies (rate limiting, auth) |
