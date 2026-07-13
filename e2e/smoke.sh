#!/usr/bin/env bash
# Smoke test suite: a curated subset of use-case tests that run on every push.
# Add or remove entries as the test suite grows.

set -euo pipefail

SMOKE_TESTS=(
  e2e/use-cases/listing/function-list-basic.test.ts
  e2e/use-cases/creation/function-create-basic.test.ts
  e2e/use-cases/editing/function-edit-basic.test.ts
  e2e/use-cases/deletion/function-delete-basic.test.ts
)

npx playwright test "${SMOKE_TESTS[@]}" "$@"
