---
allowed-tools: Bash(git *)
description: Stage changes and commit (end-of-session)
---

# Session Commit

Automate end-of-session cleanup: stage and commit.

## Steps

1. **Assess changes** -- run these in parallel:
   - `git status`
   - `git diff HEAD`
   - `git branch --show-current`
   - `git log --oneline -10`

2. **Stage everything** -- if there are unstaged or untracked changes:
   - Use `git add <specific-files>` (not `git add .`)
   - Never stage files that likely contain secrets (.env, credentials, etc.)
   - Skip if everything is already staged

3. **Draft and commit** -- follow all rules from `docs/references/commit-message-guide.md`:
   - Subject: `<type>: <description>`, imperative mood
   - Body is optional if the subject is descriptive enough, otherwise explain what and why
   - No em dashes anywhere in the message

   Determine authorship mode (tandem vs autonomous) from the guide. Use a HEREDOC:

   ```bash
   git commit -m "$(cat <<'EOF'
   <type>: <subject>

   <body>

   <authorship trailer>
   EOF
   )"
   ```

4. **Verify** -- run `git status` and `git log --oneline -1` to confirm success. If the commit fails due to the commit-msg hook, read the error output, fix the message, and create a NEW commit (never amend).

## Rules

- Analyze the FULL diff for an accurate commit message
- Never commit secrets or sensitive files
- If commit fails due to pre-commit or commit-msg hook, fix and create a NEW commit (never amend)
- Do NOT push to remote
