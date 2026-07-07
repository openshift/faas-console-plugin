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
- [x] Create new stories where needed -> SRVOCF-978, SRVOCF-979 on 953
- [x] Add KEDA deployer stories -> SRVOCF-952 (func CLI, updated from spike), SRVOCF-981 (console) on 956
- [x] Add workflow unification story -> SRVOCF-982 on 953
- [x] Sync epics and stories to Jira
- [x] Create remaining TBD stories on SRVOCF-956 -> SRVOCF-983, SRVOCF-984
- [x] Create remaining TBD stories on SRVOCF-957 -> SRVOCF-985, SRVOCF-986, SRVOCF-987
- [x] Update SRVOCF-954 with completed work
- [x] Update SRVOCF-953 epic description

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
| SRVOCF-978 | Move backend logic from client to server | Refinement | New |
| SRVOCF-979 | Replace GitHub repos as source of truth for function discovery | Refinement | New |
| SRVOCF-982 | Workflow unification: development guidelines and tooling | Refinement | Blocker |

### SRVOCF-956: Console - Dynamic Plugin - TP Demo Features

New console plugin features for the TP demo.

**Stories:**

| Key | Summary | Status | Notes |
|-----|---------|--------|-------|
| SRVOCF-952 | func CLI: deploy using KEDA on OpenShift | In Progress | nice-to-have, was spike |
| SRVOCF-981 | Console: support KEDA-deployed functions | Refinement | nice-to-have |
| SRVOCF-863 | Create functions from template repositories | Backlog | nice-to-have |
| SRVOCF-856 | OAuth authentication | Backlog | nice-to-have |
| SRVOCF-958 | Add runtime environment variables UI to Create page | Refinement | must-have |
| SRVOCF-983 | E2E demonstration of must-have implementation | Backlog | must-have, blocked by 958 |
| SRVOCF-984 | Create file in editor | Refinement | nice-to-have |

### SRVOCF-957: PDF Transcriber - Demo Function

Self-contained PDF transcription function for the TP demo.

**Stories:**

| Key | Summary | Status | Notes |
|-----|---------|--------|-------|
| SRVOCF-985 | PDF transcriber function handler | Refinement | must-have, Major |
| SRVOCF-986 | PDF transcriber SPA frontend | Refinement | must-have, Major, related to 863 and 984 |
| SRVOCF-987 | PDF transcriber local development and testing | Refinement | must-have, Major |

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
