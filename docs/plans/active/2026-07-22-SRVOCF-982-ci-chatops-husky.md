# SRVOCF-982: CI, ChatOps, and Husky

**Jira:** [SRVOCF-982](https://redhat.atlassian.net/browse/SRVOCF-982)

**Branch:** `SRVOCF-982-workflow-unification-development-guidelines-and-tooling`

---

## TODO

- [x] Task 1: Replace commit-msg hook with commitlint
- [x] Task 2: Add log indicators to Husky hooks
- [x] Task 3: Make install-frontend skip when up to date
- [ ] Task 4: Add ChatOps section to README
- [ ] Task 5: Gather openshift/release fixes needed
- [ ] Task 6: Update JIRA ticket with what we done here and what was done in other PRs from Robert

---

## Task 4: Add ChatOps section to README

Add after the Slash Commands table:

```markdown
## ChatOps

PRs merge via [Prow](https://docs.ci.openshift.org/) when they have both `approved` and `lgtm` labels.

| Command | What it does |
|---------|--------------|
| `/lgtm` | Approve for merge (or use GitHub review approval) |
| `/approve` | OWNERS approval (cannot self-approve) |
| `/hold` | Block merge |
| `/retest` | Re-run failed CI jobs |
| `/test e2e` | Run a specific CI job |

[All available commands for this repo](https://go.k8s.io/bot-commands?repo=openshift%2Ffaas-console-plugin)
```

---

## Task 5: Gather openshift/release fixes needed

No code. Checklist for the team to act on.

### Already in flight (David)

- [PR #81410](https://github.com/openshift/release/pull/81410) (open): Add Playwright e2e job
- [PR #82710](https://github.com/openshift/release/pull/82710) (open): Remove misconfigured promotion + version variants

### Still needed

- [ ] **Fix self-approval:** Change `require_self_approval: false` to `true` in `core-services/prow/02_config/openshift/faas-console-plugin/_pluginconfig.yaml`
- [ ] **Add type-check to Prow lint job:** Current step runs `yarn install && yarn run lint && yarn run build`. Consider adding `yarn type-check` or switching to `make lint type-check build-frontend`.
