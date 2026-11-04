package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
)

type Handlers struct {
	caCert               []byte // cluster CA certificate, read once at startup
	kubeHost             string // API server URL for dev/test; empty uses in-cluster config
	externalAPIServerURL string // external URL embedded in generated kubeconfigs
	clusterID            string // unique cluster identifier
	saTokenExpiry        int64  // requested SA token lifetime in seconds
	scmCredentials       credentials.Provider
}

type httpError struct {
	code    int
	message string
	cause   error
}

func (e *httpError) Error() string {
	return e.message
}

func (e *httpError) Unwrap() error {
	return e.cause
}

func newHTTPError(code int, message string, cause error) error {
	return &httpError{code: code, message: message, cause: cause}
}

func New(caCert []byte, kubeHost, externalAPIServerURL, clusterID string, saTokenExpiry int64, scmCredentials credentials.Provider) *Handlers {
	return &Handlers{
		caCert:               caCert,
		kubeHost:             kubeHost,
		externalAPIServerURL: externalAPIServerURL,
		clusterID:            clusterID,
		saTokenExpiry:        saTokenExpiry,
		scmCredentials:       scmCredentials,
	}
}

// A 401 always means "connect to GitHub": the OpenShift identity could not be
// established, no credential is stored, or GitHub rejected the token. That
// lets the frontend read the one status as a lost connection.
func writeAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, identity.ErrUnauthenticated),
		errors.Is(err, credentials.ErrNoCredential):
		slog.Warn("rejecting request without a usable credential", "err", err)
		writeError(w, http.StatusUnauthorized, "authentication required")
	default:
		slog.Error("could not resolve the caller's credential", "err", err)
		writeError(w, http.StatusServiceUnavailable, "credential store unavailable")
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("failed to encode response", "err", err)
	}
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"message": msg})
}
