package handler

import (
	"log/slog"
	"net/http"

	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

func (h *Handlers) HandleAuthLogin(w http.ResponseWriter, r *http.Request) {
	pat, ok := extractPAT(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-GitHub-Token header is required")
		return
	}

	user, err := github.New(pat, h.githubBaseURL).GetUser()
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
