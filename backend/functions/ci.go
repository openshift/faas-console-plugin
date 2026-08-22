package functions

import (
	"context"
	"fmt"
	"io"

	cigithub "knative.dev/func/pkg/ci/github"
	fn "knative.dev/func/pkg/functions"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var ciGenerators = map[scm.Platform]func(string, ScaffoldConfig) error{
	scm.GitHub: generateGithubCIFiles,
}

func generateGithubCIFiles(dir string, cfg ScaffoldConfig) error {
	gen := cigithub.NewWorkflowGenerator(
		cigithub.WithWorkflowConfig(cigithub.WorkflowConfig{
			Branch:        cfg.Branch,
			RegistryLogin: !cfg.InternalRegistry,
			TestStep:      cigithub.DefaultTestStep,
		}),
		cigithub.WithMessageWriter(io.Discard),
	)
	if err := gen.Generate(context.Background(), fn.Function{
		Root:    dir,
		Runtime: cfg.Runtime,
	}); err != nil {
		return fmt.Errorf("generate CI workflow: %w", err)
	}
	return nil
}
