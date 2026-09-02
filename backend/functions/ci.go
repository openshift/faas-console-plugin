package functions

import (
	"context"
	"fmt"
	"io"

	cigithub "knative.dev/func/pkg/ci/github"
	fn "knative.dev/func/pkg/functions"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

// WorkflowFilename is the file name (under .github/workflows/) of the CI
// workflow generated for a function. It is the identifier used to scope build
// status queries to the func build workflow rather than to arbitrary other
// workflows in the repository. It aliases func's default so it stays in sync
// with what generateGithubCIFiles actually writes.
const WorkflowFilename = cigithub.DefaultGitHubWorkflowFilename

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
