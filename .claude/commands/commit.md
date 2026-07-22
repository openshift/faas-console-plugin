---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git log:*), Bash(git diff:*), Bash(git branch:*), Bash(./hack/parse-commit-args.sh:*)
description: Create a git commit
argument-hint: "[--dry-run] [JIRA-TICKET]"
---

# Git Commit Message Guidelines

Create a git commit message following these rules:

## The Seven Rules

1. Separate subject from body with a blank line
2. Limit the subject line to 50 characters
3. Use conventional commit spec for subject line
4. Do not end the subject line with a period
5. Use the imperative mood in the subject line
6. Wrap the body at 72 characters
7. Use the body to explain what and why vs. how

## Format

```txt
<type>: <subject - max 50 chars total, imperative mood, conventional commit spec>

<Body - wrapped at 72 chars, explains what and why>
<Optional bullet points for clarity>
<Optional "Issue <JIRA-TICKET>" if a ticket was provided>
```

## Conventional Commits

- Use conventional commits spec with types: feat, fix, refactor, docs, test, chore, style, perf, ci, build
- Format: `<type>: <description>`
- Examples: "feat: add user authentication", "fix: resolve memory leak in cache"
- Use "feat" only on user-facing changes

## Subject Line

- Write as if completing: "If applied, this commit will..."
- Include type prefix (conventional commits)
- Total length max 50 chars including type
- Examples: "refactor: simplify cache handling", "fix: prevent race condition"
- NOT: "refactored cache", "fixed the race"

## Body

- Explain the motivation for the change
- Explain the "what" and "why" vs. "how" which means:
  - the way things worked before the change (and what was wrong with that),
  - the way they work now,
  - and why I decided to solve it the way I did,
  - and if you're not sure about the "why" then ask me.
- Focus on context, not implementation details
- Find a balance for message length, i.e. analyze the diff and decide if a shorter message is enough or more explanation is needed
- Don't overuse bullet points (-, \*, +), add them only in bigger commits if they are helpful
- Keep it short if there aren't many changes

### Example

Here is a good example from a [commit to the Bitcoin core](https://github.com/bitcoin/bitcoin/commit/eb0b56b19017ab5c16c745e6da39c53126924ed6).

```txt
   refactor: simplify serialize.h's exception handling

   Remove the 'state' and 'exceptmask' from serialize.h's stream
   implementations, as well as related methods.

   As exceptmask always included 'failbit', and setstate was always
   called with bits = failbit, all it did was immediately raise an
   exception. Get rid of those variables, and replace the setstate
   with direct exception throwing (which also removes some dead
   code).

   As a result, good() is never reached after a failure (there are
   only 2 calls, one of which is in tests), and can just be replaced
   by !eof().

   fail(), clear(n) and exceptions() are just never called. Delete
   them.
```

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Task

1. Analyze the staged changes from git diff
2. New added features and fixes are more important than other types like refactoring, etc.
3. Draft a commit message following all seven rules
4. Use conventional commits spec
5. MODE and TICKET are: !`./hack/parse-commit-args.sh $ARGUMENTS`
   - If TICKET is NOT `none`, add "Issue <ticket>" at the bottom of the message
   - If MODE is `dry-run`, show the final message and ask for confirmation before committing
   - If MODE is `commit`, commit and show `git log --oneline -1` to confirm
