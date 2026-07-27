#!/usr/bin/env bash
#
# Dry-run of test-prow-e2e.sh against a local cluster.
# Simulates the Prow environment using your oc session.
#
# Prerequisites:
#   - oc login to a cluster with Serverless operator installed
#   - Plugin image built and accessible (or provide PLUGIN_PULL_SPEC)
#
# Usage:
#   ./hack/test-e2e-local.sh                          # uses latest ghcr image
#   PLUGIN_PULL_SPEC=my-image:tag ./hack/test-e2e-local.sh  # custom image
#

set -euo pipefail

PLUGIN_NAME="console-functions-plugin"
PLUGIN_NAMESPACE="console-functions-plugin"

if ! oc whoami &>/dev/null; then
  echo "Error: not logged in to OpenShift. Run 'oc login' first."
  exit 1
fi

if ! command -v helm &>/dev/null; then
  echo "Error: helm not found. Install from https://helm.sh/docs/intro/install/"
  exit 1
fi

PLUGIN_PULL_SPEC="${PLUGIN_PULL_SPEC:-ghcr.io/openshift/faas-console-plugin:latest}"
BRIDGE_BASE_ADDRESS="$(oc get consoles.config.openshift.io cluster -o jsonpath='{.status.consoleURL}')"

echo "Cluster API:    $(oc whoami --show-server)"
echo "Console URL:    ${BRIDGE_BASE_ADDRESS}"
echo "Plugin image:   ${PLUGIN_PULL_SPEC}"
echo ""

# --- Deploy plugin ---
echo "==> Deploying plugin to cluster..."
oc new-project "${PLUGIN_NAMESPACE}" 2>/dev/null || oc project "${PLUGIN_NAMESPACE}"

helm upgrade --install "${PLUGIN_NAME}" charts/openshift-console-plugin \
  -n "${PLUGIN_NAMESPACE}" \
  --set "plugin.image=${PLUGIN_PULL_SPEC}" \
  --set "plugin.name=${PLUGIN_NAME}"

echo "==> Waiting for deployment rollout..."
oc rollout status deployment/"${PLUGIN_NAME}" -n "${PLUGIN_NAMESPACE}" --timeout=300s

echo "==> Waiting for ConsolePlugin CR..."
for i in $(seq 1 60); do
  if oc get consoleplugins "${PLUGIN_NAME}" &>/dev/null; then
    echo "ConsolePlugin CR found."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Error: ConsolePlugin CR did not appear within 120s."
    exit 1
  fi
  sleep 2
done

echo "==> Enabling plugin on the console..."
CURRENT_PLUGINS=$(oc get consoles.operator.openshift.io cluster -o jsonpath='{.spec.plugins}' 2>/dev/null || echo "[]")
if echo "$CURRENT_PLUGINS" | grep -q "${PLUGIN_NAME}"; then
  echo "Plugin already enabled."
else
  oc patch consoles.operator.openshift.io cluster \
    --type=json \
    --patch='[{"op":"add","path":"/spec/plugins/-","value":"'"${PLUGIN_NAME}"'"}]'
fi

echo "==> Restarting console pods..."
oc delete pods -n openshift-console -l app=console
oc rollout status deployment/console -n openshift-console --timeout=300s

echo ""
echo "==> Plugin deployed and enabled. Run e2e tests with:"
echo ""
echo "  BRIDGE_BASE_ADDRESS=${BRIDGE_BASE_ADDRESS} \\"
echo "  BRIDGE_KUBEADMIN_PASSWORD=<password> \\"
echo "  yarn test:e2e"
echo ""
echo "To clean up afterwards:"
echo "  helm uninstall ${PLUGIN_NAME} -n ${PLUGIN_NAMESPACE}"
echo "  oc delete project ${PLUGIN_NAMESPACE}"
