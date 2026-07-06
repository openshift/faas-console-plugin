# Better Testing Server Setup (init.sh)

## Goal

Make init.sh suitable for running multiple dev environments concurrently (across different repo clones/worktrees) and improve the Go backend development loop with auto-recompile on file changes.

## Use Case

Multiple repos/worktrees running dev environments simultaneously. Each gets its own randomized ports so there are no collisions.

## Changes

### 1. PID File Management

**Current:** `--stop` uses `pgrep -f` / `pkill -f` with name patterns (e.g. `"bin/backend"`, `"webpack serve"`). Fragile, can kill processes from other repos.

**New:**

- PID files stored in `.dev-pids/` directory (created on startup)
- Files: `backend.pid`, `webpack.pid`, `backend-watcher.pid`
- Console container ID stored in `.dev-pids/console.cid` (via `podman run --cidfile`)
- Each `start_*` function writes `$!` (backgrounded PID) to its PID file
- Each `stop_*` function reads the PID file, sends SIGTERM, waits briefly, removes the PID file
- `--stop` iterates over whatever PID/CID files exist (safe if only some services are running)

### 2. Port Randomization

**Current:** Hardcoded ports: backend 8080, webpack 9001, console 9000.

**New:**

- By default, init.sh uses the same hardcoded defaults as today (8080, 9001, 9000) so human testers are not surprised
- When `--randomize-ports` flag is passed, init.sh picks three random available ports from range 10000-60000
- A `random_free_port()` helper function loops until it finds an unused port (TCP probe check)
- `.dev-env.json` is always written at project root, regardless of whether ports are randomized or default:
  ```json
  {
    "backendPort": 12345,
    "pluginPort": 12346,
    "consolePort": 12347
  }
  ```
- `--stop` removes `.dev-env.json`

### 3. Go Backend Auto-Recompile

**Current:** `start_backend` builds once and runs the binary. Changes require manual restart.

**New:**

- After backend starts, init.sh spawns a watcher process in the background
- Watcher uses `inotifywait -m -r -e modify,create,delete,move --include '\.(go|mod|sum)$' backend/` to monitor for Go source and module changes
- On each event, debounce (1 second) to let rapid successive changes settle
- Rebuild strategy (build-then-swap):
  1. Build to temporary binary: `go build -buildvcs=false -o ../bin/backend-tmp .`
  2. If build fails: log error to `.dev-logs/backend.log`, keep current backend running, continue watching
  3. If build succeeds: kill current backend (via PID file), move `backend-tmp` to `backend`, start new process, write new PID to `.dev-pids/backend.pid`
- Watcher gets its own PID file: `.dev-pids/backend-watcher.pid`
- init.sh checks for `inotifywait` at startup. If missing, prints warning and skips the watcher (backend still works, no auto-reload)

### 4. Port Passing to Downstream Scripts

**start-console.sh:**

- Accepts CLI arguments: `--backend-port`, `--plugin-port`, `--console-port`
- Each argument falls back to the current hardcoded default (8080, 9001, 9000) so the script works standalone
- Replaces hardcoded port values in `BRIDGE_PLUGINS`, `BRIDGE_PLUGIN_PROXY`, and the `-p` container port flag

**webpack.config.ts:**

- Dev server port changes from hardcoded `9001` to `Number(process.env.PLUGIN_PORT) || 9001`
- init.sh exports `PLUGIN_PORT` before running `yarn start`

**init.sh invocations:**

```bash
PLUGIN_PORT="$PLUGIN_PORT" yarn start > "$LOG_DIR/webpack.log" 2>&1 &

./start-console.sh \
  --backend-port "$BACKEND_PORT" \
  --plugin-port "$PLUGIN_PORT" \
  --console-port "$CONSOLE_PORT" \
  > "$LOG_DIR/console.log" 2>&1 &
```

### 5. Agent Awareness

Agents need to know where the dev server is running so they can connect to it (e.g. for browser testing or API calls).

- **CLAUDE.md**: Add `.dev-env.json` and `.dev-logs/` to the knowledge base table, noting dev server ports and log file locations respectively
- **WORKFLOW.md**: Add a step to the Startup Sequence (after "Run `./init.sh`") to read `.dev-env.json` and note the ports
- **`.claude/commands/init-session.md`**: Add a step to read `.dev-env.json` and report the ports to the user

## Files Modified

| File | Change |
|------|--------|
| `init.sh` | PID files, `--randomize-ports` flag, `.dev-env.json` output, inotifywait backend watcher, pass ports downstream, `--stop` reads PIDs/CID |
| `start-console.sh` | Accept `--backend-port`, `--plugin-port`, `--console-port` CLI args with fallback defaults |
| `webpack.config.ts` | Read `PLUGIN_PORT` env var with fallback to 9001 |
| `.gitignore` | Add `.dev-pids/` and `.dev-env.json` |
| `.dockerignore` | Add `.dev-pids/` and `.dev-env.json` |
| `CLAUDE.md` | Add `.dev-env.json` and `.dev-logs/` to knowledge base table |
| `docs/WORKFLOW.md` | Add port discovery step to Startup Sequence |
| `.claude/commands/init-session.md` | Add step to read and report dev server ports |

No new files created (besides runtime artifacts which are gitignored/dockerignored).

## Backwards Compatibility

All three modified files retain current default behavior when invoked without the new arguments/env vars. Running `./start-console.sh` directly or `yarn start` without init.sh produces the same ports as today.

## Prerequisites

- `inotify-tools` package for the Go backend watcher. Gracefully degrades if missing (warning printed, watcher skipped).
