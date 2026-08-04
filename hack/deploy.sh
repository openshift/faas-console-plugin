#!/usr/bin/env bash
set -euo pipefail

# Deploy the plugin to an OpenShift cluster using the Helm chart.
# Installs (or upgrades) the chart, waits for rollout, enables the plugin
# on the console, and restarts the console pods.
#
# For the full dev workflow (build image + push to internal registry + deploy),
# see deploy-dev.sh instead.
#
# Usage: make deploy [IMAGE=...] [NAMESPACE=...]
# Prerequisites: oc login, Helm

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

PLUGIN_NAME="${PLUGIN_NAME:-console-functions-plugin}"
NAMESPACE="${NAMESPACE:-console-functions-plugin}"
IMAGE="${IMAGE:-quay.io/redhat-user-workloads/ocp-serverless-tenant/faas-console-plugin:latest}"

log::step "Deploying plugin"

log::info "Installing Helm chart..."
helm upgrade -i "$PLUGIN_NAME" charts/openshift-console-plugin \
  -n "$NAMESPACE" --create-namespace \
  --set "plugin.image=$IMAGE"

log::info "Waiting for rollout..."
oc rollout status deployment/"$PLUGIN_NAME" -n "$NAMESPACE" --timeout=300s

log::info "Waiting for ConsolePlugin CR..."
for i in $(seq 1 60); do
  if oc get consoleplugins "$PLUGIN_NAME" &>/dev/null; then
    log::info "ConsolePlugin CR found."
    break
  fi
  if [ "$i" -eq 60 ]; then
    log::error "ConsolePlugin CR did not appear within 120s."
    oc get all -n "$NAMESPACE"
    exit 1
  fi
  sleep 2
done

ENABLED=$(oc get consoles.operator.openshift.io cluster -o jsonpath='{.spec.plugins}' 2>/dev/null || true)
if echo "$ENABLED" | grep -q "$PLUGIN_NAME"; then
  log::info "Plugin $PLUGIN_NAME already enabled on console."
else
  log::info "Patching console operator to enable plugin..."
  oc patch consoles.operator.openshift.io cluster \
    --type=json \
    --patch='[{"op":"add","path":"/spec/plugins/-","value":"'"${PLUGIN_NAME}"'"}]'
fi

log::info "Restarting console pods to pick up plugin changes..."
oc rollout restart deployment/console -n openshift-console
oc rollout status deployment/console -n openshift-console --timeout=300s

CONSOLE_URL=$(oc get consoles.config.openshift.io cluster -o jsonpath='{.status.consoleURL}')

log::step "Plugin deployed successfully"
log::link "API" "$CONSOLE_URL/api/proxy/plugin/$PLUGIN_NAME/backend/"
log::link "Console" "$CONSOLE_URL/faas"
log::hint "For full Knative integration: make setup-serverless"
