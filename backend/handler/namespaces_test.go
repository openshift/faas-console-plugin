package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/cluster"
)

func namespacesRequest() *http.Request {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/namespaces", nil)
	req.Header.Set("Authorization", "Bearer ocp-token")
	return req
}

func decodeNamespaces(w *httptest.ResponseRecorder) namespacesResponse {
	var resp namespacesResponse
	Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
	return resp
}

var _ = Describe("GET /api/v1/namespaces", func() {
	projects := func(names ...string) func(context.Context) ([]string, error) {
		return func(context.Context) ([]string, error) { return names, nil }
	}
	canCreate := func(allowed bool) func(context.Context) (bool, error) {
		return func(context.Context) (bool, error) { return allowed, nil }
	}

	It("hides system namespaces from a caller who cannot create namespaces", func() {
		withClusterStub(&cluster.ClientStub{
			OnListProjects:        projects("team-b", "openshift-monitoring", "default", "team-a", "kube-system"),
			OnCanCreateNamespaces: canCreate(false),
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListNamespaces(w, namespacesRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(decodeNamespaces(w)).To(Equal(namespacesResponse{
			Namespaces:          []string{"team-a", "team-b"},
			CanCreateNamespaces: false,
		}))
	})

	It("returns every namespace, sorted, to a caller who can create namespaces", func() {
		withClusterStub(&cluster.ClientStub{
			OnListProjects:        projects("team-a", "openshift-monitoring", "default"),
			OnCanCreateNamespaces: canCreate(true),
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListNamespaces(w, namespacesRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(decodeNamespaces(w)).To(Equal(namespacesResponse{
			Namespaces:          []string{"default", "openshift-monitoring", "team-a"},
			CanCreateNamespaces: true,
		}))
	})

	It("returns an empty list rather than null when the caller has no namespaces", func() {
		withClusterStub(&cluster.ClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListNamespaces(w, namespacesRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(w.Body.String()).To(ContainSubstring(`"namespaces":[]`))
	})

	It("requires the Authorization header", func() {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/namespaces", nil)

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListNamespaces(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 502 when the cluster cannot be reached", func() {
		withClusterClientError(errors.New("no route to host"))

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListNamespaces(w, namespacesRequest())

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})

	It("returns 502 when listing projects fails", func() {
		withClusterStub(&cluster.ClientStub{
			OnListProjects: func(context.Context) ([]string, error) { return nil, errors.New("boom") },
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListNamespaces(w, namespacesRequest())

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})

	It("returns 502 when the access review fails", func() {
		withClusterStub(&cluster.ClientStub{
			OnListProjects:        projects("team-a"),
			OnCanCreateNamespaces: func(context.Context) (bool, error) { return false, errors.New("boom") },
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListNamespaces(w, namespacesRequest())

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})
