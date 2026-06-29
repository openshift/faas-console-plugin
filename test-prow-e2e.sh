#!/usr/bin/env bash
# TODO: Update for Playwright. Requires a Playwright-compatible CI image
# (see .ci-operator.yaml) and npx playwright install chromium before running.

set -exuo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:=/tmp/artifacts}
RESULTS_DIR=e2e/results
REPORT_DIR=playwright-report
INSTALLER_DIR=${INSTALLER_DIR:=${ARTIFACT_DIR}/installer}

function copyArtifacts {
  for dir in "$RESULTS_DIR" "$REPORT_DIR"; do
    if [ -d "$ARTIFACT_DIR" ] && [ -d "$dir" ]; then
      if [[ -n "$(ls -A -- "$dir")" ]]; then
        echo "Copying artifacts from $dir..."
        cp -r "$dir" "${ARTIFACT_DIR}/$(basename "$dir")"
      fi
    fi
  done
}

trap copyArtifacts EXIT

# don't log kubeadmin-password
set +x
BRIDGE_KUBEADMIN_PASSWORD="$(cat "${KUBEADMIN_PASSWORD_FILE:-${INSTALLER_DIR}/auth/kubeadmin-password}")"
export BRIDGE_KUBEADMIN_PASSWORD
set -x
BRIDGE_BASE_ADDRESS="$(oc get consoles.config.openshift.io cluster -o jsonpath='{.status.consoleURL}')"
export BRIDGE_BASE_ADDRESS

echo "Install dependencies"
if [ ! -d node_modules ]; then
  yarn install --immutable
fi

echo "Install Playwright browsers"
npx playwright install chromium

echo "Run Playwright e2e tests"
yarn test:e2e
