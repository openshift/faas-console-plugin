# Testing — func-console

## Approach

Red/green/refactor TDD — **one test at a time**:

> This applies to both frontend and backend. The tools differ; the discipline does not.

1. Write one test case (red)
2. Write the minimum implementation to make it pass (green)
3. Refactor if needed
4. Move to the next test case

Do NOT write all test cases first and then implement everything at once.

**Bug fixes require a regression test.** Add a unit test that reproduces the bug, or an e2e test if the bug is not testable at the unit level.

## Test Double Terminology

Not every test double is a mock. Use the correct term:

| Term | Purpose | Examples |
|------|---------|----------|
| **Stub** | Returns canned responses, no behaviour verification | Backend: `scm.ClientStub`, `cluster.ClientStub`. Frontend: `listFunctionsStub` (MSW handler returning configured responses), `useK8sWatchResourceStub` |
| **Fake** | Working implementation with shortcuts (e.g., in-memory store) | Backend: `fake.NewSimpleClientset` (in-memory K8s client). Frontend: `authenticateGithubFake` (populates sessionStorage instead of real OAuth) |
| **Mock** | Asserts expectations inside the double | Use sparingly. Prefer stubs with assertions in the test body. |
| **Spy** | Records calls for later assertion | Not currently used. Prefer asserting on observable output. |

## Frontend

### Running Frontend Unit Tests

```bash
make unit-frontend
```

### Page and Component Tests

Page tests are the primary entry point. They render the real page with all real child components and hooks. No test doubles for components or hooks, only for external boundaries (SDK, backend API). Page tests cover full user interaction flows end to end within the page.

**Page tests** cover:

- Full user interaction flows (refresh, namespace switch, error recovery)
- Page-level states: loading, error, empty
- Data flowing from real hooks through real components to the screen
- Cross-component effects (e.g., form submit calls service, then navigates)

**Component tests** cover:

- Rendering based on props (all states and variants)
- User interactions that trigger callbacks (clicks, input, form validation)
- Internal state (expand/collapse, selection)

Overlap between page tests and component tests is expected and acceptable. They test at different levels: page tests verify the page's orchestration logic works correctly, component tests verify the component works in isolation.

### Frontend Testing Framework

Shared test infrastructure lives in `src/common/testing/`:

| File | Purpose |
| ------ | --------- |
| `sdkTestDoubles.tsx` | Stubs for OCP SDK hooks: `useK8sWatchResourceStub`, `useActiveNamespaceStub`, fixture builders (`ksvcFixture`, `deploymentFixture`) |
| `functionsClientStub.ts` | MSW handler that intercepts `listFunctions` requests with configurable responses, errors, and delays |
| `mswServer.ts` | MSW server with default backend API handlers (auth user, function list) |
| `authFake.ts` | Session storage helpers to simulate GitHub authentication (`authenticateGithubFake`, `logoutGithubFake`) |
| `constants.ts` | Shared test constants (`BACKEND_API` base URL) |

### Frontend Test Double Strategy

Tests replace external dependencies at two boundaries using test doubles:

**Backend API (MSW).** `functionsClient.ts` calls the Go backend over HTTP. MSW intercepts these requests at the network level, so tests exercise the real client code (URL construction, query params, error handling) without replacing it. Test doubles are set up per test via helpers in `src/common/testing/functionsClientStub.ts`.

**OCP SDK (test doubles via `vi.mock`).** The OCP dynamic plugin SDK provides hooks like `useK8sWatchResource` and `useActiveNamespace` that only work inside the console shell. Tests replace them with self-written stubs from `src/common/testing/sdkTestDoubles.tsx`, injected through `vi.mock('@openshift-console/dynamic-plugin-sdk')`. The stubs accept raw K8s resource fixtures (Knative Services, Deployments) and let the real hooks (e.g., `useCluster`) derive status, replicas, and URL. This catches shape mismatches at test time instead of hiding them behind pre-computed return values.

