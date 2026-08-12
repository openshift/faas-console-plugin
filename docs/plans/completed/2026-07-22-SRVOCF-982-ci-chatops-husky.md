# SRVOCF-982: CI, ChatOps, and Husky

**Jira:** [SRVOCF-982](https://redhat.atlassian.net/browse/SRVOCF-982)

**Branch:** `SRVOCF-982-workflow-unification-development-guidelines-and-tooling`

---

## TODO

- [x] Task 1: Replace commit-msg hook with commitlint
- [x] Task 2: Add log indicators to Husky hooks
- [x] Task 3: Make install-frontend skip when up to date
- [x] Task 4: Add ChatOps section to README
- [x] Task 5: Add commitlint to CI via make lint
- [x] Task 6: Optimize pre-commit to skip unchanged areas
- [x] Task 7: Fix empty commit message abort in commit-msg hook
- [ ] Task 8: Gather openshift/release fixes needed
- [ ] Task 9: Update JIRA ticket

---

## Task 8: Gather openshift/release fixes needed

No code. Checklist for the team to act on.

### Done

- [PR #80694](https://github.com/openshift/release/pull/80694) (merged): Initial Prow setup (lint + unit)
- [PR #80906](https://github.com/openshift/release/pull/80906) (merged): Set squash merge
- [PR #82710](https://github.com/openshift/release/pull/82710) (merged): Remove misconfigured promotion + version variants
- [PR #82896](https://github.com/openshift/release/pull/82896) (merged): Update CI to Dockerfile.buildroot, make targets, add e2e-aws
- [PR #83028](https://github.com/openshift/release/pull/83028) (open): Add trusted apps (Konflux, merge-bot)

### Still needed

- [ ] **Fix self-approval:** Change `require_self_approval: false` to `true` in `_pluginconfig.yaml`
- [ ] **Switch to rebase merge:** Change `merge_method` from `squash` to `rebase` in `_prowconfig.yaml`
- [ ] **Set `lgtm_acts_as_approve`:** One review action sufficient to merge

## Task 9: Update JIRA ticket

Update SRVOCF-982 with summary of what was done in this branch and what Robert did in PRs #78, #35, #83.
