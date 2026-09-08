#!/usr/bin/env bash
set -euo pipefail

# Deploy the fake GitHub server to an OpenShift cluster using a pre-built image.
# FAKEGITHUB_PULL_SPEC must be set (injected by ci-operator in CI, or set
# manually for local runs after building the image separately).
#
# Prerequisites: oc login
# Usage: FAKEGITHUB_PULL_SPEC=<image> hack/deploy-fake-gh.sh
# Output (last line): in-cluster service URL for the fake GitHub server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

NAMESPACE="${NAMESPACE:-console-functions-plugin}"

if [[ -z "${FAKEGITHUB_PULL_SPEC:-}" ]]; then
  log::error "FAKEGITHUB_PULL_SPEC is not set. It should be injected by ci-operator as a dependency."
  exit 1
fi

if ! command -v oc &>/dev/null; then
  log::error "oc CLI not found. Install from https://console.redhat.com/openshift/downloads"
  exit 1
fi

if ! oc whoami &>/dev/null; then
  log::error "Not logged in to OpenShift. Run 'oc login' first."
  exit 1
fi

oc get namespace "$NAMESPACE" &>/dev/null 2>&1 || oc create namespace "$NAMESPACE"

log::step "Deploying fake GitHub server"

# Why Podman runs inside the pod at all:
#   func build --strategy=s2i communicates through a Docker-compatible HTTP API socket.
#   OpenShift nodes use CRI-O, which speaks the Kubernetes CRI (gRPC) protocol and does
#   not expose a Docker socket. So the pod runs its own Podman daemon to provide one.
#   This is "Podman-inside-CRI-O" -- the outer runtime is CRI-O, the inner is Podman.
#
# Why privileged: true is required:
#   Three concrete needs, all requiring CAP_SYS_ADMIN:
#   1. The entrypoint mounts a tmpfs at /var/lib/containers/storage so Podman's
#      overlay driver has a non-overlay backing filesystem (kernel overlayfs cannot
#      stack on top of CRI-O's own overlay without idmapped mount support).
#   2. Podman's overlay storage driver creates mount namespaces when applying image
#      layers.
#   3. Running S2I builder containers requires creating mount, network, and PID
#      namespaces.
#   Rootless Podman could avoid privileged: true but would need nested user-namespace
#   mapping, fuse-overlayfs, and a custom SCC -- more complexity with marginal
#   security benefit on a dedicated ephemeral CI cluster.
log::info "Configuring service account and SCC..."
oc apply -n "$NAMESPACE" -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fakegithub
  namespace: ${NAMESPACE}
EOF
oc adm policy add-scc-to-user privileged -z fakegithub -n "$NAMESPACE"

# Allow privileged pods in this namespace.
oc label namespace "$NAMESPACE" \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/warn=privileged \
  pod-security.kubernetes.io/audit=privileged \
  --overwrite

log::info "Applying Deployment and Service..."
oc apply -n "$NAMESPACE" -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fakegithub
  labels:
    app: fakegithub
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fakegithub
  template:
    metadata:
      labels:
        app: fakegithub
    spec:
      serviceAccountName: fakegithub
      containers:
        - name: fakegithub
          image: ${FAKEGITHUB_PULL_SPEC}
          args:
            - "--port=8090"
            - "--login=e2e-user"
            - "--pat=placeholder-pat"
          ports:
            - containerPort: 8090
              protocol: TCP
          securityContext:
            privileged: true
---
apiVersion: v1
kind: Service
metadata:
  name: fakegithub
  labels:
    app: fakegithub
spec:
  selector:
    app: fakegithub
  ports:
    - port: 8090
      targetPort: 8090
      protocol: TCP
EOF

log::info "Waiting for rollout..."
oc rollout status deployment/fakegithub -n "$NAMESPACE" --timeout=120s

FAKE_GH_URL="http://fakegithub.${NAMESPACE}.svc:8090"
log::step "Fake GitHub server deployed"
log::link "In-cluster URL" "${FAKE_GH_URL}"

# Output the URL as the last line (for scripted consumption)
echo "${FAKE_GH_URL}"
