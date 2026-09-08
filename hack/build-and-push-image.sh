#!/usr/bin/env bash
set -euo pipefail

# Build and push an image to the cluster's internal registry.
#
# Usage: hack/build-and-push-image.sh <image-name> <dockerfile>
# Output (last line): pull spec
#
# Example:
#   PLUGIN_PULL_SPEC=$(hack/build-and-push-image.sh faas-console-plugin Dockerfile | tail -1)
#   FAKEGITHUB_PULL_SPEC=$(hack/build-and-push-image.sh fakegithub Dockerfile.fakegithub | tail -1)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"
source "${SCRIPT_DIR}/lib/registry.sh"

if [[ $# -ne 2 ]]; then
  log::error "Usage: $0 <image-name> <dockerfile>"
  exit 1
fi

registry::build_and_push "$1" "${ROOT_DIR}/$2" "${ROOT_DIR}"
