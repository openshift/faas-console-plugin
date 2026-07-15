# Workflow — func-console

## Startup Sequence

Handled by the `begin` command (`.claude/commands/begin.md`).

## Feature Development Sequence

After [Startup Sequence](#startup-sequence), work through the picked feature:

1. **Branch** — create feature branch per [Branching](#branching) convention. Immediately push and open a **draft PR** (`gh pr create --draft`) to reserve the PR number for other contributors' branch numbering.
2. **Plan** — read `docs/ARCHITECTURE.md` + `docs/STYLEGUIDE.md` + `docs/TESTING.md`, then design the feature and create implementation plan in `docs/plans/active/`
3. **Implement** — using `/executing-plans` skill
4. **Review** — code review using `/requesting-code-review` skill, fix found issues
5. **Manual Test** — use browser automation and validate it works in the browser
6. **Complete** — move plan to `docs/plans/completed/`, commit
7. **PR** — push branch, open PR per [Pull Requests](#pull-requests) convention
8. Stop — wait for PR review. Rework per [Received PR Reviews](#received-pr-reviews) when asked.

## Received PR Reviews

For each comment: read the full text and its diff hunk context, make the fix, then re-read the comment and verify your change actually matches what was asked (placement, naming, scope — not just compilation). Reply in the thread stating what changed.

## Branching

Format: `<JIRA-ID>-<short-description>`. Example: `SRVOCF-982-workflow-guide-cleanup`. If we're on a feature branch already do nothing.

## Pull Requests

Open PRs via `gh pr create` using the template at `.github/pull_request_template.md`.

**Title format:** `<Type>: <Sentence ending with a period.>` — capitalize the type and the first word, end with a period. Example: `Feat: Add function list page with empty state.`

Types are the same as [conventional commits](references/commit-message-guide.md#conventional-commits) but capitalized.

No em dashes (`—`) in PR titles or descriptions. Use commas, periods, or parentheses instead.

## Session Rules

- One feature at a time
- Clean state at end (code suitable for merging to main)
- Commit work to git before ending, follow [commit-message-guide.md](references/commit-message-guide.md) strictly
