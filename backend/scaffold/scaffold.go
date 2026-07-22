package scaffold

import (
	"fmt"
	"os"
	"path/filepath"

	"knative.dev/func/pkg/functions"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

type Config struct {
	Name             string
	Runtime          string
	Registry         string
	Namespace        string
	Branch           string
	SCM              scm.Platform
	InternalRegistry bool // when true, CI skips external registry login
}

func Generate(cfg Config) ([]scm.FileEntry, error) {
	tmpDir, err := os.MkdirTemp("", "func-scaffold-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	root := filepath.Join(tmpDir, cfg.Name)

	if _, err := functions.New().Init(functions.Function{
		Name:      cfg.Name,
		Root:      root,
		Runtime:   cfg.Runtime,
		Registry:  cfg.Registry,
		Namespace: cfg.Namespace,
		Template:  "http",
	}); err != nil {
		return nil, fmt.Errorf("init function: %w", err)
	}

	if gen, ok := ciGenerators[cfg.SCM]; ok {
		if err := gen(root, cfg); err != nil {
			return nil, err
		}
	} else if cfg.SCM != "" {
		return nil, fmt.Errorf("unsupported SCM: %q", cfg.SCM)
	}

	return scm.CollectFiles(root)
}
