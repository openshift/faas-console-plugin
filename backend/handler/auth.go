package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

type authLoginRequest struct {
	PAT string `json:"pat"`
}

func (h *Handlers) HandleAuthLogin(w http.ResponseWriter, r *http.Request) {
	var req authLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.PAT == "" {
		writeError(w, http.StatusBadRequest, "pat is required")
		return
	}

	user, err := github.New(req.PAT, h.githubBaseURL).GetUser()
	if err != nil {
		if github.IsUnauthorized(err) {
			writeError(w, http.StatusUnauthorized, "invalid GitHub token")
			return
		}
		slog.Error("failed to get GitHub user", "err", err)
		writeError(w, http.StatusBadGateway, "failed to reach GitHub API")
		return
	}

	writeJSON(w, http.StatusOK, user)
}
