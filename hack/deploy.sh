#!/usr/bin/env bash
set -euo pipefail

# Build container image, push to internal OCP registry, deploy plugin.
# Prerequisites: oc login
# Optional: make setup-serverless (for full Knative/Serverless functionality)
# Usage: make deploy-dev [IMAGE_TAG=...] [NAMESPACE=...]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

NAMESPACE="${NAMESPACE:-console-functions-plugin}"
IMAGE_TAG="${IMAGE_TAG:-localhost/faas-console-plugin:latest}"
PLUGIN_NAME="console-functions-plugin"
CONTAINER_CMD=$(command -v podman 2>/dev/null || echo docker)
REGISTRY_PORT=5001
INTERNAL_REGISTRY="image-registry.openshift-image-registry.svc:5000"

# --- Prerequisites ---

if ! command -v oc &>/dev/null; then
  log::error "oc CLI not found. Install from https://console.redhat.com/openshift/downloads"
  exit 1
fi

if ! oc whoami &>/dev/null; then
  log::error "Not logged in to OpenShift. Run 'oc login' first."
  exit 1
fi

# --- Build ---

log::step "Building image"
make image IMAGE_TAG="$IMAGE_TAG"

# --- Push to internal registry ---

log::step "Pushing to internal registry"

# Port-forward the internal registry service.
# On macOS, podman runs in a VM that can't reach localhost, so we bind to all
# interfaces and push via the host's LAN IP. On Linux, localhost works directly.
if [[ "$(uname)" == "Darwin" ]]; then
  PUSH_TARGET=$(ifconfig | awk '/inet / && !/127.0.0.1/ {print $2; exit}')
  if [ -z "$PUSH_TARGET" ]; then
    log::error "Could not determine host IP address."
    exit 1
  fi
  PUSH_TARGET="${PUSH_TARGET}:${REGISTRY_PORT}"
else
  PUSH_TARGET="localhost:${REGISTRY_PORT}"
fi

oc get namespace "$NAMESPACE" &>/dev/null 2>&1 || oc create namespace "$NAMESPACE"

log::info "Port-forwarding registry to ${PUSH_TARGET}..."
kubectl port-forward svc/image-registry \
  --address='::' --address='0.0.0.0' \
  "${REGISTRY_PORT}:5000" \
  -n openshift-image-registry &
PF_PID=$!
trap "kill $PF_PID 2>/dev/null || true" EXIT
sleep 5

PUSH_IMAGE="${PUSH_TARGET}/${NAMESPACE}/${PLUGIN_NAME}:latest"

log::info "Logging in to registry..."
$CONTAINER_CMD login "$PUSH_TARGET" \
  -u unused -p "$(oc whoami -t)" --tls-verify=false

$CONTAINER_CMD tag "$IMAGE_TAG" "$PUSH_IMAGE"

DIGEST_FILE=$(mktemp /tmp/plugin-digest.XXXXXX)
log::info "Pushing image..."
$CONTAINER_CMD push "$PUSH_IMAGE" --tls-verify=false --digestfile "$DIGEST_FILE"

DIGEST=$(cat "$DIGEST_FILE")
rm -f "$DIGEST_FILE"
DEPLOY_IMAGE="${INTERNAL_REGISTRY}/${NAMESPACE}/${PLUGIN_NAME}:latest@${DIGEST}"

kill $PF_PID 2>/dev/null || true
trap - EXIT

# --- Deploy ---

log::step "Deploying plugin via Helm"
make deploy IMAGE="$DEPLOY_IMAGE" NAMESPACE="$NAMESPACE"
