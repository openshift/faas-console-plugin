#!/usr/bin/env bash

set -euo pipefail

# Parse CLI arguments (all optional, with defaults)
BACKEND_PORT=8080
PLUGIN_PORT=9001
CIDFILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --plugin-port) PLUGIN_PORT="$2"; shift 2 ;;
    --console-port) CONSOLE_PORT="$2"; shift 2 ;;
    --cidfile) CIDFILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

CONSOLE_IMAGE=${CONSOLE_IMAGE:="quay.io/openshift/origin-console:latest"}
CONSOLE_PORT=${CONSOLE_PORT:-9000}
CONSOLE_IMAGE_PLATFORM=${CONSOLE_IMAGE_PLATFORM:="linux/amd64"}

# Plugin metadata is declared in package.json
PLUGIN_NAME="console-functions-plugin"

echo "Starting local OpenShift console..."

set -a
BRIDGE_USER_AUTH="disabled"
BRIDGE_K8S_MODE="off-cluster"
BRIDGE_K8S_AUTH="bearer-token"
BRIDGE_K8S_MODE_OFF_CLUSTER_SKIP_VERIFY_TLS=true
BRIDGE_K8S_MODE_OFF_CLUSTER_ENDPOINT=$(oc whoami --show-server)
# The monitoring operator is not always installed (e.g. for local OpenShift). Tolerate missing config maps.
set +e
BRIDGE_K8S_MODE_OFF_CLUSTER_THANOS=$(oc -n openshift-config-managed get configmap monitoring-shared-config -o jsonpath='{.data.thanosPublicURL}' 2>/dev/null)
BRIDGE_K8S_MODE_OFF_CLUSTER_ALERTMANAGER=$(oc -n openshift-config-managed get configmap monitoring-shared-config -o jsonpath='{.data.alertmanagerPublicURL}' 2>/dev/null)
set -e
BRIDGE_K8S_AUTH_BEARER_TOKEN=$(oc whoami --show-token 2>/dev/null)
BRIDGE_USER_SETTINGS_LOCATION="localstorage"
BRIDGE_I18N_NAMESPACES="plugin__${PLUGIN_NAME}"

# Don't fail if the cluster doesn't have gitops.
set +e
GITOPS_HOSTNAME=$(oc -n openshift-gitops get route cluster -o jsonpath='{.spec.host}' 2>/dev/null)
set -e
if [ -n "$GITOPS_HOSTNAME" ]; then
    BRIDGE_K8S_MODE_OFF_CLUSTER_GITOPS="https://$GITOPS_HOSTNAME"
fi

echo "API Server: $BRIDGE_K8S_MODE_OFF_CLUSTER_ENDPOINT"
echo "Console Image: $CONSOLE_IMAGE"
echo "Console URL: http://localhost:${CONSOLE_PORT}"
echo "Console Platform: $CONSOLE_IMAGE_PLATFORM"

# Prefer podman if installed. Otherwise, fall back to docker.
if [ -x "$(command -v podman)" ]; then
    CONTAINER_CMD="podman"
    PLUGIN_HOST="host.containers.internal"
else
    CONTAINER_CMD="docker"
    PLUGIN_HOST="host.docker.internal"
fi
CONTAINER_NETWORK_OPTS="-p ${CONSOLE_PORT}:9000"
if [[ "$BRIDGE_K8S_MODE_OFF_CLUSTER_ENDPOINT" == *"crc.testing"* ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
        HOST_GW=$(podman machine ssh "ip route show default" 2>/dev/null | awk '{print $3}')
        if [ -n "$HOST_GW" ]; then
            CONTAINER_NETWORK_OPTS="${CONTAINER_NETWORK_OPTS} --add-host api.crc.testing:${HOST_GW}"
        fi
    else
        CONTAINER_NETWORK_OPTS="${CONTAINER_NETWORK_OPTS} --add-host api.crc.testing:host-gateway"
    fi
fi

BRIDGE_PLUGINS="${PLUGIN_NAME}=http://${PLUGIN_HOST}:${PLUGIN_PORT}"
BRIDGE_PLUGIN_PROXY='{"services":[{"consoleAPIPath":"/api/proxy/plugin/'"${PLUGIN_NAME}"'/backend/","endpoint":"http://'"${PLUGIN_HOST}"':'"${BACKEND_PORT}"'","authorize":false}]}'

# Allow browser to connect to GitHub API (CSP connect-src).
# Production uses ConsolePlugin.spec.contentSecurityPolicy instead.
BRIDGE_CONTENT_SECURITY_POLICY="connect-src=https://api.github.com"

echo "BRIDGE_PLUGINS=$BRIDGE_PLUGINS"
echo "BRIDGE_PLUGIN_PROXY=$BRIDGE_PLUGIN_PROXY"

CIDFILE_OPTS=""
if [ -n "$CIDFILE" ]; then
  CIDFILE_OPTS="--cidfile $CIDFILE"
fi

$CONTAINER_CMD run --pull always --platform $CONSOLE_IMAGE_PLATFORM --rm $CIDFILE_OPTS $CONTAINER_NETWORK_OPTS --env-file <(env | grep ^BRIDGE) $CONSOLE_IMAGE
