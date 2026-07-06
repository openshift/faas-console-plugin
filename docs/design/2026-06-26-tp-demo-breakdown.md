# TP Demo Breakdown

**Date:** 2026-06-26
**Story:** [SRVOCF-954](https://redhat.atlassian.net/browse/SRVOCF-954)
**Related:** [OCPSTRAT-2942](https://redhat.atlassian.net/browse/OCPSTRAT-2942), [TP Demo Proposal](2026-06-19-tp-demo-proposal.md)

---

## TODO

- [x] Add productization story -> SRVOCF-955
- [x] Define epics for the TP demo work -> SRVOCF-953, SRVOCF-956, SRVOCF-957
- [x] Review open stories on SRVOCF-810, move relevant ones -> SRVOCF-862, SRVOCF-841 to 953
- [x] Review stories on SRVOCF-913, move relevant ones -> SRVOCF-822, 825, 842, 844, 846, 847, 848, 859, 944 to 953
- [ ] Create new stories where needed
- [ ] Add KEDA deployer story (switch from Knative Serving to KEDA, depends on [SRVOCF-886](https://redhat.atlassian.net/browse/SRVOCF-886), see [OCPSTRAT-2942 comment](https://redhat.atlassian.net/browse/OCPSTRAT-2942?focusedCommentId=17367325))
- [ ] Add workflow unification story (align workflows before moving forward, see [Slack thread](https://redhat-internal.slack.com/archives/CLMP7R2G2/p1781796463631199), [commit message hygiene](https://redhat-internal.slack.com/archives/CLMP7R2G2/p1782474964480759))
  - branch naming rule and script
  - PR guideline: subject + description
  - commit message guideline + lint
  - project development principles
  - project values
- [ ] Sync epics and stories to Jira
- [ ] Prioritize stories

## Epics

### SRVOCF-953: Console - Dynamic Plugin - Post-PoC Stabilization

Post-PoC cleanup, stabilization and development environment setup.

**Stories:**

| Key | Summary | Status | Notes |
|-----|---------|--------|-------|
| SRVOCF-954 | Break down OCPSTRAT-2942 into epics and stories | In Progress | This work |
| SRVOCF-955 | Productization: use RH-built artifacts for TP release | Backlog | |
| SRVOCF-950 | Add commit-msg hook and refine commit slash commands | Closed | |
| SRVOCF-944 | Migrate repo to openshift org | Closed | |
| SRVOCF-862 | OAuth button placeholder | Backlog | Moved from 810 |
| SRVOCF-859 | Force s2i builder for UBI-based function images | Backlog | Moved from 913 |
| SRVOCF-848 | Create Page UX improvements | Backlog | Moved from 913 |
| SRVOCF-847 | Add e2e smoke tests | In Progress | Moved from 913 |
| SRVOCF-846 | Migrate remaining unit tests to MSW | Closed | Moved from 913 |
| SRVOCF-844 | Add missing unit tests for FunctionEditPage | Closed | Moved from 913 |
| SRVOCF-842 | Centralize session management + disconnect | Backlog | Moved from 913 |
| SRVOCF-841 | Service layer cleanup: ClusterService, kubeconfig, encryption | In Progress | Moved from 810 |
| SRVOCF-825 | Error handling infrastructure | Backlog | Moved from 913 |
| SRVOCF-822 | Function List shows cluster functions without PAT | Backlog | Moved from 913 |

### SRVOCF-956: Console - Dynamic Plugin - TP Demo Features

New console plugin features for the TP demo.

**Stories:**

| Key | Summary | Status | Notes |
|-----|---------|--------|-------|
| SRVOCF-952 | KEDA deployer support (spike) | In Progress | nice-to-have |
| SRVOCF-863 | Create functions from template repositories | Backlog | nice-to-have |
| SRVOCF-856 | OAuth authentication | Backlog | nice-to-have |
| (TBD) | Secret reference UI | | must-have |
| (TBD) | E2E demonstration of must-have implementation | | must-have |
| (TBD) | Create file in editor | | nice-to-have |

### SRVOCF-957: PDF Transcriber - Demo Function

Self-contained PDF transcription function for the TP demo.

**Stories:**

| Key | Summary | Status | Notes |
|-----|---------|--------|-------|
| (TBD) | Function handler | | must-have |
| (TBD) | SPA frontend | | must-have |
| (TBD) | Local development and testing | | must-have |

## Stories Remaining on SRVOCF-913

| Key | Summary | Status | Notes |
|-----|---------|--------|-------|
| SRVOCF-861 | Individual function monitoring dashboard | Backlog | GA |
| SRVOCF-860 | Functions overview dashboard with metrics | Backlog | GA, demo |
| SRVOCF-858 | Explore Dev Spaces editor integration | Backlog | GA |
| SRVOCF-857 | Add Tekton CI support (GA requirement) | New | GA |
| SRVOCF-855 | Add build trigger buttons to list page | Backlog | GA |
| SRVOCF-854 | CRD-based function discovery | Backlog | GA, TP |
| SRVOCF-853 | Add GitHub Enterprise support | Backlog | GA |
| SRVOCF-852 | Add invoke button for internal functions | Backlog | GA |
| SRVOCF-851 | Show GitHub Action status in list page | Backlog | GA |
