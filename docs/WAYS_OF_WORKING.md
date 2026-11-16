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
- Own refinement of their issues through to _Backlog_, and keep status, labels, estimates, dependencies and PR links up to date.
- When picking up a ticket to refine, self-assign it and own it through to _Backlog_. Remove the assignee once it moves to _Backlog_. Tickets left in _New_ without an assignee are picked up by the Backlog Manager during the weekly sanity check.
- Bring decisions and requests for refinement help to grooming.
- Create or update an appropriate Jira issue for actionable findings and ideas they raise.

### Meeting Manager

- Set up and facilitate weekly syncs, retrospectives, iteration reviews, and knowledge transfer sessions. Keep invitations and descriptions up to date.
- Record ceremony action items, ensure each has an owner and a ticket where needed, and follow up with the owners.
- Track PR review assignments and help stalled PRs move forward, including finding an owner for repository automation PRs. Authors and reviewers remain responsible for their PRs.

### Backlog Manager

- Set up and facilitate backlog grooming, and help story owners get refinement input from the team. Owners remain responsible for refinement and moving ready issues to _Backlog_.
- During grooming, coordinate the movement of inbox items and misplaced issues to the correct epics.
- During grooming, briefly review a few of the oldest untouched _New_ or _Refinement_ issues with their owners to agree next steps and prevent abandoned tickets.
- Collect topics people bring, hot topics, relevant Slack conversations, and unanswered requests for PM opinion, and keep them in a short running grooming agenda.
- Ensure work is tracked in an appropriate Jira issue.
- Continuously monitor that `Inbox` issues in status beyond _Backlog_ are correctly estimated and refined.
- Return insufficiently refined _Backlog_ issues to _New_ with a comment explaining the gaps. Across these reviews, verify status, labels, applicable PR links, story-to-epic links, epic-to-OCPSTRAT links, and dependencies.
- Lead the Jira sanity check during weekly syncs, raise gaps, and follow up on unresolved ticket dependencies with their owners.
- Review potentially stale items with PM in a separate meeting when needed and agree their resolution. `needs-stale-check` may be used temporarily to collect those items, then removed once resolved.

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
- If a story is larger than expected, break it down, re-estimate, and refine new stories before moving them to _Backlog_

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

### Inbox

Every new issue lands in the `Inbox` epic first. The Backlog Manager reviews inbox items during grooming to confirm refinement and decide where they belong.

### Qualification Labels

Use one primary purpose label and one support tier.

#### Support Tiers

The tiers follow "Serverless 2.0 Dependency Support Tiers".

