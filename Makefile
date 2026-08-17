PROJECT_DIR := $(shell dirname $(abspath $(lastword $(MAKEFILE_LIST))))
BACKEND_DIR := $(PROJECT_DIR)/backend

# Backend build
TEST_TIMEOUT ?= 120s
CGO_ENABLED ?= 0
LDFLAGS ?= -s -w
BACKEND_BIN ?= $(PROJECT_DIR)/bin/plugin-backend
FAKEGITHUB_BIN ?= $(PROJECT_DIR)/bin/fakegithub
GOLANGCI_LINT_VERSION ?= v2.12.2
GOLANGCI_LINT = go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)

# Image
CONTAINER_CMD ?= podman
IMAGE_TAG ?= localhost/faas-console-plugin:latest
PLATFORM ?= linux/amd64

# Cluster
PLUGIN_NAME ?= console-functions-plugin
NAMESPACE ?= console-functions-plugin
IMAGE ?= quay.io/redhat-user-workloads/ocp-serverless-tenant/faas-console-plugin:latest
KUBE_API_SERVER ?= https://api.example.com:6443

.PHONY: help install-frontend build-frontend lint-frontend unit-frontend type-check test-e2e verify \
        install-backend build-backend build-fakegithub unit-backend lint-backend fmt-backend \
        image manifests deploy undeploy deploy-dev setup-serverless \
        dev dev-% \
        build lint unit e2e

.DEFAULT_GOAL := help

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } \
	' $(MAKEFILE_LIST)

##@ Development

dev: ## Start dev environment (also: dev-stop, dev-randomize-ports, dev-fake-gh)
	hack/dev.sh

dev-%:
	hack/dev.sh --$*

##@ Frontend

install-frontend: ## Install frontend dependencies (yarn install --immutable)
	yarn install --immutable

build-frontend: install-frontend ## Build production bundle
	yarn build

lint-frontend: install-frontend ## Run eslint and stylelint
	yarn lint

unit-frontend: install-frontend ## Run Vitest unit tests
	yarn test

type-check: ## Run TypeScript compiler check
	yarn type-check

test-e2e: install-frontend ## Run Playwright e2e tests (ARGS="--headed")
	yarn test:e2e $(ARGS)

verify: install-frontend ## Verify i18n freshness and yarn deduplication
	yarn i18n
	@GIT_STATUS="$$(git status --short --untracked-files -- locales)"; \
	if [ -n "$$GIT_STATUS" ]; then \
		echo "i18n files are not up to date. Run 'yarn i18n' then commit changes."; \
		git --no-pager diff; \
		exit 1; \
	fi
	@if ! yarn dedupe --strategy highest --check; then \
		echo "Duplicate version resolutions found. Run 'yarn dedupe' and commit the updated yarn.lock."; \
		exit 1; \
	fi

##@ Backend

install-backend: ## Download Go module dependencies
	go -C $(BACKEND_DIR) mod download

build-backend: ## Compile Go binary to bin/
	@mkdir -p $(dir $(BACKEND_BIN))
	CGO_ENABLED=$(CGO_ENABLED) \
	$(if $(GOOS),GOOS=$(GOOS)) \
	$(if $(GOARCH),GOARCH=$(GOARCH)) \
	go -C $(BACKEND_DIR) build -ldflags="$(LDFLAGS)" -o $(BACKEND_BIN) .

build-fakegithub: ## Build fake GitHub server binary
	@mkdir -p $(dir $(FAKEGITHUB_BIN))
	CGO_ENABLED=$(CGO_ENABLED) go -C $(BACKEND_DIR) build -buildvcs=false -o $(FAKEGITHUB_BIN) ./cmd/fakegithub

unit-backend: ## Run Go unit tests
	go -C $(BACKEND_DIR) test ./... -timeout $(TEST_TIMEOUT)

lint-backend: ## Run golangci-lint
	cd $(BACKEND_DIR) && $(GOLANGCI_LINT) run ./...

fmt-backend: ## Auto-fix lint issues (golangci-lint --fix)
	cd $(BACKEND_DIR) && $(GOLANGCI_LINT) run --fix ./...

##@ Image

image: ## Build container image
	$(CONTAINER_CMD) build --platform $(PLATFORM) -t $(IMAGE_TAG) .

##@ Cluster

manifests: ## Render Helm chart to backend/static/plugin.yaml
	helm template $(PLUGIN_NAME) charts/openshift-console-plugin \
		-n $(NAMESPACE) \
		--set "plugin.image=$(IMAGE)" \
		--set "plugin.apiServerURL=$(KUBE_API_SERVER)" \
		> $(BACKEND_DIR)/static/plugin.yaml

deploy: ## Deploy plugin to cluster (defaults to quay.io latest image)
	hack/deploy.sh

undeploy: ## Remove plugin from cluster
	helm uninstall $(PLUGIN_NAME) -n $(NAMESPACE)

deploy-dev: ## Build and deploy to cluster (dev)
	hack/deploy-dev.sh

setup-serverless: ## Install Serverless operator and Knative Serving
	hack/setup-serverless.sh

##@ Aggregate

lint: lint-frontend lint-backend ## Lint frontend and backend

unit: unit-frontend unit-backend ## Run all unit tests

e2e: ## Run Prow e2e flow (CI only)
	hack/test-prow-e2e.sh
