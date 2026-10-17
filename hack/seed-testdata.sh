#!/usr/bin/env bash
# Seed test data for manual testing. Creates function repos on fakegithub
# and/or knative services on the cluster.
#
# Usage:
#   hack/seed-testdata.sh                                  # repo only (NotDeployed)
#   hack/seed-testdata.sh --cluster                        # repo + cluster ksvc (Running)
#   hack/seed-testdata.sh --cluster-only                   # cluster ksvc only
#   hack/seed-testdata.sh --build in_progress              # repo + Building status
#   hack/seed-testdata.sh --cluster --build in_progress    # Running + Building (rebuild)
#   hack/seed-testdata.sh --cluster --build failure        # Running + BuildFailed
#   hack/seed-testdata.sh --name hello --ns prod --runtime go
#   hack/seed-testdata.sh --cleanup                        # delete repo + cluster ksvc
#   hack/seed-testdata.sh --cleanup --cluster-only         # delete cluster ksvc only
#   hack/seed-testdata.sh --cleanup-all                    # reset all fakegithub repos + delete all func ksvc's

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/log.sh"

# --- Defaults ---

FUNC_NAME="my-func"
NAMESPACE="demo"
RUNTIME="node"
IMAGE="ghcr.io/knative/helloworld-go:latest"
BUILD=""
SEED_REPO=true
SEED_CLUSTER=false
CLEANUP=false
CLEANUP_ALL=false
OWNER="e2e-user"

# --- Main ---

main() {

  while [[ $# -gt 0 ]]; do
    case $1 in
      --name)          FUNC_NAME="$2"; shift 2 ;;
      --ns)            NAMESPACE="$2"; shift 2 ;;
      --runtime)       RUNTIME="$2"; shift 2 ;;
      --image)         IMAGE="$2"; shift 2 ;;
      --build)         BUILD="$2"; shift 2 ;;
      --cluster)       SEED_CLUSTER=true; shift ;;
      --cluster-only)  SEED_CLUSTER=true; SEED_REPO=false; shift ;;
      --cleanup)       CLEANUP=true; shift ;;
      --cleanup-all)   CLEANUP_ALL=true; shift ;;
      -h|--help)
        sed -n '2,16s/^# //p' "$0"
        exit 0
        ;;
      *) log::error "Unknown option: $1"; exit 1 ;;
    esac
  done

  read_dev_env

  if [[ "$CLEANUP_ALL" == true ]]; then
    cleanup_all
  elif [[ "$CLEANUP" == true ]]; then
    [[ "$SEED_REPO" == true ]] && cleanup_repo
    [[ "$SEED_CLUSTER" == true ]] && cleanup_cluster
  else
    [[ "$SEED_REPO" == true ]] && seed_repo
    [[ -n "$BUILD" ]] && seed_build
    [[ "$SEED_CLUSTER" == true ]] && seed_cluster
  fi

  log::step "Done"
  log::info "Refresh the functions list in the console."
}

# --- Read dev environment ---

read_dev_env() {
  local dev_env=".dev-env.json"
  if [[ ! -f "$dev_env" ]]; then
    log::error "$dev_env not found. Start the dev environment first: make dev"
    exit 1
  fi

  FAKE_GH_PORT=$(jq -r '.fakeGithubPort // empty' "$dev_env")
  if [[ "$SEED_REPO" == true && -z "${FAKE_GH_PORT:-}" ]]; then
    log::error "fakeGithubPort not set in $dev_env. Start with: make dev-fake-gh"
    exit 1
  fi

  FAKE_GH_URL="http://localhost:${FAKE_GH_PORT:-}"

  CLUSTER_API_URL=$(oc whoami --show-server 2>/dev/null) || {
    log::error "Not logged in to OpenShift. Run 'oc login' first."
    exit 1
  }
}

# --- Seed functions ---

