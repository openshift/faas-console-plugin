# AGENTS.md — func-console

This is the project map. Read this first, every session.

## Project

FaaS PoC UI for OpenShift Console — React + TypeScript + Webpack + PatternFly 6 + OCP Dynamic Plugin SDK.
See `docs/design/` for full design specs.

## Communication

- Ask before staring modifications of code.
- Ask before starting a new task or making a design decision.
- Once actively implementing, keep going without asking. Only stop to ask when blocked by sandbox, permissions, or ambiguous requirements.
- Always show Jira issue content (epic, story, comment) for review before creating or updating. Never push to Jira without approval.
- Default values for new issues: Assignee = unassigned, Priority = Normal, Status = Backlog. Always ask about labels before creating. Ask if defaults should be changed before creating.

## Writing Style

No em dashes (`—`). Use commas, periods, or parentheses instead.

## Knowledge Base

| File | Purpose |
|------|---------|
| `docs/WORKFLOW.md` | Startup sequence, feature dev sequence, branching, PRs, session rules |
| `docs/ARCHITECTURE.md` | Layered architecture, dependency rules |
| `docs/STYLEGUIDE.md` | Code style, naming conventions |
| `docs/TESTING.md` | Testing strategy, tools, conventions, mock patterns |
| `docs/design/` | Design specs — "what to build" |
| `docs/plans/active/` | Implementation plans in progress |
| `docs/plans/completed/` | Finished plans |
| `docs/features.json` | Inviolable feature list — see [`references/features-json-readme.md`](docs/references/features-json-readme.md) |
| `docs/potential-features.json` | Candidate features for future implementation |
| `docs/claude-progress.txt` | Session handoff log — see [`references/claude-progress-readme.md`](docs/references/claude-progress-readme.md) |
| `docs/agent-struggles.json` | Struggle log — see [`references/agent-struggles-readme.md`](docs/references/agent-struggles-readme.md) |
| `.dev-env.json` | Dev server ports (backendPort, pluginPort, consolePort), written by init.sh |
| `.dev-logs/` | Dev server log files (backend.log, webpack.log, console.log) |
| `docs/references/ocp-plugin-guide.md` | OCP dynamic plugin mechanics, i18n, extension points |
| `docs/references/commit-message-guide.md` | Git commit conventions and authorship rules |
