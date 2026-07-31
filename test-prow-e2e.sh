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
HELM_VERSION="v3.21.3"
HELM_INSTALL_DIR="$(mktemp -d)"
case "$(uname -m)" in
  x86_64)  HELM_ARCH="amd64"; HELM_SHA256="15e041a93a590dce8100f39385cd98c84a765c9e36aeeb9e2dc6ff9e4769e2e0" ;;
  aarch64) HELM_ARCH="arm64"; HELM_SHA256="67f58155079ff9ffab98ba5c88daff0ed9b542f3a4732f5dd426dde7dd0f5244" ;;
  *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
esac
HELM_TARBALL="helm-${HELM_VERSION}-linux-${HELM_ARCH}.tar.gz"
curl -fsSL -o "${HELM_INSTALL_DIR}/${HELM_TARBALL}" "https://get.helm.sh/${HELM_TARBALL}"
echo "${HELM_SHA256}  ${HELM_INSTALL_DIR}/${HELM_TARBALL}" | sha256sum --check
tar -xzf "${HELM_INSTALL_DIR}/${HELM_TARBALL}" -C "${HELM_INSTALL_DIR}" --strip-components=1 "linux-${HELM_ARCH}/helm"
rm -f "${HELM_INSTALL_DIR}/${HELM_TARBALL}"
export PATH="${HELM_INSTALL_DIR}:${PATH}"
echo "Helm installed: $(helm version --short)"

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
