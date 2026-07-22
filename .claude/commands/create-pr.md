---
allowed-tools: Bash(bash hack/pre-pr-check.sh 2>&1), Bash(git diff upstream/master*), Bash(git push -u origin HEAD), Bash(gh pr create *), Bash(jira issue move *), Read, Agent, Skill(superpowers:requesting-code-review), Skill(superpowers:requesting-code-review:*), Bash(jira issue view *)
description: Create a PR from the PR template
---

# Create PR

Create a pull request using the project's PR template and conventions.

## Steps

1. **Run pre-PR checks** -- run `hack/pre-pr-check.sh` and read the output.
   - If the script exits non-zero, it will print a `BLOCKER:` line. Show it to the user and stop.
   - If it passes, extract `issue_key` and `branch` from the output.
   - Check if `superpowers:requesting-code-review` skill is available. If not, tell the user to run `/plugin install superpowers@claude-plugins-official` and `/reload-plugins`, then re-run `/create-pr`.

2. **Read the full diff** -- run `git diff upstream/master...HEAD` to get the complete diff for analysis.

3. **Validate Jira against diff** -- run `jira issue view <issue_key>` to fetch the Jira issue details, then:
   - **Check description:** if the description is empty or null, stop and tell the user to add a description to the Jira issue before creating the PR. If present, verify each actionable point in the description is addressed by the committed changes (diff). List each point with a pass/fail status. If any points are not met, inform the user and ask if they want to continue anyway.
   - **Check acceptance criteria:** if the acceptance criteria field is empty or null, note it but continue (not a blocker). If present, verify each criterion is satisfied by the committed changes (diff). List each criterion with a pass/fail status. If any criteria are not met, inform the user and ask if they want to continue anyway.

4. **Code review + test coverage check** -- spawn two agents **in parallel** (send both Agent calls in a single message). Wait for both to complete before continuing.

   **Agent 1: Code Review** -- spawn with description "PR code review" and this prompt:
   > You are reviewing a PR for correctness and quality. Do NOT edit any files.
   >
   > 1. Invoke the `superpowers:requesting-code-review` skill to review the diff.
   > 2. Then critically self-review every finding:
   >    - For each finding, ask: "What would actually break if we shipped this?"
   >    - If the answer is "nothing" or "maybe something in theory", mark it as imaginary.
   >    - Separate real issues (bugs, security, incorrect logic) from imaginary ones (theoretical concerns, style preferences).
   > 3. Return only the findings that survived self-review, with severity and file:line references.

   **Agent 2: Test Coverage Check** -- spawn with description "PR test coverage check" and this prompt:
   > You are checking test coverage for a PR. Do NOT edit any files.
   >
   > 1. Read `docs/TESTING.md` for the project's testing conventions and file location rules.
   > 2. Run `git diff upstream/master...HEAD --name-only --diff-filter=AM` to get new and modified files.
   > 3. For each source file (skip types, constants, config, docs, and test files themselves), use the file conventions from TESTING.md to determine the expected test file location:
   >    - Components (`src/**/components/*.tsx`): expect a sibling `.test.tsx` file
   >    - Pages (`src/pages/<name>/*.tsx`): expect a sibling `.test.tsx` file
   >    - Services, hooks, utils (`src/common/**/*.ts` or `.tsx`): expect a sibling `.test.ts` or `.test.tsx` file
   >    - New user-facing features: check whether an e2e spec exists under `e2e/`
   > 4. Return a markdown table: | Source file | Expected test file | Found |
   >    Mark each row yes/no. At the end, list any source files missing tests.

   After both agents complete, present their results to the user:
   - If the code review found any **critical** findings, stop and tell the user to fix them before creating the PR.
   - If the code review found **important** findings, list them and ask if the user wants to fix them first or continue.
   - Minor findings are shown for awareness but do not block.
   - If the test coverage check found missing tests, tell the user which files need tests and ask if they want to continue anyway or write the tests first.

5. **Read the PR template** at `.github/pull_request_template.md`.

6. **Draft the PR** -- analyze ALL commits and the full diff, then draft:
   - **Title:** `<JIRA-ID>: <Sentence>`. Include the Jira issue key from the branch name. Capitalize the first word. Do not end with a period. No type prefix (conventional commit types belong in commit messages, not PR titles). No em dashes.
   - **Body:** Fill in the PR template. Replace the placeholder bullets with a concise summary of what changed and why. Remove HTML comments from the filled-in template. Include a Jira ticket reference at the bottom using GitHub-style linking: `Fixes [SRVOCF-XXX](https://redhat.atlassian.net/browse/SRVOCF-XXX)` (or `Closes` / `Relates to` as appropriate).

7. **Show for approval** -- display the full draft (title + body) and ask the user to confirm or request changes. Do NOT create the PR until approved.

8. **Create the PR** -- once approved:
   - Push the branch if it has no upstream: `git push -u origin HEAD`
   - Create the PR: `gh pr create --title "<title>" --body "<body>" --base master --repo openshift/faas-console-plugin`
   - Use a HEREDOC for the body to preserve formatting.

9. **Update Jira** -- move the issue to "Code Review": `jira issue move <KEY> "Code Review"`

10. **Report** -- show the PR URL.

## Rules

- Analyze ALL commits in the branch, not just the latest one
- Never create the PR without showing the draft first
- No em dashes in title or body
- Follow the title format exactly: `<JIRA-ID>: <Sentence>` (no type prefix, no trailing period)
- Do NOT push to remote or create the PR until the user approves
