---
allowed-tools: Bash(git log:*), Bash(git branch:*), Bash(pwd), Bash(./init.sh), Bash(yarn ci*), Bash(cat .dev-env.json), Read
description: Start a session, orient, and pick work
---

# Begin Session

## Steps

1. **Confirm working directory** — run `pwd`.
2. **Orient** — understand the project and recent activity:
   - Read `docs/ARCHITECTURE.md`
   - Read `docs/STYLEGUIDE.md`
   - Review recent commits (full messages and changed files):

     ```bash
     git log --stat -20
     ```

3. **CI check** — run `yarn ci` (lint, test, build) and verify the project is healthy.
4. **Start dev env** — run `./init.sh`. If it fails (e.g. sandbox blocks `oc`), tell the user to start it manually from their terminal.
5. **Read ports** — read `.dev-env.json` and note the backend, plugin, and console ports. If init.sh failed, skip this step.
6. **Pick work** — tell the user you're oriented. Ask for a Jira ticket link or ID to work on.
7. **Branch** — if not already on a feature branch, create one per [Branching](docs/WORKFLOW.md#branching) convention and open a draft PR (`gh pr create --draft`).
8. **Propose planning** — tell the user the branch is ready and propose to start planning (step 2 of the Feature Development Sequence in `docs/WORKFLOW.md`). Do NOT start any work autonomously.
