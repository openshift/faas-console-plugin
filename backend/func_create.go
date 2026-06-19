package main

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	cigithub "knative.dev/func/pkg/ci/github"
	"knative.dev/func/pkg/functions"
)

type funcCreateRequest struct {
	Name      string `json:"name"`
	Runtime   string `json:"runtime"`
	Registry  string `json:"registry"`
	Namespace string `json:"namespace"`
	Branch    string `json:"branch"`
}

// validName restricts function names to lowercase DNS-label characters.
var validName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

// validRuntimes is the set of supported function runtimes.
var validRuntimes = map[string]bool{
	"node": true, "python": true, "go": true, "quarkus": true,
}

// validBranch restricts branch names to safe git ref characters.
var validBranch = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$`)

// validNamespace restricts namespaces to valid Kubernetes names.
var validNamespace = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

type fileEntry struct {
	Path    string `json:"path"`
	Mode    string `json:"mode"`
	Content string `json:"content"`
	Type    string `json:"type"`
}

func handleFuncCreate(w http.ResponseWriter, r *http.Request) {
	var cfg funcCreateRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB limit
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		jsonError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}

	if !validName.MatchString(cfg.Name) {
		jsonError(w, "invalid function name: must contain only lowercase alphanumeric characters and hyphens", http.StatusBadRequest)
		return
	}
	if !validRuntimes[cfg.Runtime] {
		jsonError(w, "invalid runtime: must be one of node, python, go, quarkus", http.StatusBadRequest)
		return
	}
	if !validBranch.MatchString(cfg.Branch) {
		jsonError(w, "invalid branch name", http.StatusBadRequest)
		return
	}
	if !validNamespace.MatchString(cfg.Namespace) {
		jsonError(w, "invalid namespace: must contain only lowercase alphanumeric characters and hyphens", http.StatusBadRequest)
		return
	}

	tmpDir, err := os.MkdirTemp("", "func-create-*")
	if err != nil {
		jsonError(w, "failed to create temp dir: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(tmpDir)

	root := filepath.Join(tmpDir, cfg.Name)

	client := functions.New()
	_, err = client.Init(functions.Function{
		Name:      cfg.Name,
		Root:      root,
		Runtime:   cfg.Runtime,
		Registry:  cfg.Registry,
		Namespace: cfg.Namespace,
		Template:  "http",
	})
	if err != nil {
		jsonError(w, "failed to initialize function: "+err.Error(), http.StatusInternalServerError)
		return
	}

	if err := generateCIWorkflow(root, cfg.Runtime, cfg.Branch, cfg.Registry); err != nil {
		jsonError(w, "failed to generate CI workflow: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var files []fileEntry
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		relPath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		mode := "100644"
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode()&0111 != 0 {
			mode = "100755"
		}
		if info.Mode()&os.ModeSymlink != 0 {
			mode = "120000"
		}
		files = append(files, fileEntry{
			Path:    relPath,
			Mode:    mode,
			Content: string(content),
			Type:    "blob",
		})
		return nil
	})
	if err != nil {
		jsonError(w, "failed to read generated files: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(files); err != nil {
		log.Printf("failed to encode response: %v", err)
	}
}

const ocpInternalRegistry = "image-registry.openshift-image-registry.svc:5000/"

func generateCIWorkflow(root, runtime, branch, registry string) error {
	gen := cigithub.NewWorkflowGenerator(
		cigithub.WithWorkflowConfig(cigithub.WorkflowConfig{
			Branch:        branch,
			RegistryLogin: !strings.HasPrefix(registry, ocpInternalRegistry),
			TestStep:      cigithub.DefaultTestStep,
		}),
		cigithub.WithMessageWriter(io.Discard),
	)

	return gen.Generate(context.Background(), functions.Function{
		Root:    root,
		Runtime: runtime,
	})
}
