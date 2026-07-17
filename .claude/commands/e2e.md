---
allowed-tools: Read, Write, Edit, Bash(npx playwright test*), Bash(yarn test:e2e*), Bash(grep *), Bash(find *), Bash(npx tsc*), mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_take_screenshot, mcp__playwright__browser_console_messages, mcp__playwright__browser_click, mcp__playwright__browser_close
description: Scaffold and debug Playwright e2e tests for a feature
---

# Create E2E Tests

Scaffold Playwright e2e tests for `$ARGUMENTS`. If no argument is provided, ask the user which feature or use case to test.

Start by reading `docs/TESTING.md` (E2e Conventions section) for the full reference on file structure, fixtures, helpers, selectors, and patterns.

## Steps

1. **Learn the patterns** -- read these files to internalize the project's e2e conventions:

   - `docs/TESTING.md` (E2e Conventions section, read first)
   - `e2e/fixtures/authenticated-page.ts` (custom test fixture with GitHub mock + PAT injection)
   - `e2e/mocks/github.ts` (stateful GitHub API mock)
   - `e2e/helpers/navigation.ts` (page navigation helpers)
   - `e2e/helpers/cluster.ts` (K8s API helpers: namespace, operator, deploy)
   - `e2e/helpers/ui.ts` (dialog dismissal, loading spinners)
   - `e2e/use-cases/creation/create-go-function.test.ts` (reference: happy path with deploy verification)
   - `e2e/use-cases/delete/function-delete.test.ts` (reference: serial tests with cluster assertions)

2. **Understand the feature** -- find and read the feature's source code:

   ```bash
   find src/pages -type f -name "*.tsx" | grep -i "$ARGUMENTS"
   ```

   Read the page components, form components, and any service files related to the feature. Understand:
   - What routes/URLs the feature uses
   - What user-visible elements exist (headings, buttons, forms, tables)
   - What API calls it makes (GitHub, K8s)

3. **Propose test cases** -- present a list of e2e test cases to the user. Keep tests focused on user-visible behavior, not implementation details. A use-case test is executed from start to finish, verifying all expected visible elements and values. Example categories:
   - Happy path (complete user flow from start to finish)
   - Error path (validation failures, duplicate names, API errors)
   - Cancel/abort path (user cancels midway, no side effects)
   - Do NOT test internal state or API response shapes

   Wait for user approval before writing code.

4. **Scaffold the test file** at `e2e/use-cases/<feature>/<name>.test.ts` following these conventions.

   **Imports and setup:**
   ```typescript
   import { test, expect } from '../../fixtures/authenticated-page';
   import { navigateToFunctionsList } from '../../helpers/navigation';
   import { EXISTING_FUNC_NAME as FUNC_NAME } from '../../mocks/github';

   test.describe('Feature name', () => {
     test('user does something', async ({ page }) => {
       await navigateToFunctionsList(page);
     });
   });
   ```

   The `authenticated-page` fixture automatically:
   - Installs the stateful GitHub API mock (`page.route()`)
   - Injects a placeholder PAT into sessionStorage

   **Selector rules (critical):**
   - Accessible selectors first: `page.getByRole()`, `page.getByText()`, `page.getByLabel()`
   - Use `exact: true` when a name could match other elements (e.g., `{ name: 'Name', exact: true }` to avoid matching "Namespace")
   - PF6 tables render as `role="grid"`, NOT `role="table"`
   - PF6 Button with `component="a"` renders as `role="link"`, NOT `role="button"`
   - Use `page.locator('#id')` for form inputs with HTML `id` attributes
   - Never add `data-test` attributes to production components

   **Function names:**
   - Use `EXISTING_FUNC_NAME` from `e2e/mocks/github.ts` for tests that need a seed repo (list, delete)
   - Use `NEW_FUNC_NAME` from `e2e/mocks/github.ts` for tests that create new functions

   **Namespaces:**
   - Use distinct namespaces per test group to avoid cluster state collisions (e.g., `create-test`, `delete-test`)
   - Call `ensureNamespace(page, NAMESPACE)` before any K8s operations

   **Multi-step tests:** use `test.step()`:
   ```typescript
   test('completes a full flow', async ({ page }) => {
     await test.step('navigate to page', async () => { ... });
     await test.step('fill form', async () => { ... });
     await test.step('verify result', async () => { ... });
   });
   ```

   **Overriding the GitHub mock:**
   Playwright evaluates `page.route()` in LIFO order. The fixture registers the catch-all mock first. To override a specific endpoint, register a more specific route in the test (it wins because it's registered later):
   ```typescript
   await page.route('https://api.github.com/repos/*/*', (route) => {
     if (route.request().method() === 'GET') {
       return route.fulfill({ json: { name: FUNC_NAME, default_branch: 'main' } });
     }
     return route.continue();
   });
   ```

5. **Type check and run the tests:**

   ```bash
   npx tsc --noEmit -p e2e/tsconfig.json
   yarn test:e2e e2e/use-cases/<feature>/
   ```

6. **Debug failures** -- when a test fails:

   a. Read the error context from `.e2e/results/` (includes accessibility snapshot)
   b. Use Playwright MCP to inspect the live page:
      - `browser_navigate` to the URL
      - `browser_snapshot` to see the accessibility tree (shows actual roles and names)
      - `browser_console_messages` to check for errors
      - `browser_take_screenshot` for visual state
   c. Common fixes:
      - "strict mode violation" -- add `exact: true` or use a more specific locator
      - "element not found" -- check `browser_snapshot` for the actual role/name
      - Click intercepted by overlay -- use `evaluate((el: HTMLElement) => el.click())`
      - Namespace "is being terminated" -- `ensureNamespace` handles this automatically (waits for termination)
      - Operator install timeout -- the Serverless operator takes several minutes on first install

7. **Iterate** until all tests pass. Run the full suite once at the end:

   ```bash
   yarn test:e2e
   ```

## Rules

- Always import `test` and `expect` from `../../fixtures/authenticated-page`, not from `@playwright/test`
- Never add `data-test` attributes to production source code
- Always use `exact: true` for ambiguous names
- Use-case tests exercise a complete flow from start to finish, verifying all expected visible elements and values
- Keep individual tests focused on user-visible behavior
- Use function name constants from `e2e/mocks/github.ts` instead of hardcoding strings
- Use distinct namespaces per test group to avoid cluster state collisions
- After adding or updating helpers, reconcile `docs/TESTING.md` (E2e Conventions section)
