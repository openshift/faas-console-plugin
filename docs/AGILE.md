# Agile Workflow

## Iterations

3-week iterations aligned with the OpenShift release schedule. Each release cycle contains multiple iterations.

### During the iteration

- In planning, each engineer picks a refined story to develop and a few unrefined stories to refine
- Develop your story and refine the others
- When done, notify the team in weekly sync, grab another refined story from the backlog
- When done refining, grab the next ones
- If a story is larger than expected, break it down, re-estimate, and put new stories in the backlog

### Mid-flight re-scoping

When a story grows beyond its original estimate during development:

1. Pause implementation.
2. Revisit the story: split it into subtasks, divide into must-have and nice-to-have.
3. Move nice-to-have items to new stories in the backlog.
   - If nice-to-haves are implemented already, merge them in separate PRs.
4. Resume implementation of must-have subtasks.
5. Merge the must-have subtasks in separate, ideally small, focused PRs.
6. Repeat 1-5 as needed.

If the work is already done but the PR has grown large, split it into
multiple smaller PRs before requesting review.

## Issue Tracking

We use Jira for planning and tracking. Issues are organized as:

- **Epics** group related stories under a single initiative (see [epic template](templates/jira-epic-template.md))
- **Stories** describe a unit of deliverable work (see [story template](templates/jira-story-template.md))
- **Bugs** describe a defect to fix (see [bug template](templates/jira-bug-template.md))
- **Sub-tasks** break a story into smaller pieces when needed

## Jira Story Status

- **New** - Issue to refine
- **Backlog** - Ready for development
- **Refinement** - Issue is in refinement
- **In Progress** - Work has started
- **Code Review** - PR is open and awaiting review
- **Closed** - PR is merged

## Async Ceremonies

### Refinement

Refinement converts a vague initiative into work an engineer can act on. A story is considered "refined" when any team member could read it and know what to build and when it's done.

**Process:**

1. **PM Kickoff** (30-60 min, once per OCPSTRAT):
   - The PM explains the what/why, success criteria, and priority.
   - The primary and secondary architect attend.
   - This happens before iteration planning when new OCPSTRAT work enters the cycle.
2. **Async Breakdown**: The primary and secondary architect decompose the OCPSTRAT into epics and stories in Jira.
3. **Open Questions**: Brought to the optional weekly refinement slot (45 min).

**Rules:**

- Blocked work should not be refined, defer until it is unblocked.
- Refinement is ongoing.
- Identify large stories during refinement and split them into subtasks with priorities (must-have / nice-to-have). Each subtask should be independently mergeable.

### Async Review

The rest of the team reviews refined stories in Jira and leaves comments.

## Sync Ceremonies

**Weekly Sync + Technical Discussions** (every Tue + Thu)

Checklist:

- [ ] **Status sync** - each engineer:
  - Story assigned to the engineer working on it?
  - Status up to date?
  - Are priorities correct?
  - PR linked to the story?
  - Stories in refinement up to date? Questions/comments answered?
  - Correct parent epic?
- [ ] **PR review assignments** - assign open PRs until everyone has 1-3 PRs to review.
- [ ] **Technical discussions** - discuss stories in progress or upcoming stories that need alignment.

Calendar event descriptions should reference this checklist as the single source of truth.

**Backlog Cleanup / Grooming** (every week, Tue or Thu or both)

Checklist:

- [ ] Go through all New / Backlog stories and bugs
- [ ] Identify large stories and split them into prioritized subtasks (must-have / nice-to-have)
- [ ] Prioritize and assign stories for refinement
- [ ] Close stale items
- [ ] Create new tickets as needed
- [ ] Discuss open questions

Calendar event descriptions should reference this checklist as the single source of truth.

**Review + Planning** (every three weeks on Thu, iteration end)

- Review first, then planning.

**Retrospective** (every three weeks on Tue, iteration start)

Checklist:

- [ ] Collect feedback from all team members
- [ ] Select new rotating facilitator
- [ ] New facilitator creates a story with action items under the main working epic
- [ ] Document outcomes using the [retrospective template](templates/retro-template.md)
- [ ] Open PR to update current facilitator in [README.md](../README.md)

On weeks where the retrospective intersects with the backlog grooming meeting, grooming moves to Thu.

Calendar event descriptions should reference this checklist as the single source of truth.

## Facilitator Duties

During rotation:

- Set up sync ceremony meetings
- Facilitate sync ceremonies: keep time and lead the agenda
- Run the Jira sanity check during the weekly sync
- Track PR review assignments during the weekly sync

## Pull Requests

- Open a draft PR early to reserve the PR number and signal work in progress
- Keep PRs small and focused. One concern per PR.
- If a PR has grown large, split it into multiple smaller PRs before requesting review.
- Follow the PR template at `.github/pull_request_template.md`
