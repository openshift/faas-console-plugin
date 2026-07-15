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

## Jira Story status                                                                                 
                                                                                               
- **New** - Issue is ready to be picked up                                               
- **Backlog** - Issues are created and refined                                             
- **Refinement** - Requirements are clarified, scope is agreed                             
- **In Progress** - Work has started                                                       
- **Code Review** - PR is open and awaiting review                                              
- **Closed** - PR is merged   

## Pull Requests

- Open a draft PR early to reserve the PR number and signal work in progress
- Follow the PR template at `.github/pull_request_template.md`
- See [WORKFLOW.md](WORKFLOW.md) for PR title format and branching conventions


