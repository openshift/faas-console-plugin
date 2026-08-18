package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/scm"
	k8svalidation "k8s.io/apimachinery/pkg/util/validation"
)

var (
	validBranch      = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$`)
	validRuntimes    = map[string]bool{"node": true, "python": true, "go": true, "quarkus": true}
	validSCMName     = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
	validEnvVarName  = regexp.MustCompile(`^[-._a-zA-Z][-._a-zA-Z0-9]*$`)
	validK8sName     = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)
	newClusterClient = cluster.New
	generateScaffold = functions.Generate
)

type createRequest struct {
	Name      string             `json:"name"`
	Runtime   string             `json:"runtime"`
	Registry  string             `json:"registry"`
	Namespace string             `json:"namespace"`
	Branch    string             `json:"branch"`
	Owner     string             `json:"owner"`
	Repo      string             `json:"repo"`
	EnvVars   []functions.EnvVar `json:"envVars,omitempty"`
}

// errUpstream marks errors that originated from an upstream API (SCM, cluster)
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

	pat, ok := extractSCMToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-SCM-Token header is required")
		return
	}
	ocpToken, ok := extractOCPToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Authorization header is required")
		return
	}

	if err := h.createFunction(r.Context(), req, pat, ocpToken); err != nil {
		switch {
		case errors.Is(err, scm.ErrUnauthorized):
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
		case errors.Is(err, scm.ErrRepoExists):
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

func (h *Handlers) createFunction(ctx context.Context, req createRequest, pat, ocpToken string) (retErr error) {
	files, err := generateScaffold(functions.ScaffoldConfig{
		Name:             req.Name,
		Runtime:          req.Runtime,
		Registry:         req.Registry,
		Namespace:        req.Namespace,
		Branch:           req.Branch,
		SCM:              scm.DefaultPlatform,
		InternalRegistry: strings.HasPrefix(req.Registry, config.OCPInternalRegistry),
		EnvVars:          req.EnvVars,
	})
	if err != nil {
		return fmt.Errorf("generate scaffold: %w", err)
	}

	cl, err := newClusterClient(h.kubeHost, ocpToken, h.caCert)
	if err != nil {
		return fmt.Errorf("%w: %w", errUpstream, fmt.Errorf("connect to cluster: %w", err))
	}

	provisioned, err := cluster.ProvisionRBAC(ctx, cl, req.Namespace)
	if err != nil {
		return fmt.Errorf("%w: %w", errUpstream, fmt.Errorf("provision cluster resources: %w", err))
	}
	defer func() {
		if retErr != nil {
			cluster.RollbackProvisionedRBAC(context.Background(), cl, req.Namespace, provisioned)
		}
	}()

	kubeconfig, err := cluster.GenerateKubeconfig(ctx, cl, req.Namespace, h.externalAPIServerURL, h.caCert)
	if err != nil {
		return fmt.Errorf("%w: %w", errUpstream, fmt.Errorf("generate kubeconfig: %w", err))
	}

	client := config.SCMRegistry.Client(scm.DefaultPlatform, pat)
	if err := client.InitRepo(ctx, req.Owner, req.Repo, req.Branch, []string{"serverless-function"}); err != nil {
		if errors.Is(err, scm.ErrUnauthorized) || errors.Is(err, scm.ErrRepoExists) {
			return err
		}
		slog.Error("failed to init repo", "owner", req.Owner, "repo", req.Repo, "err", err)
		return fmt.Errorf("%w: %w", errUpstream, fmt.Errorf("init repo: %w", err))
	}
	defer func() {
		if retErr != nil {
			if err := client.DeleteRepo(context.Background(), req.Owner, req.Repo); err != nil {
				slog.Warn("rollback: failed to delete repo", "owner", req.Owner, "repo", req.Repo, "err", err)
			}
		}
	}()

	if err := client.StoreSecret(ctx, req.Owner, req.Repo, "KUBECONFIG", kubeconfig); err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			return err
		}
		slog.Error("failed to store CI secret", "owner", req.Owner, "repo", req.Repo, "err", err)
		return fmt.Errorf("%w: %w", errUpstream, fmt.Errorf("store secret: %w", err))
	}
	if err := client.PushFiles(ctx, req.Owner, req.Repo, req.Branch, "Initialize Knative function project", files); err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			return err
		}
		slog.Error("failed to push files", "owner", req.Owner, "repo", req.Repo, "err", err)
		return fmt.Errorf("%w: %w", errUpstream, fmt.Errorf("push files: %w", err))
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
	if strings.HasPrefix(req.Registry, config.OCPInternalRegistry) {
		expected := config.OCPInternalRegistry + req.Namespace
		if req.Registry != expected {
			return fmt.Errorf("registry namespace must match deployment namespace: expected %q, got %q", expected, req.Registry)
		}
	}
	if !validSCMName.MatchString(req.Owner) {
		return fmt.Errorf("invalid owner")
	}
	if !validSCMName.MatchString(req.Repo) {
		return fmt.Errorf("invalid repo name")
	}
	for i, ev := range req.EnvVars {
		if !validEnvVarName.MatchString(ev.Name) {
			return fmt.Errorf("envVars[%d]: invalid name %q", i, ev.Name)
		}
		switch ev.Source {
		case "secret", "configMap":
			if !validK8sName.MatchString(ev.ResourceName) {
				return fmt.Errorf("envVars[%d]: invalid resourceName %q", i, ev.ResourceName)
			}
			if ev.ResourceKey == "" {
				return fmt.Errorf("envVars[%d]: resourceKey is required for source %q", i, ev.Source)
			}
		case "value":
			// plain key/value, no extra validation
		default:
			return fmt.Errorf("envVars[%d]: invalid source %q", i, ev.Source)
		}
	}
	return nil
}
