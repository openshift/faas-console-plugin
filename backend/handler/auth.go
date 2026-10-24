package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
)

func (h *Handlers) HandleSaveSCMCredential(w http.ResponseWriter, r *http.Request) {
	// Gate before anything else: the PAT below is sent to the SCM provider,
	// and an unauthenticated caller must not be able to make the backend do
	// that for them.
	ocpToken, ok := extractOCPToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "authentication required")
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

	// Verify the token by fetching the user from GitHub, so a credential that
	// cannot work is never written over one that still does.
	scmClient, err := config.SCMRegistry.NewClient(scm.DefaultPlatform, req.PAT)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create scm client")
		return
	}
	user, err := scmClient.GetUser(r.Context())
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusForbidden, "invalid SCM token")
			return
		}
		slog.Error("failed to verify pat with the scm provider", "err", err)
		writeError(w, http.StatusBadGateway, "failed to reach the SCM API")
		return
	}

	err = h.scmCredentials.SaveCredential(r.Context(), ocpToken, credentials.Credential{
		Owner:     user.Login,
		AvatarURL: user.AvatarURL,
		Token:     req.PAT,
		Type:      credentials.CredentialTypePAT,
	})
	if err != nil {
		// writeAuthError splits these: a refused identity is the caller's
		// problem, anything else is the store being unreachable.
		writeAuthError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, githubAccount(user.Login, user.AvatarURL))
}

// HandleGetSCMCredential answers with the credential's public representation:
// which SCM account it belongs to, never the token itself.
func (h *Handlers) HandleGetSCMCredential(w http.ResponseWriter, r *http.Request) {
	ocpToken, _ := extractOCPToken(r)

	credential, err := h.scmCredentials.GetCredential(r.Context(), ocpToken)
	if errors.Is(err, credentials.ErrNoCredential) {
		writeError(w, http.StatusNotFound, "no stored credential")
		return
	}
	if err != nil {
		if errors.Is(err, identity.ErrUnauthenticated) {
			writeAuthError(w, err)
			return
		}
		slog.Error("failed to read the stored credential", "err", err)
		writeError(w, http.StatusServiceUnavailable, "credential store unavailable")
		return
	}

	writeJSON(w, http.StatusOK, githubAccount(credential.Owner, credential.AvatarURL))
}

func (h *Handlers) HandleDeleteSCMCredential(w http.ResponseWriter, r *http.Request) {
	ocpToken, _ := extractOCPToken(r)

	// Nothing to revoke if the caller cannot be identified. The browser
	// disconnects regardless, so this is not worth failing the request over.
	if err := h.scmCredentials.DeleteCredential(r.Context(), ocpToken); err != nil {
		slog.Error("failed to delete the stored credential", "err", err)
	}

	w.WriteHeader(http.StatusNoContent)
}

func githubAccount(login, avatarURL string) map[string]string {
	return map[string]string{"login": login, "avatarUrl": avatarURL}
}