`vi.mock` is also used for framework internals that have no external service and cannot run outside their host environment:

- `react-i18next` (translation hook)
- `@patternfly/react-icons` (UI library)

### Frontend Testing Practices & Conventions

1. **User-Centric Testing** — Test what users see and interact with.
   Do NOT test: internal component state, private methods, props passed to children, CSS class names, component structure.

2. **Accessibility-First** — Prefer role-based queries (`getByRole`) over generic selectors (`getByTestId`).

3. **Async-Aware** — Handle async updates with `findBy*` and `waitFor`.

4. **TypeScript Safety** — Use proper types for props, state, and mock data.

5. **Arrange-Act-Assert (AAA)** — Structure every test:
   - **Arrange:** Set up test doubles
   - **Act:** Render the component or perform user actions
   - **Assert:** Verify expected state

   ```typescript
   it('shows NotDeployed status for repos without cluster deployment', async () => {
     // Arrange
     listFunctionsStub({ responses: [repoListItem('orphan-func', 'orphan-func', 'demo', 'node')] });

     // Act
     render(
       <MemoryRouter>
         <FunctionsListPage />
       </MemoryRouter>,
     );

     // Assert
     expect(await screen.findByText('Info: NotDeployed')).toBeInTheDocument();
   });
   ```

6. **Scoping** — Place beforeEach, afterEach, and afterAll inside describe blocks.

7. **Hook tests use `renderHook`** — Test hooks directly with `renderHook` from `@testing-library/react`. Assert on `result.current` instead of rendering a consumer component and querying the DOM.

   ```typescript
   const { result } = renderHook(() => useCluster([funcName], namespace));

   expect(result.current.loaded).toBe(true);
   expect(result.current.functions.size).toBe(0);
   ```

8. **`server.boundary()` for infinite delays** — When a test uses `delay('infinite')` to verify loading states, wrap the test in `server.boundary()`. This scopes MSW handlers to the test and prevents in-flight requests from leaking across test boundaries (`resetHandlers()` alone does not abort in-flight requests).

   ```typescript
   it(
     'shows loading state while fetching',
     server.boundary(async () => {
       server.use(
         http.get(`${BACKEND_API}/api/v1/func/.../files`, async () => {
           await delay('infinite');
           return HttpResponse.json([]);
         }),
       );

       render(<MyPage />);

       expect(screen.getByText('Loading...')).toBeInTheDocument();
     }),
   );
   ```

### `vi.mock`

Avoid `vi.mock` mostly. It is only for external boundaries that cannot be intercepted at the network level (see "Test Doubles" above). Do not use `vi.mock` to replace components or hooks. If a component or hook is hard to test without replacing it, that is a design issue.

Use ESM `import` at top of file. Keep test doubles simple.

**Allowed patterns:**

```typescript
// Framework internals
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// OCP SDK boundary — load test doubles via vi.hoisted so they are
// available inside the vi.mock factory (which is hoisted above imports)
const sdkTestDoubles = await vi.hoisted(async () => import('../../common/testing/sdkTestDoubles'));

vi.mock('@openshift-console/dynamic-plugin-sdk', async () => ({
  useK8sWatchResource: sdkTestDoubles.useK8sWatchResourceStub,
  useActiveNamespace: sdkTestDoubles.useActiveNamespaceStub,
  // ... remaining SDK exports as simple stubs
}));
```

**Clean up:**

```typescript
// always put inside a describe block
afterEach(() => {
  vi.restoreAllMocks();
});
```

**Forbidden patterns:**

```typescript
// NEVER - require() in mocks
vi.mock('../Component', () => {
  const React = require('react');
  return () => React.createElement('div');
});

// NEVER - JSX in mocks
vi.mock('../Component', () => () => <div>Mock</div>);
```

---

## Backend

Ginkgo v2 + Gomega for specs. No other third-party test libraries.

### Running Backend Unit Tests

```bash
make unit-backend
```

