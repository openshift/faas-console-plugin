package config

import (
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

// SCMRegistry maps platforms to their client factories.
var SCMRegistry = scm.Registry{
	scm.GitHub: github.New,
	// scm.GitLab: gitlab.New,
}
