#!/usr/bin/env bash

set -euo pipefail

# Start local dev environment: Go backend + webpack dev server + console container.
# Prerequisites: oc login
# Optional: make setup-serverless (for full Knative/Serverless functionality)
# Usage: make dev | make dev-stop | make dev-randomize-ports | make dev-fake-gh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

LOG_DIR=".dev-logs"
CONSOLE_IMAGE="${CONSOLE_IMAGE:="quay.io/openshift/origin-console:latest"}"
BACKEND_PORT=8080
PLUGIN_PORT=9001
CONSOLE_PORT=9000
FAKE_GH=false
FAKE_GH_PORT=8090
TIMEOUT=60
PID_DIR=".dev-pids"

wait_for_port() {
  local port=$1
  local label=$2
  local pidfile="${3:-}"
  local elapsed=0

  while ! bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; do
    if [ -n "$pidfile" ] && [ -f "$pidfile" ]; then
      local pid
      pid=$(cat "$pidfile")
      if ! kill -0 "$pid" 2>/dev/null; then
        log::error "$label process exited. Check $LOG_DIR/ for details."
        exit 1
      fi
    fi
    if [ $elapsed -ge $TIMEOUT ]; then
      log::error "$label did not start within ${TIMEOUT}s. Check $LOG_DIR/ for details."
      exit 1
    fi
    log::waiting "Waiting for $label (port $port)... ${elapsed}s"
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

kill_tree() {
  local pid=$1
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for child in $children; do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

stop_pid() {
  local pidfile="$PID_DIR/$1"
  local label=$2

  if [ ! -f "$pidfile" ]; then
    return
  fi

  local pid
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
    log::info "Stopped $label (PID $pid)."
  fi
  rm -f "$pidfile"
}

random_free_port() {
  local port
  while true; do
    port=$((RANDOM % 50001 + 10000))
    if ! bash -c "echo >/dev/tcp/localhost/$port" 2>/dev/null; then
      echo "$port"
      return
    fi
  done
}

write_dev_env() {
  if $FAKE_GH; then
    cat > .dev-env.json <<EOF
{
  "backendPort": $BACKEND_PORT,
  "pluginPort": $PLUGIN_PORT,
  "consolePort": $CONSOLE_PORT,
  "fakeGithubPort": $FAKE_GH_PORT
}
EOF
  else
    cat > .dev-env.json <<EOF
{
  "backendPort": $BACKEND_PORT,
  "pluginPort": $PLUGIN_PORT,
  "consolePort": $CONSOLE_PORT
}
EOF
  fi
}

extract_cluster_ca() {
  log::info "Extracting cluster CA certificate..."
  CA_FILE=$(mktemp -t cluster-ca.XXXXXX).crt
  oc get cm kube-root-ca.crt -n default -o jsonpath='{.data.ca\.crt}' > "$CA_FILE"
}

resolve_kube_api_server() {
  log::info "Resolving cluster API server URL..."
  export KUBE_API_SERVER=$(oc whoami --show-server)
}

backend_gh_flag() {
  if $FAKE_GH; then
    echo "--gh-api-url http://localhost:$FAKE_GH_PORT"
  fi
}

start_backend() {
  log::info "Building Go backend..."
  make build-backend
  (cd backend && go build -buildvcs=false -o ../bin/errserver ./cmd/errserver)
  log::info "Starting Go backend..."
  ./bin/plugin-backend --http-port "$BACKEND_PORT" --kube-root-ca-path "$CA_FILE" --kube-host "$KUBE_API_SERVER" --external-api-server-url "$KUBE_API_SERVER" $(backend_gh_flag) >>"$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$PID_DIR/backend.pid"
}

start_backend_watcher() {
  if ! command -v fswatch &>/dev/null; then
    log::warn "fswatch not found. Install fswatch for auto-recompile."
    return
  fi

  log::info "Starting backend file watcher..."
  (
    while true; do
      if ! fswatch -1 -E -r -e '.*' -i '\.(go|mod|sum)$' backend/ >/dev/null 2>&1; then
        echo "[watcher] fswatch failed. Shutting down dev environment."
        stop_dev
        break
      fi
      sleep 1  # debounce

      echo "[watcher] Detected change, rebuilding backend..."
      old_pid=$(cat "$PID_DIR/backend.pid" 2>/dev/null || true)
      build_output=$(cd backend && go build -buildvcs=false -o ../bin/plugin-backend-tmp . 2>&1) && build_ok=true || build_ok=false

      if [ -n "$old_pid" ]; then
        kill_tree "$old_pid" 2>/dev/null || true
        while kill -0 "$old_pid" 2>/dev/null; do sleep 0.1; done
      fi

      if $build_ok; then
        mv bin/plugin-backend-tmp bin/plugin-backend
        ./bin/plugin-backend --http-port "$BACKEND_PORT" --kube-root-ca-path "$CA_FILE" --kube-host "$KUBE_API_SERVER" --external-api-server-url "$KUBE_API_SERVER" $(backend_gh_flag) >>"$LOG_DIR/backend.log" 2>&1 &
        echo $! > "$PID_DIR/backend.pid"
        echo "[watcher] Backend restarted (PID $!)."
      else
        echo "[watcher] Build failed. Starting error server."
        echo "$build_output"
        rm -f bin/plugin-backend-tmp
        echo "$build_output" > "$LOG_DIR/backend-build-error.txt"
        ./bin/errserver --port "$BACKEND_PORT" --msg-file "$LOG_DIR/backend-build-error.txt" >>"$LOG_DIR/backend.log" 2>&1 &
        errserver_pid=$!
        sleep 0.5
        if ! kill -0 "$errserver_pid" 2>/dev/null; then
          echo "[watcher] Error server failed to start. Shutting down."
          stop_dev
          break
        fi
        echo "$errserver_pid" > "$PID_DIR/backend.pid"
      fi

    done
  ) >>"$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$PID_DIR/backend-watcher.pid"
}

start_fakegithub() {
  log::info "Building fake GitHub server..."
  make build-fakegithub
  log::info "Starting fake GitHub server..."
  ./bin/fakegithub --port "$FAKE_GH_PORT" >>"$LOG_DIR/fakegithub.log" 2>&1 &
  echo $! > "$PID_DIR/fakegithub.pid"
}

stop_fakegithub() {
  stop_pid "fakegithub.pid" "fake GitHub server"
}

stop_backend() {
  stop_pid "backend-watcher.pid" "backend watcher"
  stop_pid "backend.pid" "Go backend"
}

stop_plugin() {
  stop_pid "webpack.pid" "plugin dev server"
}

stop_console() {
  local cidfile="$PID_DIR/console.cid"

  if [ ! -f "$cidfile" ]; then
    return
  fi

  local cid
  cid=$(cat "$cidfile")
  if podman stop "$cid" >/dev/null 2>&1; then
    log::info "Stopped OpenShift console (container $cid)."
  fi
  rm -f "$cidfile"
}

stop_dev() {
  stop_fakegithub
  stop_backend
  stop_plugin
  stop_console
  rm -f .dev-env.json
}

check_prerequisites() {
  if ! command -v oc &>/dev/null; then
    log::error "oc CLI not found. Install from https://console.redhat.com/openshift/downloads"
    exit 1
  fi

  if ! oc whoami &>/dev/null; then
    log::error "Not logged in to OpenShift. Run 'oc login' first."
    exit 1
  fi
}

install_dependencies() {
  if [ ! -d "node_modules" ]; then
    log::info "Installing dependencies..."
    yarn install
  fi
}

start_plugin() {
  log::info "Starting plugin dev server..."
  PLUGIN_PORT="$PLUGIN_PORT" yarn start >"$LOG_DIR/webpack.log" 2>&1 &
  echo $! > "$PID_DIR/webpack.pid"
}

start_console() {
  log::info "Starting OpenShift console..."
  ./hack/start-console.sh \
    --backend-port "$BACKEND_PORT" \
    --plugin-port "$PLUGIN_PORT" \
    --console-port "$CONSOLE_PORT" \
    --cidfile "$PID_DIR/console.cid" \
    >"$LOG_DIR/console.log" 2>&1 &
  echo $! > "$PID_DIR/console.pid"
}

print_status() {
  log::step "Dev environment started"
  log::link "Backend" "http://localhost:$BACKEND_PORT/api/v1/..."
  if $FAKE_GH; then
    log::link "Fake GitHub" "http://localhost:$FAKE_GH_PORT"
  fi
  log::link "Console" "http://localhost:$CONSOLE_PORT"
  log::link "Logs" "$LOG_DIR/"
  log::hint "To stop: make dev-stop"
  log::hint "For full Knative integration: make setup-serverless"
}

main() {
  log::step "Starting local dev environment"
  mkdir -p "$LOG_DIR" "$PID_DIR" bin
  check_prerequisites
  install_dependencies
  stop_dev
  write_dev_env
  extract_cluster_ca
  resolve_kube_api_server
  trap 'stop_dev' EXIT INT TERM
  if $FAKE_GH; then
    start_fakegithub
    wait_for_port "$FAKE_GH_PORT" "Fake GitHub server" "$PID_DIR/fakegithub.pid"
  fi
  start_backend
  wait_for_port "$BACKEND_PORT" "Go backend" "$PID_DIR/backend.pid"
  start_backend_watcher
  start_plugin
  wait_for_port "$PLUGIN_PORT" "Plugin dev server" "$PID_DIR/webpack.pid"
  start_console
  wait_for_port "$CONSOLE_PORT" "OpenShift console" "$PID_DIR/console.pid"
  trap - EXIT INT TERM
  print_status
}

RANDOMIZE_PORTS=false

for arg in "$@"; do
  case "$arg" in
    --stop)
      stop_dev
      exit 0
      ;;
    --fake-gh)
      FAKE_GH=true
      ;;
    --randomize-ports)
      RANDOMIZE_PORTS=true
      ;;
    *)
      echo "Usage: $0 [--stop] [--randomize-ports] [--fake-gh]"
      exit 1
      ;;
  esac
done

if $RANDOMIZE_PORTS; then
  BACKEND_PORT=$(random_free_port)
  PLUGIN_PORT=$(random_free_port)
  while [ "$PLUGIN_PORT" -eq "$BACKEND_PORT" ]; do
    PLUGIN_PORT=$(random_free_port)
  done
  CONSOLE_PORT=$(random_free_port)
  while [ "$CONSOLE_PORT" -eq "$BACKEND_PORT" ] || [ "$CONSOLE_PORT" -eq "$PLUGIN_PORT" ]; do
    CONSOLE_PORT=$(random_free_port)
  done
  if $FAKE_GH; then
    FAKE_GH_PORT=$(random_free_port)
    while [ "$FAKE_GH_PORT" -eq "$BACKEND_PORT" ] || [ "$FAKE_GH_PORT" -eq "$PLUGIN_PORT" ] || [ "$FAKE_GH_PORT" -eq "$CONSOLE_PORT" ]; do
      FAKE_GH_PORT=$(random_free_port)
    done
  fi
fi

main
