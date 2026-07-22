package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

type Handlers struct {
	caPath        string
	k8sBaseURL    string
	saTokenExpiry int64
}

func New(caPath, k8sBaseURL string, saTokenExpiry int64) *Handlers {
	return &Handlers{caPath: caPath, k8sBaseURL: k8sBaseURL, saTokenExpiry: saTokenExpiry}
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
