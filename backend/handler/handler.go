package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
)

type Handlers struct {
	caCert               []byte // cluster CA certificate, read once at startup
	kubeHost             string // API server URL for dev/test; empty uses in-cluster config
	externalAPIServerURL string // external URL embedded in generated kubeconfigs
	tokenExpiry          int64  // requested SA token lifetime in seconds
}

func New(caPath, kubeHost, externalAPIServerURL string, tokenExpiry int64) (*Handlers, error) {
	var caCert []byte
	if caPath != "" {
		var err error
		caCert, err = os.ReadFile(caPath)
		if err != nil {
			return nil, fmt.Errorf("read CA certificate %q: %w", caPath, err)
		}
	}
	return &Handlers{caCert: caCert, kubeHost: kubeHost, externalAPIServerURL: externalAPIServerURL, tokenExpiry: tokenExpiry}, nil
}

func extractSCMToken(r *http.Request) (string, bool) {
	v := r.Header.Get("X-SCM-Token")
	return v, v != ""
}

func extractOCPToken(r *http.Request) (string, bool) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(auth, "Bearer ")
	return token, token != ""
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