| Label             | Support scope                                              | Examples                                                                                                           |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tier-0`  | Core dependencies and capabilities that make up Serverless | KEDA autoscaling, OCP Console, Git or equivalent repository capability, in-cluster CI/CD such as Tekton, Kafka EDA |
| `tier-1`  | OpenShift dependencies that make Serverless work in OCP    | External-cluster CI/CD, Service Mesh networking                                                                    |
| `tier-2`  | Established customer integrations                          | GitHub, Camel, SQS and S3                                                                                          |
| `tier-3`  | Best-effort integrations                                   | MCP, GitHub Actions                                                                                                |
| `tier-4`  | Documentation/upstream-only integrations                   | RedisStream                                                                                                        |
| `tier-na` | Work outside the dependency support model                  | Team process, generic development tooling                                                                          |

- Generic Console correctness or refactoring is Tier 0; GitHub-specific integration is Tier 2 even when implemented in the Console.
- Product CI/CD and the team's own build/test infrastructure are different: development CI does not automatically inherit a customer CI/CD tier.
- Documentation inherits the capability's tier. Writing documentation does not make an issue Tier 4.

#### Work Purpose

| Label         | Purpose                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `capability`  | Add or extend user-facing functionality or integrations                            |
| `hardening`   | Improve correctness, security, reliability, recovery or production robustness      |
| `maintenance` | Refactor, simplify code, maintain compatibility or update dependencies             |
| `tooling`     | Improve development environments, repository CI, test infrastructure or automation |
| `docs`        | Provide user/operator documentation, examples or guides                            |
| `process`     | Improve team practices, planning, roles or ceremonies                              |

Choose one or more purposes. For example, production-code test refactoring can be Tier 0 maintenance, while a generic E2E runner improvement is tooling outside the support tiers. Developer tooling guides belong with tooling; team working agreements belong with process.

### Backlog Readiness

The issue owner assignee owns refinement and moves the issue to _Backlog_ when it is ready.
The Backlog Manager checks readiness and labels, and returns unready _Backlog_ issues to _New_ with a comment identifying the gaps. The owner addresses them before moving it back to _Backlog_.

An issue is ready when:

- The description states the problem and expected outcome following our guide templates.
- Priority and a story-point estimate are set.
- A support tier label and a work purpose label are set.
- Parent epic, dependencies and related issue links are correct.
- Scope is bounded, coherent and independently deliverable.
- Acceptance criteria are observable.

## Jira Story Status

- **New** - Issue to refine
- **Refinement** - The owner is actively refining the issue
- **Backlog** - Refined and ready for development
- **In Progress** - Work has started
- **Code Review** - PR is open and awaiting review
- **Closed** - Acceptance criteria are met and required PRs are merged, or the issue is otherwise resolved, such as duplicate or obsolete

## Async Ceremonies

### Refinement

Refinement converts a vague initiative into work an engineer can act on. An issue is considered "refined" when any team member could read it and know what to build and when it's done.

#### Process

**OCPSTRAT**

1. Created in _New_.
2. **Product Kickoff** (30-60 min, once per OCPSTRAT, before iteration planning): 
   - The Product Manager explains the what/why, success criteria, and priority, with input from the team.
   - The Roadmap Managers attend. 
   - Issue moves to _Refinement_ and PM is assigned. 
3. **Async Breakdown**:
   - PM and architects refine scope. Engineers may support.
   - If the OCPSTRAT is unclear, a research epic is created and worked until refinement can continue.
   - When clear, Roadmap Managers breakdown into child epics and stories.
   - Moves to _Backlog_ when breakdown is complete, or directly to _In Progress_ if work starts immediately.
4. **Refinement distribution (optional)**: During the weekly sanity check, the Backlog Manager assigns OCPSTRAT child issues to team members to split refinement across the team.
5. **Open Questions**: Brought to the grooming session, coordinated by the Backlog Manager.

**Epic**

1. Created in _New_.
2. Owner self-assigns or assigns someone and moves to _Refinement_.
3. Assignee refines scope and creates child issues.
4. When refined, moves to _Backlog_ and removes themselves as assignee.
5. When development starts, an architect is assigned and the epic moves to _In Progress_.

**Story / Bug**

1. Created in _New_. Lands in `Inbox` unless the correct epic is already known.
2. Owner self-assigns and moves to _Refinement_.
3. Owner refines it.
4. Moves to _Backlog_ when it meets [backlog readiness criteria](#backlog-readiness).

**Rules:**

- Blocked work should not be refined, defer until it is unblocked.
- Refinement is ongoing.
- Owners move ready issues to _Backlog_ without waiting for a grooming meeting.
- Identify large stories and split them into subtasks with priorities (must-have / nice-to-have). Each subtask should be independently mergeable

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
  - Correct parent epic?
- [ ] **Sanity check** (Backlog Manager) - assign relevant _New_ tickets until every engineer has at least 1-2 tickets for refinement.
- [ ] **PR review assignments** - assign open PRs until everyone has 1-3 PRs to review.
- [ ] **Technical discussions** - discuss stories in progress or upcoming stories that need alignment.

Calendar event descriptions should reference this checklist as the single source of truth.

**Grooming** (every week, Tue or Thu or both)

The Backlog Manager sets up and facilitates the meeting. Anyone, including the Backlog Manager can bring an issue they want to discuss.

Checklist:

- [ ] Discuss items people bring for clarification
- [ ] Review a 1-3 of the oldest untouched _New_/_Refinement_ issues, including from inbox and relevant epics
   - [ ] Close if possible
   - [ ] Assign for refinement
   - [ ] Defer to revisit later
- [ ] Move inbox items and misplaced issues to the correct epic
- [ ] Identify large stories and split them into prioritized subtasks (must-have / nice-to-have)
- [ ] Close stale items
- [ ] Create new tickets as needed

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
