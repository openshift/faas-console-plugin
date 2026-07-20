package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

// Handlers holds dependencies shared across all HTTP handlers.
// It is the adapter layer: parse request, call core packages, write response.
// No business logic lives here.
type Handlers struct {
	caPath        string
	githubBaseURL string // empty → "https://api.github.com"; overridden in tests
	k8sBaseURL    string // empty → derived from KUBERNETES_SERVICE_HOST/PORT; overridden in tests
	saTokenExpiry int64  // 0 → cluster.DefaultTokenExpiry
}

func New(caPath, k8sBaseURL string, saTokenExpiry int64) *Handlers {
	return &Handlers{caPath: caPath, k8sBaseURL: k8sBaseURL, saTokenExpiry: saTokenExpiry}
}

func extractPAT(r *http.Request) (string, bool) {
	v := r.Header.Get("X-GitHub-Token")
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
