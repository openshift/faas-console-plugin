package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/openshift/faas-console-plugin/backend/auth"
	"github.com/openshift/faas-console-plugin/backend/auth/identity"
)

type Handlers struct {
	caCert               []byte            // cluster CA certificate, read once at startup
	kubeHost             string            // API server URL for dev/test; empty uses in-cluster config
	externalAPIServerURL string            // external URL embedded in generated kubeconfigs
	saTokenExpiry        int64             // requested SA token lifetime in seconds
	sessionStore         *auth.Store       // session token to PAT mapping
	identityResolver     identity.Resolver // OCP user behind the console's bearer token
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

func New(caPath, kubeHost, externalAPIServerURL string, saTokenExpiry int64, sessionStore *auth.Store) (*Handlers, error) {
	var caCert []byte
	if caPath != "" {
		var err error
		caCert, err = os.ReadFile(caPath)
		if err != nil {
			return nil, fmt.Errorf("read CA certificate %q: %w", caPath, err)
		}
	}
	return &Handlers{
		caCert:               caCert,
		kubeHost:             kubeHost,
		externalAPIServerURL: externalAPIServerURL,
		saTokenExpiry:        saTokenExpiry,
		sessionStore:         sessionStore,
		identityResolver:     identity.NewResolver(kubeHost, caCert),
	}, nil
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
