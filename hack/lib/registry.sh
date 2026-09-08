#!/usr/bin/env bash
# Shared helpers for pushing images to the cluster's internal OpenShift registry.

NAMESPACE="${NAMESPACE:-console-functions-plugin}"
REGISTRY_PORT="${REGISTRY_PORT:-5001}"
INTERNAL_REGISTRY="image-registry.openshift-image-registry.svc:5000"
CONTAINER_CMD="${CONTAINER_CMD:-podman}"

registry::preflight() {
  if ! command -v oc &>/dev/null; then
    log::error "oc CLI not found. Install from https://console.redhat.com/openshift/downloads"
    exit 1
  fi
  if ! oc whoami &>/dev/null; then
    log::error "Not logged in to OpenShift. Run 'oc login' first."
    exit 1
  fi
}

registry::detect_platform() {
  local arches
  arches=$(oc get nodes -o jsonpath='{range .items[*]}{.status.nodeInfo.architecture}{"\n"}{end}' 2>/dev/null | sort -u || true)
  if [[ -z "$arches" ]]; then
    log::warn "Could not detect cluster node architectures, falling back to linux/amd64"
    echo "linux/amd64"
  else
    echo "$arches" | sed 's/^/linux\//' | tr '\n' ',' | sed 's/,$//'
  fi
}

registry::push_target() {
  if [[ "$(uname)" == "Darwin" ]]; then
    local ip
    ip=$(ifconfig | awk '/inet / && !/127.0.0.1/ {print $2; exit}')
    if [[ -z "$ip" ]]; then
      log::error "Could not determine host IP address."
      exit 1
    fi
    echo "${ip}:${REGISTRY_PORT}"
  else
    echo "localhost:${REGISTRY_PORT}"
  fi
}

# registry::start_port_forward <push-target>
# Starts port-forwarding the internal registry. Sets REGISTRY_PF_PID.
# Caller is responsible for cleanup: kill "$REGISTRY_PF_PID" and trap - EXIT.
registry::start_port_forward() {
  local push_target="$1"
  log::info "Port-forwarding registry to ${push_target}..."
  oc port-forward svc/image-registry \
    --address='::' --address='0.0.0.0' \
    "${REGISTRY_PORT}:5000" \
    -n openshift-image-registry &
  REGISTRY_PF_PID=$!
  sleep 5
}

# registry::build_and_push <image-name> <dockerfile> <build-context>
# Builds and pushes to the internal registry. Outputs pull spec as the last line.
registry::build_and_push() {
  local image_name="$1"
  local dockerfile="$2"
  local build_context="${3:-.}"

  registry::preflight

  oc get namespace "$NAMESPACE" &>/dev/null 2>&1 || oc create namespace "$NAMESPACE"

  local build_platform
  build_platform=$(registry::detect_platform)
  log::info "Cluster architectures detected: ${build_platform}"

  local push_target
  push_target=$(registry::push_target)

  local local_image="${push_target}/${NAMESPACE}/${image_name}:latest"

  log::step "Pushing ${image_name} to internal registry"

  registry::start_port_forward "$push_target"
  trap "kill $REGISTRY_PF_PID 2>/dev/null || true" EXIT INT TERM

  log::info "Building image..."
  "$CONTAINER_CMD" build \
    --platform="${build_platform}" \
    --file="${dockerfile}" \
    --tag="${local_image}" \
    "${build_context}"

  log::info "Logging in to internal registry..."
  "$CONTAINER_CMD" login "${push_target}" \
    --username unused \
    --password "$(oc create token builder -n "$NAMESPACE")" \
    --tls-verify=false

  local digest_file
  digest_file=$(mktemp /tmp/registry-digest.XXXXXX)

  log::info "Pushing image..."
  "$CONTAINER_CMD" push --tls-verify=false --digestfile "$digest_file" "${local_image}"

  kill "$REGISTRY_PF_PID" 2>/dev/null || true
  trap - EXIT

  local digest
  digest=$(cat "$digest_file")
  rm -f "$digest_file"

  local pull_spec="${INTERNAL_REGISTRY}/${NAMESPACE}/${image_name}:latest@${digest}"
  log::step "Done"
  log::info "PULL_SPEC=${pull_spec}"
  echo "${pull_spec}"
}
