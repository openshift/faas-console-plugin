package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

type Handlers struct {
	caPath               string
	kubeHost             string // API server URL for dev/test; empty uses in-cluster config
	externalAPIServerURL string // external URL embedded in generated kubeconfigs
}

func New(caPath, kubeHost, externalAPIServerURL string) *Handlers {
	return &Handlers{caPath: caPath, kubeHost: kubeHost, externalAPIServerURL: externalAPIServerURL}
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
