#!/usr/bin/env bash

set -euo pipefail

LOG_DIR=".dev-logs"
CONSOLE_IMAGE="${CONSOLE_IMAGE:="quay.io/openshift/origin-console:latest"}"
BACKEND_PORT=8080
PLUGIN_PORT=9001
CONSOLE_PORT=9000
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
        echo "Error: $label process exited. Check $LOG_DIR/ for details."
        exit 1
      fi
    fi
    if [ $elapsed -ge $TIMEOUT ]; then
      echo "Error: $label did not start within ${TIMEOUT}s. Check $LOG_DIR/ for details."
      exit 1
    fi
    echo "Waiting for $label (port $port)... ${elapsed}s"
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
    echo "Stopped $label (PID $pid)."
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
  cat > .dev-env.json <<EOF
{
  "backendPort": $BACKEND_PORT,
  "pluginPort": $PLUGIN_PORT,
  "consolePort": $CONSOLE_PORT
}
EOF
}

build_pages() {
  if ! command -v helm &>/dev/null; then
    echo "Error: helm not found. Install from https://helm.sh/docs/intro/install/"
    exit 1
  fi

  local plugin_name="console-functions-plugin"
  echo "Building pages assets..."
  helm template "$plugin_name" charts/openshift-console-plugin \
    -n "$plugin_name" \
    --set "plugin.image=ghcr.io/functions-dev/${plugin_name}:latest" \
    > backend/static/plugin.yaml
  cp pages/index.html backend/static/index.html
}

extract_cluster_ca() {
  echo "Extracting cluster CA certificate..."
  CA_FILE=$(mktemp -t cluster-ca.XXXXXX).crt
  oc get cm kube-root-ca.crt -n default -o jsonpath='{.data.ca\.crt}' > "$CA_FILE"
}

start_backend() {
  build_pages
  echo "Building Go backend..."
  (cd backend && go build -buildvcs=false -o ../bin/backend .)
  (cd backend && go build -buildvcs=false -o ../bin/errserver ./cmd/errserver)
  echo "Starting Go backend..."
  ./bin/backend --http-port "$BACKEND_PORT" --kube-root-ca-path "$CA_FILE" >>"$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$PID_DIR/backend.pid"
}

start_backend_watcher() {
  if ! command -v inotifywait &>/dev/null; then
    echo "Warning: inotifywait not found. Install inotify-tools for auto-recompile."
    return
  fi

  echo "Starting backend file watcher..."
  (
    while true; do
      if ! inotifywait -r -e modify,create,delete,move --include '\.(go|mod|sum)$' backend/ >/dev/null 2>&1; then
        echo "[watcher] inotifywait failed. Shutting down dev environment."
        stop_dev
        break
      fi
      sleep 1  # debounce

      echo "[watcher] Detected change, rebuilding backend..."
      old_pid=$(cat "$PID_DIR/backend.pid" 2>/dev/null || true)
      build_output=$(cd backend && go build -buildvcs=false -o ../bin/backend-tmp . 2>&1) && build_ok=true || build_ok=false

      if [ -n "$old_pid" ]; then
        kill_tree "$old_pid" 2>/dev/null || true
        while kill -0 "$old_pid" 2>/dev/null; do sleep 0.1; done
      fi

      if $build_ok; then
        mv bin/backend-tmp bin/backend
        ./bin/backend --http-port "$BACKEND_PORT" --kube-root-ca-path "$CA_FILE" >>"$LOG_DIR/backend.log" 2>&1 &
        echo $! > "$PID_DIR/backend.pid"
        echo "[watcher] Backend restarted (PID $!)."
      else
        echo "[watcher] Build failed. Starting error server."
        echo "$build_output"
        rm -f bin/backend-tmp
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
    echo "Stopped OpenShift console (container $cid)."
  fi
  rm -f "$cidfile"
}

stop_dev() {
  stop_backend
  stop_plugin
  stop_console
  rm -f .dev-env.json
}

check_prerequisites() {
  if ! command -v oc &>/dev/null; then
    echo "Error: oc CLI not found. Install from https://console.redhat.com/openshift/downloads"
    exit 1
  fi

  if ! oc whoami &>/dev/null; then
    echo "Error: not logged in to OpenShift. Run 'oc login' first."
    exit 1
  fi

}

install_dependencies() {
  if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    yarn install
  fi
}

start_plugin() {
  echo "Starting plugin dev server..."
  PLUGIN_PORT="$PLUGIN_PORT" yarn start >"$LOG_DIR/webpack.log" 2>&1 &
  echo $! > "$PID_DIR/webpack.pid"
}

start_console() {
  echo "Starting OpenShift console..."
  ./start-console.sh \
    --backend-port "$BACKEND_PORT" \
    --plugin-port "$PLUGIN_PORT" \
    --console-port "$CONSOLE_PORT" \
    --cidfile "$PID_DIR/console.cid" \
    >"$LOG_DIR/console.log" 2>&1 &
  echo $! > "$PID_DIR/console.pid"
}

print_status() {
  echo ""
  echo "Dev environment started:"
  echo "  Backend: http://localhost:$BACKEND_PORT"
  echo "  Console: http://localhost:$CONSOLE_PORT"
  echo "  Logs:    $LOG_DIR/"
  echo ""
  echo "To stop: ./init.sh --stop"
}

main() {
  mkdir -p "$LOG_DIR" "$PID_DIR" bin
  check_prerequisites
  install_dependencies
  stop_dev
  write_dev_env
  extract_cluster_ca
  trap 'stop_dev' EXIT
  start_backend
  wait_for_port "$BACKEND_PORT" "Go backend" "$PID_DIR/backend.pid"
  start_backend_watcher
  start_plugin
  wait_for_port "$PLUGIN_PORT" "Plugin dev server" "$PID_DIR/webpack.pid"
  start_console
  wait_for_port "$CONSOLE_PORT" "OpenShift console" "$PID_DIR/console.pid"
  trap - EXIT
  print_status
}

case "${1:-}" in
  --stop)
    stop_dev
    ;;
  --randomize-ports)
    BACKEND_PORT=$(random_free_port)
    PLUGIN_PORT=$(random_free_port)
    while [ "$PLUGIN_PORT" -eq "$BACKEND_PORT" ]; do
      PLUGIN_PORT=$(random_free_port)
    done
    CONSOLE_PORT=$(random_free_port)
    while [ "$CONSOLE_PORT" -eq "$BACKEND_PORT" ] || [ "$CONSOLE_PORT" -eq "$PLUGIN_PORT" ]; do
      CONSOLE_PORT=$(random_free_port)
    done
    main
    ;;
  "")
    main
    ;;
  *)
    echo "Usage: $0 [--stop | --randomize-ports]"
    exit 1
    ;;
esac
