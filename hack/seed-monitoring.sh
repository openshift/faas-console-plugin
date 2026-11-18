#!/usr/bin/env bash
# Seed monitoring test data: several namespaces, each with multiple Knative
# functions, so the monitoring drawer and all-namespaces overview chart have
# real data to display.
#
# Usage:
#   hack/seed-monitoring.sh               # create namespaces + functions
#   hack/seed-monitoring.sh --traffic     # create + hit each URL to generate metrics
#   hack/seed-monitoring.sh --cleanup     # delete everything created by this script
#
# Requires: oc login

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

# A lightweight public image that serves HTTP on port 8080.
IMAGE="ghcr.io/knative/helloworld-go:latest"
LABEL_SELECTOR="monitoring-seed=true"

TRAFFIC=false
CLEANUP=false

# ---------------------------------------------------------------------------
# Seed data: three namespaces, two or three functions each.
# Each function name is unique so the overview chart shows distinct lines.
# ---------------------------------------------------------------------------
# Namespace:function-list pairs (bash 3.2 compatible - no associative arrays)
# Format: "namespace:fn1 fn2 fn3"
SEED_ENTRIES=(
  "seed-alpha:http-api event-processor"
  "seed-beta:data-transformer notification-sender report-builder"
  "seed-gamma:auth-service cache-warmer"
)

# ---------------------------------------------------------------------------

main() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --traffic)  TRAFFIC=true; shift ;;
      --cleanup)  CLEANUP=true; shift ;;
      -h|--help)
        sed -n '2,10s/^# //p' "$0"
        exit 0
        ;;
      *) log::error "Unknown option: $1"; exit 1 ;;
    esac
  done

  oc whoami &>/dev/null || {
    log::error "Not logged in to OpenShift. Run 'oc login' first."
    exit 1
  }

  if [[ "$CLEANUP" == true ]]; then
    cleanup
  else
    seed
    if [[ "$TRAFFIC" == true ]]; then
      generate_traffic
    fi
  fi

  log::step "Done"
}

# ---------------------------------------------------------------------------

seed() {
  log::step "Creating namespaces and Knative services"

  for entry in "${SEED_ENTRIES[@]}"; do
    local ns="${entry%%:*}"
    local fns="${entry#*:}"
    ensure_namespace "$ns"
    for fn in $fns; do
      create_ksvc "$ns" "$fn"
    done
  done

  log::info "Waiting for services to become ready..."
  for entry in "${SEED_ENTRIES[@]}"; do
    local ns="${entry%%:*}"
    local fns="${entry#*:}"
    for fn in $fns; do
      wait_ready "$ns" "$fn"
    done
  done

  log::info ""
  log::info "Services created:"
  for entry in "${SEED_ENTRIES[@]}"; do
    local ns="${entry%%:*}"
    local fns="${entry#*:}"
    log::info "  namespace: $ns"
    for fn in $fns; do
      local url
      url=$(oc get ksvc "$fn" -n "$ns" -o jsonpath='{.status.url}' 2>/dev/null || echo "(pending)")
      log::info "    - $fn  $url"
    done
  done
}

ensure_namespace() {
  local ns=$1
  if oc get namespace "$ns" &>/dev/null; then
    log::info "Namespace $ns already exists"
  else
    log::info "Creating namespace $ns"
    oc create namespace "$ns"
    # Label so cleanup can find everything this script created
    oc label namespace "$ns" "$LABEL_SELECTOR"
  fi
}

create_ksvc() {
  local ns=$1
  local name=$2
  log::info "  ksvc $name in $ns"
  oc apply -f - <<EOF
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    boson.dev/function: "true"
    function.knative.dev/name: ${name}
    function.knative.dev/runtime: go
    monitoring-seed: "true"
spec:
  template:
    metadata:
      labels:
        function.knative.dev/name: ${name}
        monitoring-seed: "true"
    spec:
      containers:
        - image: ${IMAGE}
          env:
            - name: TARGET
              value: "${name}"
EOF
}

wait_ready() {
  local ns=$1
  local name=$2
  local attempts=0
  local max=30
  while [[ $attempts -lt $max ]]; do
    local ready
    ready=$(oc get ksvc "$name" -n "$ns" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    if [[ "$ready" == "True" ]]; then
      log::info "  ready: $name.$ns"
      return
    fi
    sleep 3
    ((attempts++))
  done
  log::warn "  $name.$ns not ready after ${max} attempts (continuing)"
}

# ---------------------------------------------------------------------------

generate_traffic() {
  log::step "Generating HTTP traffic to populate request-rate metrics"
  log::info "Sending 20 requests to each function URL..."

  for entry in "${SEED_ENTRIES[@]}"; do
    local ns="${entry%%:*}"
    local fns="${entry#*:}"
    for fn in $fns; do
      local url
      url=$(oc get ksvc "$fn" -n "$ns" -o jsonpath='{.status.url}' 2>/dev/null || echo "")
      if [[ -z "$url" ]]; then
        log::warn "  no URL for $fn.$ns - skipping"
        continue
      fi
      log::info "  $fn.$ns -> $url"
      for i in $(seq 1 20); do
        curl -sf --max-time 5 "$url" -o /dev/null 2>/dev/null || true
      done
      log::info "  done ($fn)"
    done
  done

  log::info ""
  log::info "Traffic sent. Metrics appear in Thanos after ~30-60 s (scrape interval)."
  log::info "Open the monitoring drawer and hit refresh, or wait for the polling interval."
}

# ---------------------------------------------------------------------------

cleanup() {
  log::step "Deleting seed namespaces and services"

  for entry in "${SEED_ENTRIES[@]}"; do
    local ns="${entry%%:*}"
    if oc get namespace "$ns" &>/dev/null; then
      log::info "Deleting namespace $ns (and all resources inside)"
      oc delete namespace "$ns" --ignore-not-found
    else
      log::info "Namespace $ns not found - skipping"
    fi
  done

  log::info "Cleanup complete"
}

main "$@"
