package scaffold

import (
	"fmt"
	"os"
	"path/filepath"

	"knative.dev/func/pkg/functions"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

type EnvVar struct {
	Name         string `json:"name"`
	Source       string `json:"source"`
	Value        string `json:"value"`
	ResourceName string `json:"resourceName"`
	ResourceKey  string `json:"resourceKey"`
}

type Config struct {
	Name             string
	Runtime          string
	Registry         string
	Namespace        string
	Branch           string
	SCM              scm.Platform
	InternalRegistry bool // when true, CI skips external registry login
	EnvVars          []EnvVar
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

	if len(cfg.EnvVars) > 0 {
		if err := injectEnvVars(root, cfg.EnvVars); err != nil {
			return nil, fmt.Errorf("inject env vars: %w", err)
		}
	}

	return collectFiles(root)
}
