#!/usr/bin/env bash

set -exuo pipefail

ARTIFACT_DIR=${ARTIFACT_DIR:=/tmp/artifacts}
INSTALLER_DIR=${INSTALLER_DIR:=${ARTIFACT_DIR}/installer}
PLUGIN_NAME="console-functions-plugin"
PLUGIN_NAMESPACE="console-functions-plugin"

function copyArtifacts {
  if [ -d "$ARTIFACT_DIR" ]; then
    echo "Copying artifacts from $(pwd)..."
    cp -r .e2e/results "${ARTIFACT_DIR}/" 2>/dev/null || true
    cp -r .e2e/report "${ARTIFACT_DIR}/" 2>/dev/null || true
  fi
}

trap copyArtifacts EXIT

# --- Credentials ---
set +x
BRIDGE_KUBEADMIN_PASSWORD="$(cat "${KUBEADMIN_PASSWORD_FILE:-${INSTALLER_DIR}/auth/kubeadmin-password}")"
export BRIDGE_KUBEADMIN_PASSWORD
set -x

BRIDGE_BASE_ADDRESS="$(oc get consoles.config.openshift.io cluster -o jsonpath='{.status.consoleURL}')"
export BRIDGE_BASE_ADDRESS

echo "Console URL: ${BRIDGE_BASE_ADDRESS}"

if [[ -z "${PLUGIN_PULL_SPEC:-}" ]]; then
  echo "Error: PLUGIN_PULL_SPEC is not set. It should be injected by ci-operator as a dependency."
  exit 1
fi

# --- Install Helm ---
echo "Installing Helm..."
HELM_DIR=$(mktemp -d)
export PATH="$HELM_DIR:$PATH"
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | HELM_INSTALL_DIR="$HELM_DIR" bash -s -- --no-sudo --version v3.21.3

# --- Deploy plugin ---
oc new-project "${PLUGIN_NAMESPACE}" || oc project "${PLUGIN_NAMESPACE}"

helm install "${PLUGIN_NAME}" charts/openshift-console-plugin \
  -n "${PLUGIN_NAMESPACE}" \
  --set "plugin.image=${PLUGIN_PULL_SPEC}" \
  --set "plugin.name=${PLUGIN_NAME}"

echo "Waiting for plugin deployment rollout..."
oc rollout status deployment/"${PLUGIN_NAME}" -n "${PLUGIN_NAMESPACE}" --timeout=300s

echo "Waiting for ConsolePlugin CR..."
for i in $(seq 1 60); do
  if oc get consoleplugins "${PLUGIN_NAME}" &>/dev/null; then
    echo "ConsolePlugin CR found."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Error: ConsolePlugin CR did not appear within 120s."
    oc get all -n "${PLUGIN_NAMESPACE}"
    exit 1
  fi
  sleep 2
done

echo "Enabling plugin on the console..."
oc patch consoles.operator.openshift.io cluster \
  --type=json \
  --patch='[{"op":"add","path":"/spec/plugins/-","value":"'"${PLUGIN_NAME}"'"}]'

echo "Restarting console pods to pick up the plugin..."
oc rollout restart deployment/console -n openshift-console
oc rollout status deployment/console -n openshift-console --timeout=300s

# --- Install deps and run tests ---
echo "Installing dependencies..."
yarn install --immutable

echo "Installing Playwright browsers..."
npx playwright install --with-deps chromium

echo "Running Playwright e2e tests..."
yarn test:e2e
