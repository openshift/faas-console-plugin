PROJECT_DIR := $(shell dirname $(abspath $(lastword $(MAKEFILE_LIST))))
BACKEND_DIR := $(PROJECT_DIR)/backend
TEST_TIMEOUT ?= 120s
GOLANGCI_LINT_VERSION ?= v2.12.2
GOLANGCI_LINT = go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)

.PHONY: help install lint build test build-backend test-backend lint-backend fmt-backend ci
.DEFAULT_GOAL := help

help: ## Display this help message
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ── Frontend ──────────────────────────────────────────────────────────────────

install: ## Install frontend dependencies
	yarn install

lint: install ## Lint frontend source
	yarn lint

build: install ## Build frontend for production
	NODE_ENV=production yarn webpack

test: install ## Run frontend unit tests
	yarn test

# ── Backend ───────────────────────────────────────────────────────────────────

build-backend: ## Compile the Go backend
	cd $(BACKEND_DIR) && go build ./...

test-backend: ## Run backend unit and integration tests
	cd $(BACKEND_DIR) && go test ./... -timeout $(TEST_TIMEOUT)

lint-backend: ## Lint backend source with golangci-lint
	cd $(BACKEND_DIR) && $(GOLANGCI_LINT) run ./...

fmt-backend: ## Format backend source (gofmt + goimports via golangci-lint --fix)
	cd $(BACKEND_DIR) && $(GOLANGCI_LINT) run --fix ./...

# ── CI ────────────────────────────────────────────────────────────────────────

ci: lint build test build-backend test-backend lint-backend ## Run all checks
