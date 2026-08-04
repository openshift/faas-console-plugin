#!/usr/bin/env bash

set -euo pipefail

# Run a command inside the builder container.
#
# Usage:
#   ./hack/builder-run.sh make lint
#   ./hack/builder-run.sh make unit
#
# E2E (requires KUBECONFIG, PLUGIN_PULL_SPEC, and BRIDGE_KUBEADMIN_PASSWORD).
# Tests that deploy Knative services need the Serverless Operator installed
# on the cluster beforehand. Run "make setup-serverless" once before the
# first e2e run (it is idempotent).
#
#   KUBECONFIG=<kubeconfig PATH> \
#   PLUGIN_PULL_SPEC=<a publicly accessible/accessible in the cluster image tag> \
#   BRIDGE_KUBEADMIN_PASSWORD=<password> \
#   CONTAINER_ENV=PLUGIN_PULL_SPEC,BRIDGE_KUBEADMIN_PASSWORD \
#     ./hack/builder-run.sh make e2e
#

source "$(dirname "${BASH_SOURCE[0]}")/lib/log.sh"

BUILDER_IMAGE="${BUILDER_IMAGE:-localhost/faas-console-plugin-builder:latest}"
CONTAINER_CMD=podman

log::step "Building builder image"
if ! $CONTAINER_CMD build -f Dockerfile.builder -t "$BUILDER_IMAGE" . >/dev/null; then
  log::error "Failed to build builder image"
  exit 1
fi
log::info "Done"

ENTRYPOINT=$(cat <<'SCRIPT'
# In presubmits, oc is injected by ci-operator (cli: latest). Locally we download it.
OC_ARCH=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/')
curl -fsSL "https://mirror.openshift.com/pub/openshift-v4/${OC_ARCH}/clients/ocp/stable/openshift-client-linux.tar.gz" | tar xz -C /tmp oc
export PATH=/tmp:$PATH

if [ -n "${BRIDGE_KUBEADMIN_PASSWORD:-}" ]; then
  echo -n "$BRIDGE_KUBEADMIN_PASSWORD" > /tmp/kubeadmin-password
  export KUBEADMIN_PASSWORD_FILE=/tmp/kubeadmin-password
fi


# Source is mounted read-only at /src to prevent container writes leaking to the host.
# Copy to a writable directory so build tools (yarn, go) can write output.
cp -r /src/. .

exec "$@"
SCRIPT
)

ENV_STR=()
VOLUME_MOUNT=()
ARTIFACT_DIR="${ARTIFACT_DIR:-$(pwd)/.e2e/artifacts}"
mkdir -p "$ARTIFACT_DIR"
VOLUME_MOUNT+=("-v" "$ARTIFACT_DIR:/tmp/artifacts:Z")
ENV_STR+=("-e" "ARTIFACT_DIR=/tmp/artifacts")

if [ -n "${KUBECONFIG:-}" ]; then
  VOLUME_MOUNT+=("-v" "$KUBECONFIG:/kube/config:ro,Z")
  ENV_STR+=("-e" "KUBECONFIG=/kube/config")
fi

for VAR in ${CONTAINER_ENV//,/ }; do
  ENV_STR+=("-e" "$VAR=${!VAR}")
done

NETWORK_OPTS=()
if grep -q 'api.crc.testing' "${KUBECONFIG:-/dev/null}" 2>/dev/null; then
  if [[ "$(uname)" == "Linux" ]]; then
    NETWORK_OPTS+=(--net=host)
  else
    NETWORK_OPTS+=(--add-host "api.crc.testing:host-gateway")
    NETWORK_OPTS+=(--add-host "console-openshift-console.apps-crc.testing:host-gateway")
    NETWORK_OPTS+=(--add-host "oauth-openshift.apps-crc.testing:host-gateway")
  fi
fi

log::step "Running: $*"
if $CONTAINER_CMD run "${ENV_STR[@]}" --rm -it ${NETWORK_OPTS[@]+"${NETWORK_OPTS[@]}"} \
  --shm-size=512m \
  "${VOLUME_MOUNT[@]}" \
  -v "$(pwd)":/src:ro,Z \
  -w /opt/app-root/src \
  "$BUILDER_IMAGE" sh -c "$ENTRYPOINT" -- "$@"; then
  log::info "SUCCESS"
else
  log::error "FAILED"
  exit 1
fi
