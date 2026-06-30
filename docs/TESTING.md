# Testing — func-console

## Approach

Red/green/refactor TDD — **one test at a time**:

1. Write one test case (red)
2. Write the minimum implementation to make it pass (green)
3. Refactor if needed
4. Move to the next test case

Do NOT write all test cases first and then implement everything at once.

## Test Layers

| Layer | Tool | Scope |
|-------|------|-------|
| Unit / Component | Vitest + React Testing Library | Hooks, services, component rendering, form logic |
| E2e / Feature validation | Playwright | Validate features.json entries in real browser |
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
| E2e specs | `e2e/<feature-name>/*.test.ts` |
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

### Environment

`playwright.config.ts` auto-loads `.env` from the project root. Required variables:

| Variable | Purpose | Required |
|----------|---------|----------|
| `BRIDGE_GITHUB_PAT` | GitHub PAT with `repo` scope | Yes (tests skip without it) |
| `BRIDGE_BASE_ADDRESS` | Console URL (default: `http://localhost:9000`) | No |
| `BRIDGE_KUBEADMIN_PASSWORD` | Cluster login password | Only when auth is enabled |

### Running

```bash
yarn test:e2e                              # all tests, headless
yarn test:e2e e2e/smoke/my-feature.test.ts # single file
yarn test:e2e:headed                       # visible browser
yarn test:e2e:ui                           # interactive UI mode
yarn test:e2e:report                       # open HTML report
```

### Helpers (`e2e/helpers.ts`)

| Helper | Purpose |
|--------|---------|
| `navigateToFunctionsList(page)` | Go to `/faas`, inject PAT, reload, dismiss dialogs, wait for load |
| `loadFunctionsList(page)` | Alias for `navigateToFunctionsList` |
| `loadFunctionsListWithRealPat(page, pat)` | Same flow but with an explicit real PAT |
| `loadFunctionsTable(page)` | Navigate to list and wait for the functions grid to be visible |
| `loadCreatePage(page, pat)` | Navigate to `/faas/create`, inject real PAT, reload, dismiss dialogs |
| `injectGitHubPat(page)` | Auto-detect: uses real PAT from env if set, placeholder otherwise |
| `injectRealGitHubPat(page, pat)` | Validate PAT against GitHub API and store in sessionStorage |
| `dismissDialogs(page)` | Remove webpack overlay, dismiss PAT modal, dismiss guided tour |
| `waitForLoadingComplete(page)` | Wait for PF6 spinners and OCP loaders to disappear |
| `waitForTableOrEmpty(page)` | Wait for either the functions grid or "No functions found" heading |
| `robustClick(locator)` | Click with retry logic (3 attempts, exponential backoff) |
| `createButtonLocator(page)` | Locator for the create button (handles link/button/disabled variants) |

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

### Auth and PAT

- Login is handled by `e2e/auth.setup.ts`, which saves session state via Playwright's `storageState`
- Tests that need GitHub API must guard with `test.skip(!pat, 'BRIDGE_GITHUB_PAT not set')`
- After `page.goto()` + PAT injection + `page.reload()`, always call `dismissDialogs(page)`

### Test file template

```typescript
import { test, expect } from '@playwright/test';
import { loadFunctionsList, waitForTableOrEmpty } from '../helpers';

const pat = process.env.BRIDGE_GITHUB_PAT ?? '';

test.describe('My feature', () => {
  test.skip(!pat, 'BRIDGE_GITHUB_PAT not set');

  test('page loads and shows heading', async ({ page }) => {
    await loadFunctionsList(page);
    await expect(
      page.getByRole('heading', { name: 'My Feature', exact: true }),
    ).toBeVisible();
  });
});
```

### Creating new e2e tests

Use the `/e2e <feature-name>` slash command to scaffold tests. It reads the feature source code, proposes test cases, scaffolds the file, and debugs failures using Playwright MCP.
