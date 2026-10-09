package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/scm"
	k8svalidation "k8s.io/apimachinery/pkg/util/validation"
)

var validGitRef = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9._/-]*[a-zA-Z0-9])?$`)

func (h *Handlers) HandleGetFiles(w http.ResponseWriter, r *http.Request) {
	pat, ok := extractSCMToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-SCM-Token header is required")
		return
	}

	owner := r.PathValue("owner")
	name := r.PathValue("name")

	if !validSCMName.MatchString(owner) || !validSCMName.MatchString(name) {
		writeError(w, http.StatusBadRequest, "invalid owner or repository name")
		return
	}

	ref := r.URL.Query().Get("ref")
	if ref == "" {
		ref = "HEAD"
	}
	if !validGitRef.MatchString(ref) {
		writeError(w, http.StatusBadRequest, "invalid ref")
		return
	}

	client := config.SCMRegistry.Client(scm.DefaultPlatform, pat)
	files, err := client.GetFiles(r.Context(), owner, name, ref)
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("failed to get files", "owner", owner, "repo", name, "ref", ref, "err", err)
		writeError(w, http.StatusBadGateway, "failed to fetch repository files")
		return
	}

	writeJSON(w, http.StatusOK, files)
}

type putFilesRequest struct {
	Files   []scm.FileEntry `json:"files"`
	Message string          `json:"message"`
	Branch  string          `json:"branch"`
}

type putFilesTarget struct {
	owner  string
	repo   string
	branch string
}

func (h *Handlers) HandlePutFiles(w http.ResponseWriter, r *http.Request) {
	pat, ok := extractSCMToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-SCM-Token header is required")
		return
	}

	owner := r.PathValue("owner")
	name := r.PathValue("name")

	if !validSCMName.MatchString(owner) || !validSCMName.MatchString(name) {
		writeError(w, http.StatusBadRequest, "invalid owner or repository name")
		return
	}

	var req putFilesRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Message == "" {
		writeError(w, http.StatusBadRequest, "message is required")
		return
	}
	if req.Branch == "" {
		writeError(w, http.StatusBadRequest, "branch is required")
		return
	}
	if !validBranch.MatchString(req.Branch) || strings.HasPrefix(req.Branch, "refs/") {
		writeError(w, http.StatusBadRequest, "invalid branch name")
		return
	}
	if len(req.Files) == 0 {
		writeError(w, http.StatusBadRequest, "files must not be empty")
		return
	}

	client := config.SCMRegistry.Client(scm.DefaultPlatform, pat)
	target := putFilesTarget{owner: owner, repo: name, branch: req.Branch}
	if err := h.refreshKubeconfig(r, client, target, req.Files); err != nil {
		if responseErr, ok := errors.AsType[*httpError](err); ok {
			slog.Error("failed to refresh kubeconfig", "err", err)
			writeError(w, responseErr.code, responseErr.message)
			return
		}
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}

	if err := client.PushFiles(r.Context(), target.owner, target.repo, target.branch, req.Message, req.Files); err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("failed to push files", "owner", target.owner, "repo", target.repo, "err", err)
		writeError(w, http.StatusBadGateway, "failed to push files to repository")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) refreshKubeconfig(r *http.Request, client scm.Client, target putFilesTarget, files []scm.FileEntry) error {
	// Read namespace from the incoming func.yaml if present (preferred over the committed
	// version so that a namespace fix in the same push is honoured immediately).
	var namespace string
	for _, f := range files {
		if f.Path != "func.yaml" || f.Deleted {
			continue
		}
		_, ns, _, err := parseFuncYaml(f.Content)
		if err != nil {
			slog.Error("failed to parse func.yaml", "owner", target.owner, "repo", target.repo, "err", err)
			return newHTTPError(http.StatusUnprocessableEntity, "func.yaml: invalid configuration", err)
		}
		if errs := k8svalidation.IsDNS1123Label(ns); len(errs) > 0 {
			slog.Error("invalid namespace in func.yaml", "owner", target.owner, "repo", target.repo)
			return newHTTPError(http.StatusUnprocessableEntity, "func.yaml: invalid namespace", errors.New(errs[0]))
		}
		namespace = ns
		break
	}

	ocpToken, ok := extractOCPToken(r)
	if !ok {
		return newHTTPError(http.StatusUnauthorized, "Authorization header is required", nil)
	}

	// If func.yaml was not in the incoming files, read it from the repo now.
	if namespace == "" {
		funcYaml, err := client.GetFileContent(r.Context(), target.owner, target.repo, target.branch, "func.yaml")
		if err != nil {
			if errors.Is(err, scm.ErrUnauthorized) {
				return newHTTPError(http.StatusUnauthorized, "invalid SCM token", err)
			}
			slog.Error("failed to read func.yaml", "owner", target.owner, "repo", target.repo, "branch", target.branch, "err", err)
			return newHTTPError(http.StatusBadGateway, "failed to read function configuration", err)
		}
		_, ns, _, err := parseFuncYaml(funcYaml)
		if err != nil {
			slog.Error("failed to parse func.yaml", "owner", target.owner, "repo", target.repo, "branch", target.branch, "err", err)
			return newHTTPError(http.StatusUnprocessableEntity, "invalid existing function configuration", err)
		}
		if errs := k8svalidation.IsDNS1123Label(ns); len(errs) > 0 {
			slog.Error("invalid namespace in func.yaml", "owner", target.owner, "repo", target.repo, "branch", target.branch)
			return newHTTPError(http.StatusUnprocessableEntity, "invalid namespace in function configuration", errors.New(errs[0]))
		}
		namespace = ns
	}

	clusterClient, err := newClusterClient(h.kubeHost, ocpToken, h.caCert)
	if err != nil {
		slog.Error("failed to connect to cluster", "namespace", namespace, "err", err)
		return newHTTPError(http.StatusBadGateway, "failed to refresh deployment credentials", err)
	}

	switch nsErr := clusterClient.CheckNamespace(r.Context(), namespace); {
	case errors.Is(nsErr, cluster.ErrNamespaceForbidden):
		return newHTTPError(http.StatusForbidden, "func.yaml: no access to cluster namespace", nsErr)
	case errors.Is(nsErr, cluster.ErrNamespaceNotFound):
		return newHTTPError(http.StatusUnprocessableEntity, "func.yaml: cluster namespace does not exist", nsErr)
	}

	// Always provision RBAC and issue a fresh token on every push. ProvisionRBAC is
	// idempotent, so this is safe when resources already exist. Refreshing every time
	// ensures credentials invalidated by namespace recreation, manual SA deletion, or
	// any other out-of-band change are corrected before the next CI run.
	if _, err := cluster.ProvisionRBAC(r.Context(), clusterClient, namespace); err != nil {
		slog.Error("failed to provision RBAC", "namespace", namespace, "err", err)
		return newHTTPError(http.StatusBadGateway, "failed to provision deployment resources", err)
	}

	tokenStatus, err := clusterClient.RequestToken(r.Context(), namespace, h.saTokenExpiry)
	if err != nil {
		slog.Error("failed to request refreshed service account token", "namespace", namespace, "err", err)
		return newHTTPError(http.StatusBadGateway, "failed to refresh deployment credentials", err)
	}

	kubeconfig, err := cluster.GenerateKubeconfig(namespace, h.externalAPIServerURL, tokenStatus.Token, h.caCert)
	if err != nil {
		slog.Error("failed to generate refreshed kubeconfig", "namespace", namespace, "err", err)
		return newHTTPError(http.StatusBadGateway, "failed to refresh deployment credentials", err)
	}
	if err := client.StoreSecret(r.Context(), target.owner, target.repo, repoSecretKubeconfig, kubeconfig); err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			return newHTTPError(http.StatusUnauthorized, "invalid SCM token", err)
		}
		slog.Error("failed to update CI secret", "owner", target.owner, "repo", target.repo, "err", err)
		return newHTTPError(http.StatusBadGateway, "failed to update deployment secret", err)
	}
	return nil
}
