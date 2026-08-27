package handler

import "net/http"

// HandleHealthz reports server liveness for kubelet probes. It requires no
// auth and no cluster access.
func (h *Handlers) HandleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