seed_repo() {
  log::step "Seeding repo ${OWNER}/${FUNC_NAME}"

  local payload
  payload=$(jq -n \
    --arg owner "$OWNER" \
    --arg repo "$FUNC_NAME" \
    --arg ns "$NAMESPACE" \
    --arg runtime "$RUNTIME" \
    --arg cluster "$CLUSTER_API_URL" \
    '{
      owner: $owner,
      repo: $repo,
      branch: "main",
      topics: ["serverless-function"],
      files: [{
        path: "func.yaml",
        mode: "100644",
        content: "name: \($repo)\nruntime: \($runtime)\nnamespace: \($ns)\n"
      }],
      variables: { CLUSTER_API_URL: $cluster }
    }')

  curl -sf -X POST "${FAKE_GH_URL}/_admin/seed" \
    -H 'Content-Type: application/json' \
    -d "$payload" | jq .

  log::info "Repo seeded"
}

seed_build() {
  log::step "Scripting build: ${BUILD}"

  local payload
  case "$BUILD" in
    in_progress)
      payload=$(jq -n --arg owner "$OWNER" --arg repo "$FUNC_NAME" '{
        owner: $owner, repo: $repo, branch: "main",
        status: "in_progress"
      }')
      ;;
    success)
      payload=$(jq -n --arg owner "$OWNER" --arg repo "$FUNC_NAME" '{
        owner: $owner, repo: $repo, branch: "main",
        status: "completed", conclusion: "success"
      }')
      ;;
    failure)
      payload=$(jq -n --arg owner "$OWNER" --arg repo "$FUNC_NAME" '{
        owner: $owner, repo: $repo, branch: "main",
        status: "completed", conclusion: "failure",
        jobs: [{
          id: 1, name: "build", status: "completed", conclusion: "failure",
          steps: [
            { name: "checkout", status: "completed", conclusion: "success", number: 1 },
            { name: "go test", status: "completed", conclusion: "failure", number: 2 }
          ]
        }]
      }')
      ;;
    *)
      log::error "Unknown build status: $BUILD (use: in_progress, success, failure)"
      exit 1
      ;;
  esac

  curl -sf -X POST "${FAKE_GH_URL}/_admin/actions/runs" \
    -H 'Content-Type: application/json' \
    -d "$payload" | jq .

  log::info "Build scripted"
}

seed_cluster() {
  log::step "Seeding cluster ksvc ${FUNC_NAME} in ${NAMESPACE}"

  # Ensure namespace exists
  oc get namespace "$NAMESPACE" &>/dev/null || {
    log::info "Creating namespace ${NAMESPACE}"
    oc create namespace "$NAMESPACE"
  }

  # Create or update the knative service with func CLI labels
  oc apply -f - <<EOF
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${FUNC_NAME}
  namespace: ${NAMESPACE}
  labels:
    boson.dev/function: "true"
    function.knative.dev/name: ${FUNC_NAME}
    function.knative.dev/runtime: ${RUNTIME}
spec:
  template:
    metadata:
      labels:
        function.knative.dev/name: ${FUNC_NAME}
    spec:
      containers:
        - image: ${IMAGE}
EOF

  log::info "ksvc ready"
}

# --- Cleanup functions ---

cleanup_repo() {
  log::step "Deleting repo ${OWNER}/${FUNC_NAME} from fakegithub"

  curl -sf -X DELETE "${FAKE_GH_URL}/repos/${OWNER}/${FUNC_NAME}" \
    -H "Authorization: token placeholder-pat" | jq . 2>/dev/null || true

  log::info "Repo deleted"
}

cleanup_cluster() {
  log::step "Deleting ksvc ${FUNC_NAME} from ${NAMESPACE}"

  oc delete ksvc "$FUNC_NAME" -n "$NAMESPACE" --ignore-not-found

  log::info "ksvc deleted"
}

cleanup_all() {
  log::step "Resetting all fakegithub data"
  curl -sf -X POST "${FAKE_GH_URL}/_admin/reset" | jq .
  log::info "Fakegithub reset"

  log::step "Deleting all func ksvc's from ${NAMESPACE}"
  oc delete ksvc -n "$NAMESPACE" -l boson.dev/function=true --ignore-not-found
  log::info "All func ksvc's deleted"
}

main "$@"
