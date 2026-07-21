package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/scaffold"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
	k8svalidation "k8s.io/apimachinery/pkg/util/validation"
)

var (
	validBranch     = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$`)
	validRuntimes   = map[string]bool{"node": true, "python": true, "go": true, "quarkus": true}
	validGitHubName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
)

type createRequest struct {
	Name      string `json:"name"`
	Runtime   string `json:"runtime"`
	Registry  string `json:"registry"`
	Namespace string `json:"namespace"`
	Branch    string `json:"branch"`
	Owner     string `json:"owner"`
	Repo      string `json:"repo"`
}

// errUpstream marks errors that originated from an upstream API (GitHub, cluster)
// so the handler can map them to 502 instead of 500.
var errUpstream = errors.New("upstream error")

func (h *Handlers) HandleFuncCreate(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := validateCreateRequest(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	pat, ok := extractPAT(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-GitHub-Token header is required")
		return
	}
	ocpToken, ok := extractOCPToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Authorization header is required")
		return
	}

	if err := h.createFunction(req, pat, ocpToken); err != nil {
		switch {
		case github.IsUnauthorized(err):
			writeError(w, http.StatusUnauthorized, "invalid GitHub token")
		case errors.Is(err, github.ErrRepoExists):
			writeError(w, http.StatusConflict, "repository already exists")
		case errors.Is(err, errUpstream):
			slog.Error("upstream service error", "err", err)
			writeError(w, http.StatusBadGateway, "failed to reach upstream service")
		default:
			slog.Error("internal error creating function", "err", err)
			writeError(w, http.StatusInternalServerError, "failed to create function")
		}
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func (h *Handlers) createFunction(req createRequest, pat, ocpToken string) error {
	sourceFiles, err := scaffold.Generate(scaffold.Config{
		Name:      req.Name,
		Runtime:   req.Runtime,
		Registry:  req.Registry,
		Namespace: req.Namespace,
	})
	if err != nil {
		return fmt.Errorf("generate scaffold: %w", err)
	}

	ciFiles, err := github.GenerateCIFiles(github.CIConfig{
		Runtime:  req.Runtime,
		Branch:   req.Branch,
		Registry: req.Registry,
	})
	if err != nil {
		return fmt.Errorf("generate CI workflow: %w", err)
	}
	files := append(sourceFiles, ciFiles...)

	var caCert []byte
	if h.caPath != "" {
		caCert, err = os.ReadFile(h.caPath)
		if err != nil {
			return fmt.Errorf("read CA certificate %q: %w", h.caPath, err)
		}
	}

	cl, err := cluster.New(ocpToken, h.k8sBaseURL, caCert, h.saTokenExpiry)
	if err != nil {
		return fmt.Errorf("%w: connect to cluster: %w", errUpstream, err)
	}

	kubeconfig, err := cluster.GenerateKubeconfig(cl, req.Namespace, h.k8sBaseURL, caCert)
	if err != nil {
		return fmt.Errorf("%w: provision cluster resources: %w", errUpstream, err)
	}

	gh := github.New(pat, h.githubBaseURL)
	if err := gh.InitRepo(req.Owner, req.Repo, req.Branch, []string{"serverless-function"}); err != nil {
		if github.IsUnauthorized(err) || errors.Is(err, github.ErrRepoExists) {
			return err
		}
		slog.Error("failed to init repo", "owner", req.Owner, "repo", req.Repo, "err", err)
		return fmt.Errorf("%w: init repo: %w", errUpstream, err)
	}
	if err := gh.StoreSecret(req.Owner, req.Repo, "KUBECONFIG", kubeconfig); err != nil {
		if github.IsUnauthorized(err) {
			return err
		}
		slog.Error("failed to store CI secret", "owner", req.Owner, "repo", req.Repo, "err", err)
		return fmt.Errorf("%w: store secret: %w", errUpstream, err)
	}
	if err := gh.PushFiles(req.Owner, req.Repo, req.Branch, "Initialize Knative function project", files); err != nil {
		if github.IsUnauthorized(err) {
			return err
		}
		slog.Error("failed to push files", "owner", req.Owner, "repo", req.Repo, "err", err)
		return fmt.Errorf("%w: push files: %w", errUpstream, err)
	}
	return nil
}

func validateCreateRequest(req createRequest) error {
	if errs := k8svalidation.IsDNS1123Label(req.Name); len(errs) > 0 {
		return fmt.Errorf("invalid function name: %s", errs[0])
	}
	if !validRuntimes[req.Runtime] {
		return fmt.Errorf("invalid runtime: must be one of node, python, go, quarkus")
	}
	if !validBranch.MatchString(req.Branch) || strings.HasPrefix(req.Branch, "refs/") {
		return fmt.Errorf("invalid branch name")
	}
	if errs := k8svalidation.IsDNS1123Label(req.Namespace); len(errs) > 0 {
		return fmt.Errorf("invalid namespace: %s", errs[0])
	}
	if req.Registry == "" {
		return fmt.Errorf("registry is required")
	}
	if strings.HasPrefix(req.Registry, github.OCPInternalRegistry) {
		expected := github.OCPInternalRegistry + req.Namespace
		if req.Registry != expected {
			return fmt.Errorf("registry namespace must match deployment namespace: expected %q, got %q", expected, req.Registry)
		}
	}
	if !validGitHubName.MatchString(req.Owner) {
		return fmt.Errorf("invalid owner")
	}
	if !validGitHubName.MatchString(req.Repo) {
		return fmt.Errorf("invalid repo name")
	}
	return nil
}
