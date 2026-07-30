---
allowed-tools: Bash(git log:*), Bash(git branch:*), Bash(git checkout:*), Bash(pwd), Bash(./hack/branch.sh:*), Bash(./hack/read-ticket.sh:*), Read
description: Start a session, orient, and pick work
argument-hint: "[--dry-run] [JIRA-TICKET-OR-URL]"
---

# Begin Session

## Steps

1. **Confirm working directory**: run `pwd`.
2. **Orient**: understand the project and recent activity:
   - Read `docs/ARCHITECTURE.md`
   - Read `docs/STYLEGUIDE.md`
   - Review recent commits (full messages and changed files):

     ```bash
     git log --stat -20
     ```

3. **Branch**:

   ```bash
   ./hack/branch.sh $ARGUMENTS
   ```

4. **Read ticket**:

   ```bash
   ./hack/read-ticket.sh $ARGUMENTS
   ```

   Follow the ACTION in the output.

5. Wait for instructions from the user. Do NOT start any work autonomously.
