#!/usr/bin/env bash
set -euo pipefail

# Build and deploy the fake GitHub server to an OpenShift cluster using ko.
# The image is built from Go source, pushed to the cluster's internal registry,
# and deployed as a Deployment + Service.
#
# Prerequisites: oc login, ko (go install github.com/ko-build/ko@latest)
# Usage: hack/deploy-fake-gh.sh
# Output (last line): in-cluster service URL for the fake GitHub server

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

NAMESPACE="${NAMESPACE:-console-functions-plugin}"
REGISTRY_PORT=5001
INTERNAL_REGISTRY="image-registry.openshift-image-registry.svc:5000"

# --- Prerequisites ---

if ! command -v oc &>/dev/null; then
  log::error "oc CLI not found. Install from https://console.redhat.com/openshift/downloads"
  exit 1
fi

if ! oc whoami &>/dev/null; then
  log::error "Not logged in to OpenShift. Run 'oc login' first."
  exit 1
fi

if ! command -v ko &>/dev/null; then
  log::error "ko not found. Install with: go install github.com/google/ko@latest"
  exit 1
fi

# --- Detect cluster architectures ---

ARCHES=$(oc get nodes -o jsonpath='{range .items[*]}{.status.nodeInfo.architecture}{"\n"}{end}' 2>/dev/null | sort -u || true)
if [[ -z "$ARCHES" ]]; then
  KO_PLATFORM="linux/amd64"
  log::warn "Could not detect cluster node architectures, falling back to ${KO_PLATFORM}"
else
  KO_PLATFORM=$(echo "$ARCHES" | sed 's/^/linux\//' | paste -sd,)
  log::info "Cluster architectures detected: ${KO_PLATFORM}"
fi

# --- Ensure namespace exists ---

oc get namespace "$NAMESPACE" &>/dev/null 2>&1 || oc create namespace "$NAMESPACE"

# --- Port-forward the internal registry ---

log::step "Pushing fake GitHub image to internal registry"

log::info "Port-forwarding registry to localhost:${REGISTRY_PORT}..."
oc port-forward svc/image-registry \
  "${REGISTRY_PORT}:5000" \
  -n openshift-image-registry &
PF_PID=$!
trap "kill $PF_PID 2>/dev/null || true" EXIT INT TERM
sleep 5

# --- Build and push with ko ---

log::info "Logging in to registry..."
ko login "localhost:${REGISTRY_PORT}" \
  -u unused -p "$(oc create token builder -n "$NAMESPACE")"

export KO_DOCKER_REPO="localhost:${REGISTRY_PORT}/${NAMESPACE}/fakegithub"
export KO_DEFAULTBASEIMAGE="registry.access.redhat.com/ubi9/ubi-micro:latest"

log::info "Building and pushing with ko..."
export GOFLAGS="${GOFLAGS:-} -buildvcs=false"
KO_IMAGE=$(cd "${SCRIPT_DIR}/../backend" && ko build --bare --insecure-registry --platform="${KO_PLATFORM}" ./cmd/fakegithub)

log::info "ko produced: ${KO_IMAGE}"

# Extract the digest from the ko output (localhost:5001/ns/fakegithub@sha256:...)
DIGEST="${KO_IMAGE#*@}"
DEPLOY_IMAGE="${INTERNAL_REGISTRY}/${NAMESPACE}/fakegithub@${DIGEST}"

# Kill port-forward, no longer needed
kill $PF_PID 2>/dev/null || true
trap - EXIT

# --- Deploy ---

log::step "Deploying fake GitHub server"

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
      containers:
        - name: fakegithub
          image: ${DEPLOY_IMAGE}
          args:
            - "--port=8090"
            - "--login=e2e-user"
            - "--pat=placeholder-pat"
          ports:
            - containerPort: 8090
              protocol: TCP
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
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
