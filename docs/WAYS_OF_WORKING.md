# Ways of Working

## Current Cycle

**Cycle 1:** From the merge of this process PR until six weeks later.

| Role | Current assignment |
|------|--------------------|
| Meeting Manager | @Cragsmann |
| Backlog Manager | @pmeida |
| Roadmap Manager | @twoGiants (primary communicator), @matejvasek |

## Project Management

We share recurring project management work so everyone has time for development and architecture.
Responsibilities can overlap. Each role holder follows through on their duties and asks the team for help when needed.

The product manager owns product priorities. The team contributes recommendations and influences those priorities;
the Roadmap Managers coordinate delivery with the product manager.

### Shared Responsibilities

All team members:

- Develop, test, document, review code, and contribute to architecture decisions.
- Refine stories and keep their own Jira issues, status, and PR links up to date.
- Create or update an appropriate Jira issue for actionable findings and ideas they raise.

### Meeting Manager

- Set up and facilitate weekly syncs, retrospectives, iteration reviews, and knowledge transfer sessions. Keep invitations and descriptions up to date.
- Record ceremony action items, ensure each has an owner and a ticket where needed, and follow up with the owners.
- Track PR review assignments and help stalled PRs move forward, including finding an owner for repository automation PRs. Authors and reviewers remain responsible for their PRs.

### Backlog Manager

- Set up and facilitate backlog grooming, and coordinate story refinement across the team.
- Ensure work is tracked in an appropriate Jira issue. Continuously monitor that issues in status Backlog and beyond are refined, assigned, prioritized, and estimated.
- Check issue has correct status, PR links where applicable, story-to-epic links, epic-to-OCPSTRAT links, and dependencies.
- Lead the Jira sanity check during weekly syncs and follow up on unresolved ticket dependencies.

### Roadmap Manager

@twoGiants and @matejvasek share roadmap work. The primary communicator rotates between them.

- Set up and facilitate iteration planning, accounting for development and PM responsibilities.
- Coordinate what to work on now and what comes next with the product manager and the team.
- Collect questions and recommendations for the product manager, and coordinate responses to blockers and cross-team dependencies.
- Use iteration reviews to check progress against the intended outcomes with the product manager.
- The primary communicator reports status at CCSIG (Mondays at 10/11), updates the relevant OCPSTRAT status summaries weekly, and brings resource questions, expectations, and requests for cross-team help to management.

Each OCPSTRAT status summary must include:

- **Current state**
- **Next state**
- **Risk, blockers and/or waiting**

### Rotation and Handoff

Roles rotate every six weeks, the length of two iterations. The first cycle starts when the PR
introducing this process is merged. Rotation follows this six-week schedule independently of the retrospective dates.

The rotation pairs are long-term: @Cragsmann and @pmeida swap Meeting Manager and Backlog Manager;
@twoGiants and @matejvasek share roadmap work and alternate as primary communicator.

At the end of each cycle, outgoing role holders:

1. Brief the incoming person on pending actions and upcoming commitments.
2. Hand over calendar event ownership and meeting responsibilities where applicable.
3. Update the [current cycle](#current-cycle), dates, and assignments in this document through a PR.

## Iterations

3-week iterations aligned with the OpenShift release schedule. Each release cycle contains multiple iterations.

### During the iteration

- In planning, each engineer picks a refined story to develop and a few unrefined stories to refine
- Develop your story and refine the others
- When done, notify the team in weekly sync, grab another refined story from the backlog
- When done refining, grab the next ones
- If a story is larger than expected, break it down, re-estimate, and refine new stories before moving them to Backlog

### Mid-flight re-scoping

When a story grows beyond its original estimate during development:

1. Pause implementation.
2. Revisit the story: split it into subtasks, divide into must-have and nice-to-have.
3. Move nice-to-have items to new stories for later refinement and prioritization.
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
- **Closed** - Acceptance criteria are met and all required PRs are merged, if applicable

Create unrefined issues in New. Use Backlog for work that is refined and ready for development.

## Async Ceremonies

### Refinement

Refinement converts a vague initiative into work an engineer can act on. A story is considered "refined" when any team member could read it and know what to build and when it's done.

**Process:**

1. **Product Kickoff** (30-60 min, once per OCPSTRAT):
   - The product manager explains the what/why, success criteria, and priority, with input from the team.
   - The Roadmap Managers attend.
   - This happens before iteration planning when new OCPSTRAT work enters the cycle.
2. **Async Breakdown**: The Roadmap Managers coordinate the OCPSTRAT breakdown into epics and stories with the team. Engineers refine the stories, with the Backlog Manager coordinating refinement.
3. **Open Questions**: Brought to the optional weekly refinement slot (45 min), coordinated by the Backlog Manager. Product questions go to the product manager through the Roadmap Managers.

**Rules:**

- Blocked work should not be refined, defer until it is unblocked.
- Refinement is ongoing.
- Identify large stories during refinement and split them into subtasks with priorities (must-have / nice-to-have). Each subtask should be independently mergeable.

### Async Review

The rest of the team reviews refined stories in Jira and leaves comments.

## Sync Ceremonies

**Weekly Sync + Technical Discussions** (every Tue + Thu)

The Meeting Manager facilitates; the Backlog Manager leads the Jira sanity check.

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

The Backlog Manager sets up and facilitates this meeting.

Checklist:

- [ ] Go through all New / Backlog stories and bugs
- [ ] Identify large stories and split them into prioritized subtasks (must-have / nice-to-have)
- [ ] Prioritize and assign stories for refinement
- [ ] Close stale items
- [ ] Create new tickets as needed
- [ ] Discuss open questions

Calendar event descriptions should reference this checklist as the single source of truth.

**Review + Planning** (every three weeks on Thu, iteration end)

- Review first, facilitated by the Meeting Manager, then planning, facilitated by the Roadmap Managers.
- Review and planning sessions can be recorded and shared with management.

**Retrospective** (every three weeks on Tue, iteration start)

The Meeting Manager sets up and facilitates this meeting.

Checklist:

- [ ] Collect feedback from all team members
- [ ] Review previous action items with their owners
- [ ] Meeting Manager records new action items and owners in a story under the main working epic
- [ ] Document outcomes using the [retrospective template](templates/retro-template.md)
- [ ] Check for an upcoming [role handoff](#rotation-and-handoff) using the six-week rotation schedule

On weeks where the retrospective intersects with the backlog grooming meeting, grooming moves to Thu.

Calendar event descriptions should reference this checklist as the single source of truth.

**Knowledge Transfer** (as needed)

An informal session where a team member shares context on a topic relevant to the team. The Meeting Manager keeps the session on the calendar and coordinates scheduling with the presenter.

Reasons to hold one:

- New feature walkthrough after a complex feature lands
- Spike or research findings from a technical investigation
- Tooling or workflow changes the team will use
- Onboarding a new team member
- Cross-team learnings from conferences, training, or other teams
- Spreading knowledge of a critical area beyond a single person

## Pull Requests

- Open a draft PR early to reserve the PR number and signal work in progress
- Keep PRs small and focused. One concern per PR.
- If a PR has grown large, split it into multiple smaller PRs before requesting review.
- Follow the PR template at `.github/pull_request_template.md`
