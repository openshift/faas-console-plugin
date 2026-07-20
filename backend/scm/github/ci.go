package github

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	cigithub "knative.dev/func/pkg/ci/github"
	"knative.dev/func/pkg/functions"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

// OCPInternalRegistry is the URL prefix for the OpenShift in-cluster image registry.
// CI workflows targeting this registry skip external login since the runner
// authenticates via the kubeconfig's service account token.
const OCPInternalRegistry = "image-registry.openshift-image-registry.svc:5000/"

type CIConfig struct {
	Runtime  string
	Branch   string
	Registry string
}

func GenerateCIFiles(cfg CIConfig) ([]scm.FileEntry, error) {
	tmpDir, err := os.MkdirTemp("", "ci-workflow-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	isInternal := strings.HasPrefix(cfg.Registry, OCPInternalRegistry)
	gen := cigithub.NewWorkflowGenerator(
		cigithub.WithWorkflowConfig(cigithub.WorkflowConfig{
			Branch:        cfg.Branch,
			RegistryLogin: !isInternal,
			TestStep:      cigithub.DefaultTestStep,
		}),
		cigithub.WithMessageWriter(io.Discard),
	)
	if err := gen.Generate(context.Background(), functions.Function{
		Root:    tmpDir,
		Runtime: cfg.Runtime,
	}); err != nil {
		return nil, fmt.Errorf("generate CI workflow: %w", err)
	}

	return scm.CollectFiles(tmpDir)
}
