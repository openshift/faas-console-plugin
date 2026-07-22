package config

import (
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

// SCMRegistry maps platforms to their client factories.
// Override in tests to inject a mock client.
var SCMRegistry = scm.Registry{
	scm.GitHub: github.New,
	// scm.GitLab: gitlab.New,
}
