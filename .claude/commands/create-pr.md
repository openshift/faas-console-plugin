---
allowed-tools: Bash(git branch *), Bash(git log *), Bash(git diff *), Bash(git status *), Bash(git rev-parse *), Bash(git fetch *), Bash(git merge-base *), Bash(git merge-tree *), Bash(git push *), Bash(gh pr list *), Bash(gh pr create *), Read, Agent, mcp__jira__jira_get
description: Create a PR from the PR template
---

# Create PR

Create a pull request using the project's PR template and conventions.

## Steps

1. **Gather context** -- fetch upstream first, then run the rest in parallel:
   - Fetch the latest upstream: `git fetch openshift master`
   - `git branch --show-current`
   - `git log --oneline openshift/master..HEAD`
   - `git diff openshift/master...HEAD --stat`
   - `git diff openshift/master...HEAD`
   - `git status`
   - Check if the branch already tracks a remote: `git rev-parse --abbrev-ref @{upstream} 2>/dev/null`
   - Check for existing PR: `gh pr list --head <BRANCH> --state open --repo openshift/faas-console-plugin` (substitute the branch name from above, no command substitution)

2. **Abort if not ready:**
   - If on `master`, stop and tell the user to create a feature branch first.
   - If there are uncommitted changes, stop and suggest running `/session-commit` first.
   - If a PR already exists for this branch, show the URL and stop.

3. **Check branch is up to date and conflict-free** against `openshift/master`:
   - Check if the branch contains all commits from `openshift/master`: run `git merge-base --is-ancestor openshift/master HEAD` and check the exit code directly (do not append echo or other commands). If it exits non-zero, the branch is behind. Stop and tell the user to rebase onto `openshift/master` first.
   - Check for merge conflicts: run `git merge-tree openshift/master HEAD` and inspect the output. If it contains conflict markers, stop and tell the user there are merge conflicts with `openshift/master` that need to be resolved first.

4. **Validate Jira issue** -- extract the Jira issue key from the branch name (e.g. `SRVOCF-990` from `SRVOCF-990--templates-readme`). The key is always the leading segment before the first `--`.
   - If no issue key is found, stop and tell the user the branch name must start with a Jira issue key.
   - Fetch the issue from Jira using `jira_get` with path `/rest/api/3/issue/<KEY>` and jq `{summary: fields.summary, description: fields.description, acceptance: fields.customfield_10037}`. If `customfield_10037` returns nothing, retry with jq `fields` and look for a field whose name contains "acceptance".
   - **Check description:** if the description is empty or null, stop and tell the user to add a description to the Jira issue before creating the PR. If present, verify each actionable point in the description is addressed by the committed changes (diff). List each point with a pass/fail status. If any points are not met, inform the user and ask if they want to continue anyway.
   - **Check acceptance criteria:** if the acceptance criteria field is empty or null, note it but continue (not a blocker). If present, verify each criterion is satisfied by the committed changes (diff). List each criterion with a pass/fail status. If any criteria are not met, inform the user and ask if they want to continue anyway.

5. **Code review + test coverage check** -- spawn two agents **in parallel** (send both Agent calls in a single message). Wait for both to complete before continuing.

   **Agent 1: Code Review** -- spawn with description "PR code review" and this prompt:
   > You are reviewing a PR diff for correctness and quality. Do NOT edit any files.
   >
   > 1. Read `docs/ARCHITECTURE.md` for the project's layered architecture and dependency rules.
   > 2. Read `docs/STYLEGUIDE.md` for the project's style conventions.
   > 3. Run `git diff openshift/master...HEAD` to get the full diff.
   > 4. Review the diff for:
   >    - Architecture violations per `docs/ARCHITECTURE.md` (layer boundaries, dependency direction, import rules)
   >    - Correctness bugs (logic errors, off-by-ones, null/undefined mishandling, missing error handling at system boundaries)
   >    - Style violations per `docs/STYLEGUIDE.md` (naming, formatting, import order)
   >    - Security concerns (injection, XSS, secrets in code)
   >    - Dead code, unused imports, or leftover debugging statements
   > 5. Return your findings as a markdown table: | Severity | Category | File | Line | Description |
   >    Severity levels:
   >    - **critical** -- must fix before merge (security vulnerabilities, data loss, crashes)
   >    - **high** -- should fix before merge (correctness bugs, architecture violations)
   >    - **medium** -- worth fixing (style violations, minor architecture concerns, dead code)
   >    - **low** -- nitpicks (naming preferences, formatting suggestions)
   >    Sort by severity (critical first). If no findings, say "No issues found."

   **Agent 2: Test Coverage Check** -- spawn with description "PR test coverage check" and this prompt:
   > You are checking test coverage for a PR. Do NOT edit any files.
   >
   > 1. Read `docs/TESTING.md` for the project's testing conventions and file location rules.
   > 2. Run `git diff openshift/master...HEAD --name-only --diff-filter=AM` to get new and modified files.
   > 3. For each source file (skip types, constants, config, docs, and test files themselves), use the file conventions from TESTING.md to determine the expected test file location:
   >    - Components (`src/**/components/*.tsx`): expect a sibling `.test.tsx` file
   >    - Pages (`src/pages/<name>/*.tsx`): expect a sibling `.test.tsx` file
   >    - Services, hooks, utils (`src/common/**/*.ts` or `.tsx`): expect a sibling `.test.ts` or `.test.tsx` file
   >    - New user-facing features: check whether an e2e spec exists under `e2e/`
   > 4. Return a markdown table: | Source file | Expected test file | Found |
   >    Mark each row yes/no. At the end, list any source files missing tests.

   After both agents complete, present their results to the user:
   - If the code review found any **critical** findings, stop and tell the user to fix them before creating the PR.
   - If the code review found **high** findings, list them and ask if the user wants to fix them first or continue.
   - **Medium** and **low** findings are shown for awareness but do not block.
   - If the test coverage check found missing tests, tell the user which files need tests and ask if they want to continue anyway or write the tests first.

6. **Read the PR template** at `.github/pull_request_template.md`.

7. **Draft the PR** -- analyze ALL commits and the full diff, then draft:
   - **Title:** `<Type>: <Sentence ending with a period.>` per `docs/WORKFLOW.md`. Capitalize the type and the first word after the colon. End with a period. No em dashes.
   - **Body:** Fill in the PR template. Replace the placeholder bullets with a concise summary of what changed and why. Include `Relates to <ISSUE-KEY>` (from the branch name) at the bottom. Remove HTML comments from the filled-in template.

8. **Show for approval** -- display the full draft (title + body) and ask the user to confirm or request changes. Do NOT create the PR until approved.

9. **Create the PR** -- once approved:
   - Push the branch if it has no upstream: `git push -u origin HEAD`
   - Create the PR: `gh pr create --title "<title>" --body "<body>" --base master --repo openshift/faas-console-plugin`
   - Use a HEREDOC for the body to preserve formatting.

10. **Report** -- show the PR URL.

## Rules

- Analyze ALL commits in the branch, not just the latest one
- Never create the PR without showing the draft first
- No em dashes in title or body
- Follow the title format exactly: `<Type>: <Sentence.>` (capitalized)
- Types: Feat, Fix, Refactor, Docs, Test, Chore, Style, Perf, CI, Build
- Do NOT push to remote or create the PR until the user approves
