package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

type deployRequest struct {
	Branch string `json:"branch"`
}

func (h *Handlers) HandleFuncDeploy(w http.ResponseWriter, r *http.Request) {
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

	var req deployRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !validBranch.MatchString(req.Branch) || strings.HasPrefix(req.Branch, "refs/") {
		writeError(w, http.StatusBadRequest, "invalid branch name")
		return
	}

	client := config.SCMRegistry.Client(scm.DefaultPlatform, pat)
	if err := client.DispatchWorkflow(r.Context(), owner, name, functions.WorkflowFilename, req.Branch); err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("failed to dispatch workflow", "owner", owner, "repo", name, "err", err)
		writeError(w, http.StatusBadGateway, "failed to trigger deploy workflow")
		return
	}

	w.WriteHeader(http.StatusAccepted)
}