### Backend Testing Framework

Test double stubs live next to their interfaces:

| File | Purpose |
|------|---------|
| `scm/client.go` (`ClientStub`) | Stub for `scm.Client` with function fields for each method (GetUser, ListRepos, PushFiles, etc.) |
| `cluster/client.go` (`ClientStub`) | Stub for `cluster.Client` with function fields for RBAC and token operations |
| `functions/client.go` (`ClientStub`) | Stub for `functions.Client` with a function field for List |
| `handler/common_test.go` | Injection helpers: `withSCMStub`, `withClusterStub`, `withFunctionsClient` swap the production factory for a test stub via `DeferCleanup` |

### Backend Test Double Strategy

Two strategies depending on the package under test:

**Interface-level stubs** (handler tests) - `scm.ClientStub`, `cluster.ClientStub`, and `functions.ClientStub` implement their respective interfaces with function fields. Each test sets only the fields it exercises; unset fields return happy-path defaults. `withSCMStub` swaps `config.SCMRegistry`, `withClusterStub` swaps `newClusterClient`, and `withFunctionsClient` swaps `newFunctionsClient` for the duration of the test. No `httptest.NewServer`, no real HTTP client stack - handler tests verify request parsing, error mapping, and response codes only.

**`fake.NewSimpleClientset`** (cluster package tests) - `k8s.io/client-go/kubernetes/fake` implements `kubernetes.Interface` without any HTTP. Use reactors to simulate errors and pre-populate objects to simulate existing state. This is the client-go idiomatic approach.

Tests live in the same package as the code (`package handler`, `package cluster`) for white-box access. Each package has a `suite_test.go` that registers the Ginkgo runner.

### Spec Pattern

Handler tests call `withSCMStub(&scm.ClientStub{...})`, `withClusterStub(&cluster.ClientStub{...})`, and `withFunctionsClient(&functions.ClientStub{...})` to inject interface-level stubs. Cluster tests inject `fake.NewSimpleClientset()` directly. Each test owns its own setup - no shared state.

Use `DeferCleanup` for teardown, not `defer`.

### Tests are Use Cases

Each `It(...)` describes a behaviour from the caller's perspective. The description says **what the system does**, not which function was called.

```
// Bad — method-focused
It("TestCreateBlob_HappyPath")

// Good — use case
It("commits all files to the branch")
```

Use `DescribeTable` / `Entry` for validation and error variants to keep them concise.

### Backend Testing Practices & Conventions

- `It(...)` descriptions are use cases, not method names
- Every use case needs at minimum: the success path + the main failure path
- Test behaviour, not call counts
- Keep fake servers inline — no shared mock fixtures
- **Assert at the test level, not inside stubs.** Stubs return canned data. They must not contain `Expect` calls or spy booleans. Capture request data into variables and assert on them in the `It(...)` body.
- **Success tests: assert the return AND the final request data.** For multi-step operations (e.g., getRef -> getCommit -> createBlob -> createTree -> createCommit -> updateRef), don't assert that each step was called. The stub already ensures that: if a step is skipped, later steps won't receive the data they need and the call will fail. Assert that the return is not an error, then verify what the last request received, which is the accumulation of all prior operations. This avoids coupling tests to the full implementation while still capturing what matters.
- **Error tests: one test per endpoint.** Each test fails a single endpoint and verifies the error propagates correctly with the right wrapping message.

---

## E2E Tests

E2E tests run against a real OpenShift cluster. GitHub API calls are intercepted with `page.route()` mocks, while K8s API calls go to the real cluster. Each test file covers a single use case, exercising a flow from start to finish with `test.step` for structure.

### Prerequisites

- A running OpenShift cluster with the plugin deployed (or a local dev environment via `make dev`)
- The OpenShift Serverless operator should be installed on the cluster (tests install it automatically, but first install takes several minutes)

### Environment

`playwright.config.ts` auto-loads `.env` from the project root.

