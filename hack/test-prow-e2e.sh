#!/usr/bin/env bash

set -euo pipefail

# Prow e2e test entrypoint: deploys plugin to ephemeral cluster and runs Playwright.
# Called by: make e2e (CI only)
# Prerequisites: ci-operator cluster with PLUGIN_PULL_SPEC injected

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

ARTIFACT_DIR=${ARTIFACT_DIR:=/tmp/artifacts}
INSTALLER_DIR=${INSTALLER_DIR:=${ARTIFACT_DIR}/installer}

function copyArtifacts {
  if [ -d "$ARTIFACT_DIR" ]; then
    log::info "Copying artifacts from $(pwd)..."
    cp -r .e2e/results "${ARTIFACT_DIR}/" 2>/dev/null || true
    cp -r .e2e/report "${ARTIFACT_DIR}/" 2>/dev/null || true
  fi
}

trap copyArtifacts EXIT

# --- Credentials ---
BRIDGE_KUBEADMIN_PASSWORD="$(cat "${KUBEADMIN_PASSWORD_FILE:-${INSTALLER_DIR}/auth/kubeadmin-password}")"
export BRIDGE_KUBEADMIN_PASSWORD

BRIDGE_BASE_ADDRESS="$(oc get consoles.config.openshift.io cluster -o jsonpath='{.status.consoleURL}')"
export BRIDGE_BASE_ADDRESS

if [[ -z "${PLUGIN_PULL_SPEC:-}" ]]; then
  log::error "PLUGIN_PULL_SPEC is not set. It should be injected by ci-operator as a dependency."
  exit 1
fi

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
