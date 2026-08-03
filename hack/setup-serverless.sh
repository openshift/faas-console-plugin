#!/usr/bin/env bash
set -euo pipefail

# Idempotent one-time cluster setup for Serverless operator and Knative Serving.
# Prerequisites: oc login with cluster-admin
# Usage: make setup-serverless

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

SERVERLESS_NS="openshift-serverless"
SERVING_NS="knative-serving"
OPERATOR_NAME="serverless-operator"
CHANNEL="stable"
SOURCE="redhat-operators"
SOURCE_NS="openshift-marketplace"
TIMEOUT=300

# --- Prerequisites ---

if ! command -v oc &>/dev/null; then
  log::error "oc CLI not found. Install from https://console.redhat.com/openshift/downloads"
  exit 1
fi

if ! oc whoami &>/dev/null; then
  log::error "Not logged in to OpenShift. Run 'oc login' first."
  exit 1
fi

# --- Serverless Operator ---

log::step "Serverless Operator setup"

if oc get namespace "$SERVERLESS_NS" &>/dev/null; then
  log::info "Namespace $SERVERLESS_NS already exists."
else
  log::info "Creating namespace $SERVERLESS_NS..."
  oc create namespace "$SERVERLESS_NS"
fi

log::info "Applying OperatorGroup..."
cat <<EOF | oc apply -f -
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: $OPERATOR_NAME
  namespace: $SERVERLESS_NS
spec: {}
EOF

log::info "Applying Subscription..."
cat <<EOF | oc apply -f -
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: $OPERATOR_NAME
  namespace: $SERVERLESS_NS
spec:
  channel: $CHANNEL
  name: $OPERATOR_NAME
  source: $SOURCE
  sourceNamespace: $SOURCE_NS
EOF

log::info "Waiting for CSV to reach Succeeded (up to ${TIMEOUT}s)..."
elapsed=0
while true; do
  csv=$(oc get csv -n "$SERVERLESS_NS" -o jsonpath='{.items[?(@.spec.displayName=="Red Hat OpenShift Serverless")].metadata.name}' 2>/dev/null || true)
  if [ -n "$csv" ]; then
    phase=$(oc get csv "$csv" -n "$SERVERLESS_NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    if [ "$phase" = "Succeeded" ]; then
      log::info "CSV $csv is Succeeded."
      break
    fi
    log::waiting "CSV $csv phase: $phase (${elapsed}s)..."
  else
    log::waiting "Waiting for CSV to appear (${elapsed}s)..."
  fi
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    log::error "CSV did not reach Succeeded within ${TIMEOUT}s."
    exit 1
  fi
  sleep 10
  elapsed=$((elapsed + 10))
done

# --- Knative Serving ---

log::step "Knative Serving setup"

if oc get namespace "$SERVING_NS" &>/dev/null; then
  log::info "Namespace $SERVING_NS already exists."
else
  log::info "Creating namespace $SERVING_NS..."
  oc create namespace "$SERVING_NS"
fi

log::info "Applying KnativeServing CR..."
cat <<EOF | oc apply -f -
apiVersion: operator.knative.dev/v1beta1
kind: KnativeServing
metadata:
  name: knative-serving
  namespace: $SERVING_NS
spec: {}
EOF

log::info "Waiting for KnativeServing to be ready (up to ${TIMEOUT}s)..."
elapsed=0
while true; do
  ready=$(oc get knativeserving knative-serving -n "$SERVING_NS" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
  if [ "$ready" = "True" ]; then
    log::info "KnativeServing is Ready."
    break
  fi
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    log::error "KnativeServing did not become Ready within ${TIMEOUT}s."
    exit 1
  fi
  log::waiting "Waiting for KnativeServing ready (${elapsed}s)..."
  sleep 10
  elapsed=$((elapsed + 10))
done

log::step "Cluster setup complete"
