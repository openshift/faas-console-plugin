#!/usr/bin/env bash

set -euo pipefail

# Prow e2e test entrypoint: deploys plugin to ephemeral cluster and runs Playwright.
# Called by: make e2e (CI only)
# Prerequisites: ci-operator cluster with PLUGIN_PULL_SPEC injected

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:=/tmp/artifacts}
INSTALLER_DIR=${INSTALLER_DIR:=${ARTIFACT_DIR}/installer}

# Namespace for plugin and fake GitHub deployments.
# Exported so deploy-fake-gh.sh inherits the same value.
export NAMESPACE="${NAMESPACE:-console-functions-plugin}"

function copyArtifacts {
  if [ -d "$ARTIFACT_DIR" ]; then
    log::info "Copying artifacts from $(pwd)..."
    cp -r .e2e/results "${ARTIFACT_DIR}/" 2>/dev/null || true
    cp -r .e2e/report "${ARTIFACT_DIR}/" 2>/dev/null || true
  fi
}

FAKE_GH_PF_PID=""

function cleanup {
  copyArtifacts
  if [ -n "$FAKE_GH_PF_PID" ]; then
    kill "$FAKE_GH_PF_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT

# --- Credentials ---
BRIDGE_KUBEADMIN_PASSWORD="$(cat "${KUBEADMIN_PASSWORD_FILE:-${INSTALLER_DIR}/auth/kubeadmin-password}")"
export BRIDGE_KUBEADMIN_PASSWORD

BRIDGE_BASE_ADDRESS="$(oc get consoles.config.openshift.io cluster -o jsonpath='{.status.consoleURL}')"
export BRIDGE_BASE_ADDRESS

if [[ -z "${PLUGIN_PULL_SPEC:-}" ]]; then
  log::error "PLUGIN_PULL_SPEC is not set. It should be injected by ci-operator as a dependency."
  exit 1
fi

# --- Deploy fake GitHub server ---
log::step "Deploying fake GitHub server"

FAKE_GH_URL=$(hack/deploy-fake-gh.sh | tail -1)
export GH_API_URL="${FAKE_GH_URL}"

# Port-forward fake GH for Playwright admin API access (Playwright runs outside cluster)
oc port-forward svc/fakegithub 8090:8090 -n "${NAMESPACE}" &
FAKE_GH_PF_PID=$!
sleep 3
export FAKE_GITHUB_URL="http://localhost:8090"

# --- Deploy plugin ---
log::step "Deploying plugin to cluster"

make deploy IMAGE="${PLUGIN_PULL_SPEC}"

# --- Install deps and run tests ---
log::step "Running e2e tests"

log::info "Installing dependencies..."
make install-frontend

log::info "Installing Playwright browsers..."
npx playwright install chromium

log::info "Running Playwright e2e tests..."
make test-e2e
