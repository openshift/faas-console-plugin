#!/usr/bin/env bash
set -euo pipefail

# Full dev deployment workflow: build the plugin image, push it to the
# cluster's internal registry, and deploy via Helm.
#
# For deploying a pre-built image (e.g. from CI), use make deploy (deploy.sh) instead.
#
# Prerequisites: oc login
# Usage: make deploy-dev [NAMESPACE=...]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

NAMESPACE="${NAMESPACE:-console-functions-plugin}"

log::step "Setting up Serverless Operator (idempotent)"
make setup-serverless

log::step "Pushing plugin image to internal registry"
DEPLOY_IMAGE=$(make plugin-registry NAMESPACE="$NAMESPACE" | tail -1)

log::step "Deploying plugin via Helm"
make deploy IMAGE="$DEPLOY_IMAGE" NAMESPACE="$NAMESPACE"