| Variable | Purpose | Required |
|----------|---------|----------|
| `BRIDGE_BASE_ADDRESS` | Console URL (default: `http://localhost:9000`) | No |
| `BRIDGE_KUBEADMIN_PASSWORD` | Cluster login password | Only when auth is enabled |

### Running E2E Tests

```bash
make test-e2e                                                   # all tests, headless
make test-e2e ARGS="e2e/use-cases/creation/"                    # one use-case directory
make test-e2e ARGS="e2e/use-cases/delete/function-delete.test.ts"  # single file
make test-e2e ARGS="--headed"                                   # visible browser
make test-e2e ARGS="--ui"                                       # interactive UI mode
yarn test:e2e:report                                            # open HTML report (no make target)
```

### File Structure

```txt
e2e/
  auth.setup.ts                    # Playwright login setup (saves storageState)
  global-setup.ts                  # Global setup (operator install, namespace)
  fixtures/
    authenticated-page.ts          # Custom test fixture: injects PAT into sessionStorage
  helpers/
    cluster.ts                     # K8s API helpers (namespace, operator, deploy)
    constants.ts                   # Shared constants (PRESEEDED_FUNC_NAME, E2E_USER, etc.)
    fakegithub.ts                  # Fake GitHub server helpers (seed, reset, delete repos)
    navigation.ts                  # Page navigation helpers
    ui.ts                          # Dialog dismissal, loading spinners
  use-cases/
    creation/                      # Create function tests
    delete/                        # Delete/undeploy function tests
    edit/                          # Edit function tests
    list/                          # List and namespace scoping tests
```

### E2E Test File Template

```typescript
import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { PRESEEDED_FUNC_NAME as FUNC_NAME } from '../../helpers/constants';

test.describe('My feature', () => {
  test('user does something', async ({ page }) => {
    await test.step('navigate to functions list', async () => {
      await navigateToFunctionsList(page);
    });

    await test.step('verify expected state', async () => {
      const grid = page.getByRole('grid', { name: 'Functions' });
      await expect(grid).toBeVisible({ timeout: 30_000 });
    });
  });
});
```

### E2E Test Doubles

Tests import `test` and `expect` from `e2e/fixtures/authenticated-page.ts`, not from `@playwright/test` directly. The fixture injects a placeholder PAT and user into sessionStorage before each test.

The fake GitHub server (`e2e/helpers/fakegithub.ts`) provides helpers for seeding, resetting, and deleting repos. Shared constants live in `e2e/helpers/constants.ts`:

- `PRESEEDED_FUNC_NAME` ('preseeded-test-func'): a seed repo, used by list, edit, and delete tests
- `E2E_USER` ('e2e-user'): the test user identity

### Helpers

**Auth** - Login is handled by `e2e/auth.setup.ts`, which saves session state via Playwright's `storageState`. The authenticated-page fixture then injects the PAT and user into sessionStorage on top of that session.

**Navigation** (`e2e/helpers/navigation.ts`)

| Helper | Purpose |
| -------- | --------- |
| `navigateToFunctionsList(page)` | Go to `/faas`, dismiss dialogs, wait for load |
| `navigateToFunctionsTable(page)` | Navigate to list and wait for the functions grid |
| `navigateToCreatePage(page)` | Go to `/faas/create` |
| `navigateToEditPage(page, repoName?)` | Go to edit page directly or via list table |
| `selectNamespace(page, namespace)` | Select a specific namespace in the project selector |
| `selectAllNamespaces(page)` | Select "All Namespaces" in the project selector |

**Cluster** (`e2e/helpers/cluster.ts`)

