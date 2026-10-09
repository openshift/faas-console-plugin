#!/usr/bin/env bash

set -euo pipefail

# Run a command inside the builder container.
#
# Usage:
#   ./hack/builder-run.sh make lint
#   ./hack/builder-run.sh make unit
#
# E2E (requires KUBECONFIG, PLUGIN_PULL_SPEC, FAKEGITHUB_PULL_SPEC,
# BRIDGE_KUBEADMIN_PASSWORD).
#
#   KUBECONFIG=<kubeconfig PATH> \
#   PLUGIN_PULL_SPEC=$(make plugin-registry | tail -1) \
#   FAKEGITHUB_PULL_SPEC=$(make fakegithub-registry | tail -1) \
#   BRIDGE_KUBEADMIN_PASSWORD=<password> \
#   BRIDGE_KUBEADMIN_USERNAME=cluster-admin \
#     ./hack/builder-run.sh make e2e
#

source "$(dirname "${BASH_SOURCE[0]}")/lib/log.sh"

BUILDER_IMAGE="${BUILDER_IMAGE:-localhost/faas-console-plugin-builder:latest}"
CONTAINER_CMD=podman

ENTRYPOINT=$(cat <<'SCRIPT'
# In presubmits, oc is injected by ci-operator (cli: latest). Locally we download it.
if ! command -v oc &>/dev/null; then
  OC_ARCH=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/')
  curl -fsSL "https://mirror.openshift.com/pub/openshift-v4/${OC_ARCH}/clients/ocp/stable/openshift-client-linux.tar.gz" | tar xz -C /tmp oc
  export PATH=/tmp:$PATH
fi

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

for VAR in PLUGIN_PULL_SPEC FAKEGITHUB_PULL_SPEC BRIDGE_KUBEADMIN_PASSWORD BRIDGE_KUBEADMIN_USERNAME; do
  if [ -n "${!VAR:-}" ]; then
    ENV_STR+=("-e" "$VAR")
  fi
done

if [[ "$*" == *"e2e"* ]]; then
  # Pre-flight: catch missing required vars before the container starts.
  # PLUGIN_PULL_SPEC and FAKEGITHUB_PULL_SPEC are also checked inside
  # hack/test-prow-e2e.sh, but KUBECONFIG and BRIDGE_KUBEADMIN_PASSWORD
  # produce confusing downstream errors if absent.
  MISSING=()
  [[ -z "${KUBECONFIG:-}" ]]                 && MISSING+=("KUBECONFIG")
  [[ -z "${PLUGIN_PULL_SPEC:-}" ]]           && MISSING+=("PLUGIN_PULL_SPEC")
  [[ -z "${FAKEGITHUB_PULL_SPEC:-}" ]]       && MISSING+=("FAKEGITHUB_PULL_SPEC")
  [[ -z "${BRIDGE_KUBEADMIN_PASSWORD:-}" ]]  && MISSING+=("BRIDGE_KUBEADMIN_PASSWORD")
  if [[ ${#MISSING[@]} -gt 0 ]]; then
    log::error "Missing required env vars for e2e: ${MISSING[*]}"
    exit 1
  fi

  # E2e tests that trigger func build --strategy=s2i cannot pass on CRC (OpenShift Local).
  # See hack/fakegithub-entrypoint.sh for the full technical explanation.
  if oc --kubeconfig="$KUBECONFIG" whoami --show-server 2>/dev/null | grep -q 'api.crc.testing'; then
    log::error "E2e tests cannot run against CRC (OpenShift Local)."
    log::error "Use a ROSA or installer-provisioned OpenShift cluster to run e2e tests."
    exit 1
  fi

  log::step "Setting up Serverless"
  KUBECONFIG="$KUBECONFIG" make setup-serverless
fi

log::step "Building builder image"
if ! $CONTAINER_CMD build -f Dockerfile.buildroot -t "$BUILDER_IMAGE" . >/dev/null; then
  log::error "Failed to build builder image"
  exit 1
fi
log::info "Done"

log::step "Running: $*"
if $CONTAINER_CMD run "${ENV_STR[@]}" --rm -it \
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
