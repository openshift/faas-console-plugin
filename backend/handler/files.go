package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

func (h *Handlers) HandleGetFiles(w http.ResponseWriter, r *http.Request) {
	pat, ok := extractPAT(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-GitHub-Token header is required")
		return
	}

	owner := r.PathValue("owner")
	name := r.PathValue("name")

	if !validGitHubName.MatchString(owner) || !validGitHubName.MatchString(name) {
		writeError(w, http.StatusBadRequest, "invalid owner or repository name")
		return
	}

	ref := r.URL.Query().Get("ref")
	if ref == "" {
		ref = "HEAD"
	}

	files, err := github.New(pat, h.githubBaseURL).GetFiles(r.Context(), owner, name, ref)
	if err != nil {
		if github.IsUnauthorized(err) {
			writeError(w, http.StatusUnauthorized, "invalid GitHub token")
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

func (h *Handlers) HandlePutFiles(w http.ResponseWriter, r *http.Request) {
	pat, ok := extractPAT(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-GitHub-Token header is required")
		return
	}

	owner := r.PathValue("owner")
	name := r.PathValue("name")

	if !validGitHubName.MatchString(owner) || !validGitHubName.MatchString(name) {
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

	if err := github.New(pat, h.githubBaseURL).PushFiles(r.Context(), owner, name, req.Branch, req.Message, req.Files); err != nil {
		if github.IsUnauthorized(err) {
			writeError(w, http.StatusUnauthorized, "invalid GitHub token")
			return
		}
		slog.Error("failed to push files", "owner", owner, "repo", name, "err", err)
		writeError(w, http.StatusBadGateway, "failed to push files to repository")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
