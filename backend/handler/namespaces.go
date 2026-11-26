package handler

import (
	"log/slog"
	"net/http"
	"slices"

	"golang.org/x/sync/errgroup"

	"github.com/openshift/faas-console-plugin/backend/cluster"
)

type namespacesResponse struct {
	Namespaces          []string `json:"namespaces"`
	SystemNamespaces    []string `json:"systemNamespaces"`
	CanCreateNamespaces bool     `json:"canCreateNamespaces"`
}

// HandleListNamespaces returns the namespaces the caller may deploy a function
// into. Callers who cannot create namespaces never see system namespaces, so a
// developer is only offered namespaces meant for their own workloads. Callers
// who can are given every namespace, and the system ones are also listed in
// SystemNamespaces so the UI can warn before deploying there.
func (h *Handlers) HandleListNamespaces(w http.ResponseWriter, r *http.Request) {
	ocpToken := ocpTokenFrom(r.Context())

	cl, err := newClusterClient(h.kubeHost, ocpToken, h.caCert)
	if err != nil {
		slog.Error("failed to connect to cluster", "err", err)
		writeError(w, http.StatusBadGateway, "failed to connect to cluster")
		return
	}

	var (
		projects  []string
		canCreate bool
	)
	g, ctx := errgroup.WithContext(r.Context())
	g.Go(func() error {
		var err error
		projects, err = cl.ListProjects(ctx)
		return err
	})
	g.Go(func() error {
		var err error
		canCreate, err = cl.CanCreateNamespaces(ctx)
		return err
	})
	if err := g.Wait(); err != nil {
		slog.Error("failed to list namespaces", "err", err)
		writeError(w, http.StatusBadGateway, "failed to list namespaces")
		return
	}

	resp := namespacesResponse{
		Namespaces:          make([]string, 0, len(projects)),
		SystemNamespaces:    []string{},
		CanCreateNamespaces: canCreate,
	}
	for _, ns := range projects {
		system := cluster.IsSystemNamespace(ns)
		if system && !canCreate {
			continue
		}
		resp.Namespaces = append(resp.Namespaces, ns)
		if system {
			resp.SystemNamespaces = append(resp.SystemNamespaces, ns)
		}
	}
	slices.Sort(resp.Namespaces)
	slices.Sort(resp.SystemNamespaces)

	writeJSON(w, http.StatusOK, resp)
}
