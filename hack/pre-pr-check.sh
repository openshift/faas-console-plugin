#!/usr/bin/env bash
set -euo pipefail

# Pre-PR validation: prerequisites, branch state, Jira issue.
# Called by the /create-pr skill. Exits non-zero on any blocker.

REPO="openshift/faas-console-plugin"
REMOTE="upstream"

header() { printf '\n=== %s ===\n' "$1"; }
fail()   { printf 'BLOCKER: %s\n' "$1"; exit 1; }

# --- Prerequisites (auto-install if missing) ---
header "Prerequisites"

if ! command -v gh >/dev/null 2>&1; then
  printf 'gh not found, installing...\n'
  brew install gh || fail "Could not install gh. Install manually: brew install gh"
fi

if ! command -v jira >/dev/null 2>&1; then
  printf 'jira not found, installing...\n'
  brew install ankitpokhrel/jira-cli/jira-cli || fail "Could not install jira-cli. Install manually: brew install ankitpokhrel/jira-cli/jira-cli"
fi

printf 'gh:   %s\n' "$(gh --version | head -1)"
printf 'jira: %s\n' "$(jira version 2>&1 | head -1)"

# --- Branch ---
header "Branch"
BRANCH=$(git branch --show-current)
printf 'branch: %s\n' "$BRANCH"
[[ "$BRANCH" == "master" || "$BRANCH" == "main" ]] && fail "On $BRANCH. Create a feature branch first."

# --- Uncommitted changes ---
header "Working tree"
if [[ -n $(git status --porcelain) ]]; then
  git status --short
  fail "Uncommitted changes. Run '/commit <JIRA-TICKET>' first."
else
  printf 'clean\n'
fi

# --- Existing PR ---
header "Existing PR"
EXISTING=$(gh pr list --head "$BRANCH" --state open --repo "$REPO" --json url --jq '.[0].url // empty' 2>/dev/null || true)
if [[ -n "$EXISTING" ]]; then
  printf 'url: %s\n' "$EXISTING"
  fail "PR already exists: $EXISTING"
else
  printf 'none\n'
fi

# --- Upstream sync ---
header "Upstream sync"
git fetch "$REMOTE" master --quiet
if ! git merge-base --is-ancestor "$REMOTE/master" HEAD 2>/dev/null; then
  fail "Branch is behind $REMOTE/master. Rebase first."
fi
printf 'up to date\n'

# --- Jira issue ---
header "Jira issue"
ISSUE_KEY=$(printf '%s' "$BRANCH" | grep -oE '^[A-Z]+-[0-9]+' || true)
if [[ -z "$ISSUE_KEY" ]]; then
  fail "No Jira issue key found in branch name. Branch must start with <ISSUE-KEY>-"
fi
printf 'key: %s\n' "$ISSUE_KEY"

header "Jira issue details"
if ! jira issue view "$ISSUE_KEY" --plain 2>/dev/null; then
  printf 'WARNING: Could not fetch Jira issue %s. Check JIRA_API_TOKEN and jira init.\n' "$ISSUE_KEY"
fi

# --- Git context ---
header "Commits"
git log --oneline "$REMOTE/master..HEAD"

header "Changed files"
git diff "$REMOTE/master...HEAD" --stat

header "Upstream tracking"
git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || printf 'none (will push on PR create)\n'

printf '\n=== All checks passed ===\n'
printf 'issue_key=%s\n' "$ISSUE_KEY"
printf 'branch=%s\n' "$BRANCH"
