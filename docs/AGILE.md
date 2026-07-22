# Agile Workflow

## Iterations

3-week iterations aligned with the OpenShift release schedule. Each release cycle contains multiple iterations.

### During the iteration

- In planning, each engineer picks a refined story to develop and a few unrefined stories to refine
- Develop your story and refine the others
- When done, notify the team in weekly sync, grab another refined story from the backlog
- When done refining, grab the next ones
- If a story is larger than expected, break it down, re-estimate, and put new stories in the backlog

## Issue Tracking

We use Jira for planning and tracking. Issues are organized as:

- **Epics** group related stories under a single initiative (see [epic template](templates/jira-epic-template.md))
- **Stories** describe a unit of deliverable work (see [story template](templates/jira-story-template.md))
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

### Async Review

The rest of the team reviews refined stories in Jira and leaves comments.

## Sync Ceremonies

**Iteration Planning** (start of iteration, 20 min)

- Each engineer selects refined stories from the backlog for the upcoming 3 weeks.
- Stories must be refined before entering an iteration; otherwise, they return to refinement.
- Engineers volunteer to take unrefined stories for refinement during the upcoming iteration.

**Weekly Sync** (Wednesdays, 30 min)

- A quick round covering progress, blockers, and any decisions needed.
- The facilitator runs the Jira sanity check for each engineer.

**Optional Refinement Slot** (weekly, 45 min)

- Intended for open questions from async refinement requiring face-to-face discussion.
- The meeting itself is optional. When there is nothing to discuss the team is not expected to attend.
- The PM is invited when their input is needed.
- The facilitator cancels it if there is nothing to discuss.

**Iteration Review + Retrospective** (end of iteration, 60-75 min)

- First half (30 min): each engineer briefly demonstrates what they delivered.
- Second half (30 min): reflecting on what went well, what didn't, and one thing to change next iteration.

**Rotation:** The first facilitator is picked at kick-off. After every 2 iterations, the role rotates to the next person.

## Facilitator Jira Checklist

The facilitator checks the following for each engineer during the weekly sync:

- Is the story assigned to the engineer working on it?
- Is the status up to date?
- PR linked to the story if there is one?
- Status of stories in refinement up to date?
- Questions/comments on stories in refinement answered?
- Does the story have the correct parent epic?
- Is iteration number added to story? (e.g. PIXAA Sprint 291.)

## Facilitator Duties

During rotation:

- Set up sync ceremony meetings (planning, weekly sync, review + retro)
- Inform the team if the optional refinement slot happens, latest on the day of
- Facilitate sync ceremonies: keep time and lead the agenda
- Run the Jira sanity check during the weekly sync

## Pull Requests

- Open a draft PR early to reserve the PR number and signal work in progress
- Follow the PR template at `.github/pull_request_template.md`