| Helper | Purpose |
| -------- | --------- |
| `k8sHeaders(page)` | Get CSRF token headers for K8s API calls |
| `ensureNamespace(page, name)` | Create namespace if it doesn't exist (waits for terminating namespaces) |
| `ensureSecret(page, ns, name, data)` | Create a Secret if it doesn't exist (base64-encodes data values) |
| `ensureConfigMap(page, ns, name, data)` | Create a ConfigMap if it doesn't exist |
| `simulateGitHubActionsDeploy(page, name, ns)` | Create a ksvc and patch the deployment label to simulate `func deploy` |
| `deleteFunction(page, name, namespace)` | Delete a function's ksvc and deployment from the cluster |
| `ksvcApiPath(ns)` / `deploymentApiPath(ns)` | Build K8s API paths for Knative services and deployments |

**UI** (`e2e/helpers/ui.ts`)

| Helper | Purpose |
|--------|---------|
| `dismissDialogs(page)` | Remove webpack overlay, dismiss PAT modal, dismiss guided tour |
| `waitForLoadingComplete(page)` | Wait for PF6 spinners and OCP loaders to disappear |

### Selectors

Use accessible selectors. Never add `data-test` attributes to production components.

```typescript
page.getByRole('heading', { name: 'Functions', exact: true })
page.getByRole('button', { name: 'Create', exact: true })
page.locator('#name')  // form inputs with HTML id
```

**PatternFly 6 ARIA gotchas:**

| PF6 Component | Renders as | Use |
| --------------- | ----------- | ----- |
| Table (sortable/interactive) | `role="grid"` | `getByRole('grid')`, not `getByRole('table')` |
| Button with `component="a"` | `<a>` with `role="link"` | `getByRole('link')`, not `getByRole('button')` |
| Modal backdrop (stacked) | Intercepts pointer events | `evaluate((el: HTMLElement) => el.click())` to bypass |

**Use `exact: true`** when a name is a substring of other elements (e.g., "Name" matches "Namespace").

### Polling with `expect.poll`

Use `expect.poll()` instead of manual `for`/`while` loops when waiting for K8s resources to reach a desired state. It gives clear timeout errors and reads better than index-counting loops.

```typescript
await expect
  .poll(
    async () => {
      const res = await page.request.get(url, { headers });
      if (!res.ok()) return false;
      const body = await res.json();
      return body.status?.readyReplicas > 0;
    },
    { timeout: 120_000, intervals: [2_000] },
  )
  .toBe(true);
```

All cluster helpers in `e2e/helpers/cluster.ts` follow this pattern.

---

## CI E2E (Prow)

E2E tests also run in CI via Prow/ci-operator against an ephemeral OCP cluster on AWS.

### How it Works

1. ci-operator provisions an ephemeral cluster from the `openshift-org-aws` pool
2. The `install-operators` pre-step installs the Serverless operator from `redhat-operators`
3. ci-operator builds the plugin container image from the Dockerfile
4. `hack/test-prow-e2e.sh` deploys the plugin to the cluster via Helm, enables it on the console, then runs Playwright headless
5. Artifacts (JUnit XML, HTML report, screenshots, traces) are copied to `$ARTIFACT_DIR` for Prow Spyglass

### Configuration

| File | Purpose |
|------|---------|
| `Dockerfile.buildroot` | Builder image (Go 1.26 + Node 24 + Yarn 4 + Helm for the `src` container) |
| `hack/test-prow-e2e.sh` | Prow e2e test entrypoint (reads cluster credentials, deploys plugin, runs tests) |

The ci-operator job config lives in the `openshift/release` repo at `ci-operator/config/openshift/faas-console-plugin/`.

### Prow Jobs

| Job | Type | What it runs |
| ----- | ------ | ------------- |
| `images` | Image build | Builds the plugin container image from `Dockerfile` (automatic ci-operator job) |
| `lint` | Container test (no cluster) | `make lint` |
| `unit` | Container test (no cluster) | `make unit` |
| `e2e-aws` | Cluster test | `make e2e` against an ephemeral OCP cluster (with Serverless + Pipelines operators pre-installed) |

### Local vs CI Differences

In local dev, `simulateGitHubActionsDeploy()` calls `ensureServerlessOperator()` to install the operator if it is missing.
