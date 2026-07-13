#!/usr/bin/env bash
# Smoke test suite: a curated subset of use-case tests that run on every push.
# Add or remove entries as the test suite grows.

set -euo pipefail

SMOKE_TESTS=(
  e2e/listing/function-list-basic.test.ts
  e2e/creation/function-create-basic.test.ts
  e2e/editing/function-edit-basic.test.ts
  e2e/deletion/function-delete-basic.test.ts
)

npx playwright test "${SMOKE_TESTS[@]}" "$@"
