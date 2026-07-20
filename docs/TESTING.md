# Testing — func-console

## Approach

Red/green/refactor TDD — **one test at a time**:

> This applies to both frontend and backend. The tools differ; the discipline does not.

1. Write one test case (red)
2. Write the minimum implementation to make it pass (green)
3. Refactor if needed
4. Move to the next test case

Do NOT write all test cases first and then implement everything at once.

## Test Layers

| Layer | Tool | Scope |
|-------|------|-------|
| Unit / Component | Vitest + React Testing Library | Hooks, services, component rendering, form logic |
| E2e / Feature validation | Playwright | Validate user flows in real browser |
| API mocking | MSW (Mock Service Worker) | GitHub API + K8s API — mock everything first, real cluster later |

## Mock Strategy

MSW is the primary mocking strategy for anything that hits the network (GitHub API, K8s API, Go backend). K8s API mocking uses MSW WebSocket capability.

`vi.mock` is only for framework and library internals that have no external service:

- `react-i18next` (translation hook)
- `@openshift-console/dynamic-plugin-sdk` (console shell runtime components like DocumentTitle, ListPageHeader, consoleFetchJSON)
- `@patternfly/react-icons` (UI library)
- `react-router-dom-v5-compat` (framework routing)
- `libsodium-wrappers` (WASM crypto library)

If it makes an HTTP or WebSocket call, mock it with MSW, not `vi.mock`.

## File Conventions

| Type | Location |
|------|----------|
| Component tests | `src/pages/<name>/components/*.test.ts\|tsx`, `src/common/components/*.test.ts\|tsx` |
| Page tests | `src/pages/<name>/*.test.ts\|tsx` |
| Service / Hook / Util tests | `src/common/**/*.test.ts\|tsx` |
| E2e specs | `e2e/use-cases/<feature-name>/*.test.ts` |
| MSW handlers | `testing/msw/handlers.ts` |

## What Gets Tested

| Artifact | Test type | Example |
|----------|-----------|---------|
| Service interfaces | Unit | `FunctionService.generateFunction()` returns expected files |
| React hooks | Unit | `useFunctionService()` returns service instance |
| Components | Component | `CreateForm` renders all fields, validates input |
| Pages | Component + E2e | `FunctionsListPage` shows empty state, table |
| User flows | E2e | Create form → submit → list shows new function |

## Component vs. Page Tests

Every component gets its own exhaustive test file. Every page gets its own test file that tests the page's orchestration and integration with its components.

**Component tests** cover:

- Rendering based on props (all states and variants)
- User interactions that trigger callbacks (clicks, input, form validation)
- Internal state (expand/collapse, selection)

**Page tests** cover:

- Component is present on the page and wired correctly
- Data flows from hooks/services to components (correct props)
- User actions that trigger cross-component effects or service calls (e.g., form submit calls service, then navigates)
- Page-level states: loading, error, empty

Overlap between component tests and page tests is expected and acceptable. They test at different levels: component tests verify the component works in isolation, page tests verify the page's orchestration logic works correctly.

## Testing Best Practices

1. **User-Centric Testing** — Test what users see and interact with.
   Do NOT test: internal component state, private methods, props passed to children, CSS class names, component structure.

2. **Accessibility-First** — Prefer role-based queries (`getByRole`) over generic selectors (`getByTestId`).

3. **Async-Aware** — Handle async updates with `findBy*` and `waitFor`.

4. **TypeScript Safety** — Use proper types for props, state, and mock data.

5. **Arrange-Act-Assert (AAA)** — Structure every test:
   - **Arrange:** Render component with mocks
   - **Act:** Perform user actions
   - **Assert:** Verify expected state

6. **Scoping** — Place beforeEach, afterEach, and afterAll inside describe blocks.

## Mocking Patterns

MSW is the primary approach. `vi.mock` is rare (see Mock Strategy above).

Use ESM `import` at top of file. Never use `require('react')` or `React.createElement()` in mocks.
Keep mocks simple.

**Correct patterns (for the rare `vi.mock` cases):**

```typescript
// Return null
vi.mock('../MyComponent', () => () => null);

// Return string
vi.mock('../LoadingSpinner', () => () => 'Loading...');

// Return children directly
vi.mock('../Wrapper', () => ({ children }) => children);

// Track calls with vi.fn
vi.mock('../ButtonBar', () => vi.fn(({ children }) => children));

// Mock framework hooks
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
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

**Clean up mocks:**

```typescript
afterEach(() => {
  vi.restoreAllMocks();
});
```

## E2e Conventions

E2e tests run against a real OpenShift cluster. GitHub API calls are intercepted with `page.route()` mocks, while K8s API calls go to the real cluster. Each test file covers a single use case, exercising a flow from start to finish with `test.step` for structure.

### Prerequisites

- A running OpenShift cluster with the plugin deployed (or a local dev environment via `init.sh`)
- The OpenShift Serverless operator should be installed on the cluster (tests install it automatically, but first install takes several minutes)

### Environment

`playwright.config.ts` auto-loads `.env` from the project root.

| Variable | Purpose | Required |
|----------|---------|----------|
| `BRIDGE_BASE_ADDRESS` | Console URL (default: `http://localhost:9000`) | No |
| `BRIDGE_KUBEADMIN_PASSWORD` | Cluster login password | Only when auth is enabled |

### Running

