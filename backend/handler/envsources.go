package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	k8svalidation "k8s.io/apimachinery/pkg/util/validation"

	"github.com/openshift/faas-console-plugin/backend/cluster"
)

// HandleListSecrets returns the Secrets in a namespace as names and key names,
// for picking environment variable sources. Secret values are never returned.
func (h *Handlers) HandleListSecrets(w http.ResponseWriter, r *http.Request) {
	h.handleListKeyedResources(w, r, "secrets", cluster.Client.ListSecrets)
}

// HandleListConfigMaps returns the ConfigMaps in a namespace as names and key
// names, for picking environment variable sources.
func (h *Handlers) HandleListConfigMaps(w http.ResponseWriter, r *http.Request) {
	h.handleListKeyedResources(w, r, "config maps", cluster.Client.ListConfigMaps)
}

func (h *Handlers) handleListKeyedResources(
	w http.ResponseWriter,
	r *http.Request,
	kind string,
	list func(cluster.Client, context.Context, string) ([]cluster.KeyedResource, error),
) {
	ocpToken, ok := extractOCPToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Authorization header is required")
		return
	}
	namespace := r.PathValue("namespace")
	if errs := k8svalidation.IsDNS1123Label(namespace); len(errs) > 0 {
		writeError(w, http.StatusBadRequest, "invalid namespace: "+errs[0])
		return
	}

	cl, err := newClusterClient(h.kubeHost, ocpToken, h.caCert)
	if err != nil {
		slog.Error("failed to connect to cluster", "err", err)
		writeError(w, http.StatusBadGateway, "failed to connect to cluster")
		return
	}

	items, err := list(cl, r.Context(), namespace)
	if errors.Is(err, cluster.ErrNamespaceForbidden) {
		writeError(w, http.StatusForbidden, "not allowed to list "+kind+" in namespace "+namespace)
		return
	}
	if err != nil {
		slog.Error("failed to list "+kind, "namespace", namespace, "err", err)
		writeError(w, http.StatusBadGateway, "failed to list "+kind)
		return
	}

	writeJSON(w, http.StatusOK, items)
}
