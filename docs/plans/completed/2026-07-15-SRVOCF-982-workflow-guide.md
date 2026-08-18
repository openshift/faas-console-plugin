# SRVOCF-982: Workflow Guide Implementation Plan

**Goal:** Clean up PoC-era workflow artifacts, establish Jira-linked branch naming, and simplify slash commands.

**Jira:** [SRVOCF-982](https://redhat.atlassian.net/browse/SRVOCF-982) (Section 2 only)

**PR:** [#20](https://github.com/openshift/faas-console-plugin/pull/20) (merged 2026-07-22)

**Branch:** `SRVOCF-982-workflow-guide-part-1-cleanup`

---

## TODO

- [x] Task 1: Delete PoC artifact files and consolidate reference docs
- [x] Task 2: Remove PoC artifact references from project docs
- [x] Task 3: Simplify slash commands (begin/commit) and add hack scripts
- [x] Task 4: ~~Update `docs/WORKFLOW.md`~~ (superseded, file deleted per review)
- [ ] ~~Task 5: Write `docs/workflow-guide.md`~~ (dropped, workflow lives in slash commands)
- [ ] ~~Task 6: Branch name validation script~~ (moved to [2026-07-22 plan](../active/2026-07-22-SRVOCF-982-ci-chatops-husky.md))
- [ ] ~~Task 7: Add branch name lint to Husky pre-push hook~~ (moved to [2026-07-22 plan](../active/2026-07-22-SRVOCF-982-ci-chatops-husky.md))
- [ ] ~~Task 8: Add branch name and commit message lint to CI~~ (moved to [2026-07-22 plan](../active/2026-07-22-SRVOCF-982-ci-chatops-husky.md))

---

## Task 1: Delete PoC artifact files and consolidate reference docs

Deleted 12 files:

```
docs/agent-struggles.json
docs/features.json
docs/potential-features.json
docs/claude-progress.txt
docs/references/agent-struggles-readme.md
docs/references/claude-progress-readme.md
docs/references/features-json-readme.md
docs/references/commit-message-guide.md
docs/references/ocp-console-dynamic-plugin-guide.md
docs/references/ocp-dynamic-plugins-summary.md
docs/references/ocp-plugin-guide.md
hack/next-plan-number.sh
```

Created `docs/references/ocp-dynamic-plugin-reference.md` consolidating the three OCP plugin guides into one reference doc. Fixed i18n namespace to match ConsolePlugin name (`console-functions-plugin`).

---

## Task 2: Remove PoC artifact references from project docs

Updated:
- `AGENTS.md`: removed knowledge base rows for deleted files
- `docs/TESTING.md`: replaced "Validate features.json entries" with "Validate user flows in real browser"
- `docs/STYLEGUIDE.md`: added consoleFetch rule
- `.github/pull_request_template.md`: added architecture update checklist
- `README.md`: added Jira CLI to prerequisites

Deleted `docs/WORKFLOW.md` entirely (superseded by slash commands).

---

## Task 3: Simplify slash commands (begin/commit) and add hack scripts

Slash command changes:
- Deleted `.claude/commands/init-session.md`, replaced with `.claude/commands/begin.md`
- Deleted `.claude/commands/session-commit.md`, replaced with `.claude/commands/commit.md`
- Deleted `.claude/commands/commit-user.md` (redundant)
- Synced `.pi/prompts/` symlinks (added begin.md, commit.md, e2e.md; deleted init-session.md, session-commit.md, commit-user.md)

New hack scripts:
- `hack/branch.sh`: Jira-linked branch naming with auto-checkout, `--dry-run` support, same-ticket/different-ticket detection
- `hack/read-ticket.sh`: reads Jira tickets, recommends action based on refinement status
- `hack/parse-commit-args.sh`: parses `--dry-run` and Jira ticket arguments for the commit command
- `hack/update-pi-prompt-symlinks.sh`: syncs `.pi/prompts/` symlinks from `.claude/commands/`

---

## ~~Task 4: Update `docs/WORKFLOW.md`~~

Superseded: WORKFLOW.md was deleted entirely per PR review feedback. Workflow logic lives in the slash commands (begin, commit, create-pr) instead.

---

## ~~Task 5: Write `docs/workflow-guide.md`~~

Dropped. The workflow is captured by the slash commands themselves (`begin.md`, `commit.md`, `create-pr.md`). A separate guide would duplicate what's already executable.

---

## ~~Tasks 6, 7, 8: Branch name lint, pre-push hook, CI lint~~

Moved to [2026-07-22-SRVOCF-982-ci-chatops-husky.md](../active/2026-07-22-SRVOCF-982-ci-chatops-husky.md) as Tasks 3, 4, and related CI work.
