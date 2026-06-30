---
allowed-tools: Read, Write, Edit, Bash(npx playwright test*), Bash(yarn test:e2e*), Bash(grep *), Bash(find *), mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_take_screenshot, mcp__playwright__browser_console_messages, mcp__playwright__browser_click, mcp__playwright__browser_close
description: Scaffold and debug Playwright e2e smoke tests for a feature
---

# Create E2E Smoke Tests

Scaffold Playwright e2e tests for `$ARGUMENTS`. If no argument is provided, ask the user which feature to test.

## Steps

1. **Learn the patterns** -- read these files to internalize the project's e2e conventions:

   - `e2e/helpers.ts` (all helper functions)
   - `e2e/smoke/function-list.test.ts` (reference test file)
   - `docs/TESTING.md` (E2e Conventions section)

2. **Understand the feature** -- find and read the feature's source code:

   ```bash
   find src/pages -type f -name "*.tsx" | grep -i "$ARGUMENTS"
   ```

   Read the page components, form components, and any service files related to the feature. Understand:
   - What routes/URLs the feature uses
   - What user-visible elements exist (headings, buttons, forms, tables)
   - What API calls it makes (GitHub, K8s)

3. **Propose test cases** -- present a list of smoke test cases to the user. Keep tests focused on user-visible behavior, not implementation details. Example categories:
   - Page loads and displays heading
   - Key UI elements are visible
   - Navigation works (links, buttons, back)
   - Form validation (required fields, submit disabled/enabled)
   - Do NOT test internal state or API response shapes

   Wait for user approval before writing code.

4. **Scaffold the test file** at `e2e/smoke/$ARGUMENTS.test.ts` following these conventions:

   **Imports and setup:**
   ```typescript
   import { test, expect } from '@playwright/test';
   import { loadFunctionsList, dismissDialogs, ... } from '../helpers';

   const pat = process.env.BRIDGE_GITHUB_PAT ?? '';

   test.describe('Feature name', () => {
     test.skip(!pat, 'BRIDGE_GITHUB_PAT not set');
     // tests...
   });
   ```

   **Selector rules (critical):**
   - Accessible selectors first: `page.getByRole()`, `page.getByText()`, `page.getByLabel()`
   - Use `exact: true` when a name could match other elements (e.g., `{ name: 'Name', exact: true }` to avoid matching "Namespace")
   - PF6 tables render as `role="grid"`, NOT `role="table"`
   - PF6 Button with `component="a"` renders as `role="link"`, NOT `role="button"`
   - Use `page.locator('#id')` for form inputs with HTML `id` attributes
   - Never add `data-test` attributes to production components

   **Navigation and dialog handling:**
   - Use helpers: `navigateToFunctionsList(page)`, `loadFunctionsList(page)`, `loadFunctionsListWithRealPat(page, pat)`
   - After any `page.goto()` + `page.reload()` sequence, call `dismissDialogs(page)`
   - For custom navigation, follow this pattern:
     ```typescript
     await page.goto('/faas/your-route');
     await injectRealGitHubPat(page, pat);
     await page.reload();
     await dismissDialogs(page);
     ```

   **Multi-step tests:** use `test.step()`:
   ```typescript
   test('completes a full flow', async ({ page }) => {
     await test.step('navigate to page', async () => { ... });
     await test.step('fill form', async () => { ... });
     await test.step('verify result', async () => { ... });
   });
   ```

5. **Run the tests:**

   ```bash
   yarn test:e2e e2e/smoke/$ARGUMENTS.test.ts
   ```

6. **Debug failures** -- when a test fails:

   a. Read the error message and screenshot from `.e2e/results/`
   b. Use Playwright MCP to inspect the live page:
      - `browser_navigate` to the URL
      - `browser_snapshot` to see the accessibility tree (shows actual roles and names)
      - `browser_console_messages` to check for errors
      - `browser_take_screenshot` for visual state
   c. Common fixes:
      - "strict mode violation" -- add `exact: true` or use a more specific locator
      - "element not found" -- check `browser_snapshot` for the actual role/name
      - Click intercepted by overlay -- use `evaluate((el: HTMLElement) => el.click())`
      - Dialog blocking content -- ensure `dismissDialogs(page)` is called after navigation

7. **Iterate** until all tests pass. Run the full suite once at the end:

   ```bash
   yarn test:e2e
   ```

## Rules

- Never add `data-test` attributes to production source code
- Always use `exact: true` for ambiguous names
- Always call `dismissDialogs` after page navigation + reload
- Tests that need GitHub API must have `test.skip(!pat)` guard
- Keep tests focused on smoke-level validation, not exhaustive coverage
- Review `e2e/helpers.ts` before writing setup code. If a helper already exists for your navigation pattern, use it. If you find yourself repeating setup across multiple tests, extract a new helper or use `test.beforeEach` in a nested `test.describe`
- Minimize code repetition: shared setup belongs in `test.beforeEach`, reusable navigation belongs in `e2e/helpers.ts`
- After adding or updating helpers, reconcile `docs/TESTING.md` (Helpers table in the E2e Conventions section) so the reference stays accurate
