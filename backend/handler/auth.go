package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/session"
)

func (h *Handlers) HandleLogin(w http.ResponseWriter, r *http.Request) {
	ocpUser, err := h.currentUser(r)
	if err != nil {
		writeSessionError(w, err)
		return
	}

	var req struct {
		PAT string `json:"pat"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.PAT == "" {
		writeError(w, http.StatusBadRequest, "pat is required")
		return
	}

	// Verify PAT by fetching the user from GitHub
	scmClient, err := config.SCMRegistry.NewClient(scm.GitHub, req.PAT)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create scm client")
		return
	}
	user, err := scmClient.GetUser(r.Context())
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid github pat")
		return
	}

	token, err := h.sessionStore.CreateSession(r.Context(), ocpUser, session.Credential{
		Owner:     user.Login,
		AvatarURL: user.AvatarURL,
		Secret:    req.PAT,
		Type:      session.CredentialTypePAT,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{
		"token":     token,
		"login":     user.Login,
		"avatarUrl": user.AvatarURL,
	})
}

func (h *Handlers) HandleResumeSession(w http.ResponseWriter, r *http.Request) {
	ocpUser, err := h.currentUser(r)
	if err != nil {
		writeSessionError(w, err)
		return
	}

	sess, err := h.sessionStore.Reissue(r.Context(), ocpUser)
	if errors.Is(err, session.ErrNoCredential) {
		writeError(w, http.StatusNotFound, "no stored credential")
		return
	}
	if err != nil {
		// Not 404: the frontend treats that as "there is nothing stored" and
		// disconnects. Being unable to read the credential is not the same as
		// there not being one.
		slog.Error("failed to reissue session", "err", err)
		writeError(w, http.StatusServiceUnavailable, "session store unavailable")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"token":     sess.Token,
		"login":     sess.Owner,
		"avatarUrl": sess.AvatarURL,
	})
}

func (h *Handlers) HandleLogout(w http.ResponseWriter, r *http.Request) {
	ocpUser, err := h.currentUser(r)
	if err != nil {
		// Nothing to revoke that we can identify. The browser clears its own
		// state regardless, so this is not worth failing the request over.
		slog.Warn("logout without a resolvable OpenShift user", "err", err)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if err := h.sessionStore.DeleteSession(r.Context(), ocpUser); err != nil {
		slog.Error("failed to delete session", "err", err)
	}

	w.WriteHeader(http.StatusNoContent)
}