```bash
yarn test:e2e                                          # all tests, headless
yarn test:e2e e2e/use-cases/creation/                  # one use-case directory
yarn test:e2e e2e/use-cases/delete/function-delete.test.ts  # single file
yarn test:e2e:headed                                   # visible browser
yarn test:e2e:ui                                       # interactive UI mode
yarn test:e2e:report                                   # open HTML report
```

### File Structure

```
e2e/
  auth.setup.ts                    # Playwright login setup (saves storageState)
  fixtures/
    authenticated-page.ts          # Custom test fixture: injects GitHub mock + PAT
  helpers/
    cluster.ts                     # K8s API helpers (namespace, operator, deploy)
    navigation.ts                  # Page navigation helpers
    ui.ts                          # Dialog dismissal, loading spinners
  mocks/
    github.ts                      # Stateful GitHub API mock (page.route)
  use-cases/
    creation/                      # Create function tests
    delete/                        # Delete/undeploy function tests
```

### Fixtures and Mocks

Tests import `test` and `expect` from `e2e/fixtures/authenticated-page.ts`, not from `@playwright/test` directly. The fixture automatically installs the GitHub API mock and injects a placeholder PAT into sessionStorage before each test.

The GitHub mock (`e2e/mocks/github.ts`) is stateful. It maintains seed repos and tracks dynamically created repos through the full `createRepoWithSecret` flow. It exports two constants used by tests:

- `EXISTING_FUNC_NAME` ('test-func'): a seed repo, used by delete tests
- `NEW_FUNC_NAME` ('new-test-func'): used by create tests

### Helpers

**Navigation** (`e2e/helpers/navigation.ts`)

| Helper | Purpose |
|--------|---------|
| `navigateToFunctionsList(page)` | Go to `/faas`, dismiss dialogs, wait for load |
| `navigateToFunctionsTable(page)` | Navigate to list and wait for the functions grid |
| `navigateToCreatePage(page)` | Go to `/faas/create` |
| `navigateToEditPage(page, repoName?)` | Go to edit page directly or via list table |

**Cluster** (`e2e/helpers/cluster.ts`)

| Helper | Purpose |
|--------|---------|
| `k8sHeaders(page)` | Get CSRF token headers for K8s API calls |
| `ensureNamespace(page, name)` | Create namespace if it doesn't exist (waits for terminating namespaces) |
| `simulateGitHubActionsDeploy(page, name, ns)` | Create a ksvc and patch the deployment label to simulate `func deploy` |
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
|---------------|-----------|-----|
| Table (sortable/interactive) | `role="grid"` | `getByRole('grid')`, not `getByRole('table')` |
| Button with `component="a"` | `<a>` with `role="link"` | `getByRole('link')`, not `getByRole('button')` |
| Modal backdrop (stacked) | Intercepts pointer events | `evaluate((el: HTMLElement) => el.click())` to bypass |

**Use `exact: true`** when a name is a substring of other elements (e.g., "Name" matches "Namespace").

### Playwright Route LIFO Ordering

Playwright evaluates `page.route()` handlers in LIFO (last-in, first-out) order. Routes registered last are checked first. When a test needs to override the GitHub mock catch-all (e.g., for the duplicate-name error test), register the override after the fixture has set up the catch-all.

### Auth

Login is handled by `e2e/auth.setup.ts`, which saves session state via Playwright's `storageState`. The authenticated-page fixture then injects the GitHub mock and PAT on top of that session.

### Test file template

```typescript
import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { EXISTING_FUNC_NAME as FUNC_NAME } from '../../mocks/github';

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

### Creating new e2e tests

Use the `/e2e <feature-name>` slash command to scaffold tests. It reads the feature source code, proposes test cases, scaffolds the file, and debugs failures using Playwright MCP.

---

## Backend (Go)

Ginkgo v2 + Gomega for specs. `net/http/httptest` for faking HTTP dependencies. No other third-party test libraries.

### Mock Strategy

`httptest.NewServer` is the Go equivalent of MSW — a real local TCP server returning canned JSON. Use it for anything that makes an HTTP call (GitHub API, K8s API). Never mock at the interface level for network calls.

Tests live in the same package as the code (`package cluster`, not `package cluster_test`) for white-box access. Each package has a `suite_test.go` that registers the Ginkgo runner.

### Spec pattern

```go
var _ = Describe("POST /api/v1/auth/login", func() {
    It("validates the GitHub token and returns the user identity", func() {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
        }))
        DeferCleanup(srv.Close)

        h := &Handlers{githubBaseURL: srv.URL}
        // ... act and assert
        Expect(w.Code).To(Equal(http.StatusOK))
        Expect(resp.Login).To(Equal("alice"))
    })
})
```

Use `DeferCleanup(srv.Close)` — not `defer`. For handlers, spin up one server per dependency (`githubBaseURL`, `k8sBaseURL`).

### Tests are use cases

Each `It(...)` describes a behaviour from the caller's perspective. The description says **what the system does**, not which function was called.

```
// Bad — method-focused
It("TestCreateBlob_HappyPath")

// Good — use case
It("commits all files to the branch")
```

Use `DescribeTable` / `Entry` for validation and error variants to keep them concise.

### Rules

- `It(...)` descriptions are use cases, not method names
- Every use case needs at minimum: the success path + the main failure path
- Test behaviour, not call counts
- Keep fake servers inline — no shared mock fixtures

### Running

```bash
make test-backend
```
