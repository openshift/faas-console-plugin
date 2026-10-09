package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/openshift/faas-console-plugin/backend/auth"
	"github.com/openshift/faas-console-plugin/backend/auth/identity"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

const sessionHeader = "X-FUNC-SESSION"

// errNoSessionToken means the request carried no session handle at all, which
// is the caller's problem rather than a sign anything is wrong here.
var errNoSessionToken = errors.New("no session token in the request")

func (h *Handlers) extractCredentialFromSession(r *http.Request) (auth.Credential, error) {
	// Deliberately not Authorization: that header carries the OCP user token
	// forwarded by the console proxy (see extractOCPToken).
	token := r.Header.Get(sessionHeader)
	if token == "" {
		return auth.Credential{}, fmt.Errorf("%w: no %s header", errNoSessionToken, sessionHeader)
	}

	user, err := h.currentUser(r)
	if err != nil {
		return auth.Credential{}, err
	}

	return h.sessionStore.GetCredential(r.Context(), token, user)
}

func (h *Handlers) currentUser(r *http.Request) (identity.User, error) {
	ocpToken, ok := extractOCPToken(r)
	if !ok {
		return identity.User{}, fmt.Errorf("%w: no OpenShift user token", identity.ErrUnauthenticated)
	}

	user, err := h.identityResolver.ResolveUserIdentity(r.Context(), ocpToken)
	if err != nil {
		return identity.User{}, fmt.Errorf("resolve OpenShift user: %w", err)
	}
	return user, nil
}

func extractOCPToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(header, "Bearer ")
	return token, token != ""
}

func writeSessionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoSessionToken),
		errors.Is(err, identity.ErrUnauthenticated),
		errors.Is(err, auth.ErrInvalidSession),
		errors.Is(err, auth.ErrNoCredential):
		slog.Warn("rejecting request without a usable session", "err", err)
		writeError(w, http.StatusUnauthorized, "authentication required")
	default:
		slog.Error("could not resolve the caller's session", "err", err)
		writeError(w, http.StatusServiceUnavailable, "session store unavailable")
	}
}

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
	scmClient, err := config.SCMRegistry.NewClient(scm.DefaultPlatform, req.PAT)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create scm client")
		return
	}
	user, err := scmClient.GetUser(r.Context())
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid github pat")
			return
		}
		slog.Error("failed to verify pat with the scm provider", "err", err)
		writeError(w, http.StatusBadGateway, "failed to reach the SCM API")
		return
	}

	token, err := h.sessionStore.CreateSession(r.Context(), ocpUser, auth.Credential{
		Owner:     user.Login,
		AvatarURL: user.AvatarURL,
		Secret:    req.PAT,
		Type:      auth.CredentialTypePAT,
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
	if errors.Is(err, auth.ErrNoCredential) {
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
