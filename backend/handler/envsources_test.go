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

func envSourceRequest(namespace, resource string) *http.Request {
	req := httptest.NewRequestWithContext(testOCPTokenContext(), http.MethodGet,
		"/api/v1/namespaces/"+namespace+"/"+resource, nil)
	req.SetPathValue("namespace", namespace)
	return req
}

var _ = Describe("Environment variable source endpoints", func() {
	type endpoint struct {
		resource string
		handle   func(*Handlers, http.ResponseWriter, *http.Request)
		stub     func(func(context.Context, string) ([]cluster.KeyedResource, error)) *cluster.ClientStub
	}

	endpoints := []endpoint{
		{
			resource: "secrets",
			handle:   (*Handlers).HandleListSecrets,
			stub: func(f func(context.Context, string) ([]cluster.KeyedResource, error)) *cluster.ClientStub {
				return &cluster.ClientStub{OnListSecrets: f}
			},
		},
		{
			resource: "configmaps",
			handle:   (*Handlers).HandleListConfigMaps,
			stub: func(f func(context.Context, string) ([]cluster.KeyedResource, error)) *cluster.ClientStub {
				return &cluster.ClientStub{OnListConfigMaps: f}
			},
		},
	}

	for _, ep := range endpoints {
		Describe("GET /api/v1/namespaces/{namespace}/"+ep.resource, func() {
			It("returns the names and key names in the requested namespace", func() {
				var gotNamespace string
				withClusterStub(ep.stub(func(ctx context.Context, namespace string) ([]cluster.KeyedResource, error) {
					gotNamespace = namespace
					return []cluster.KeyedResource{{Name: "db", Keys: []string{"password"}}}, nil
				}))

				w := httptest.NewRecorder()
				ep.handle(&Handlers{}, w, envSourceRequest("team-a", ep.resource))

				Expect(w.Code).To(Equal(http.StatusOK))
				Expect(gotNamespace).To(Equal("team-a"))
				var items []cluster.KeyedResource
				Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
				Expect(items).To(Equal([]cluster.KeyedResource{{Name: "db", Keys: []string{"password"}}}))
			})

			It("connects to the cluster with the caller's token", func() {
				var gotToken string
				orig := newClusterClient
				newClusterClient = func(host, token string, caCert []byte) (cluster.Client, error) {
					gotToken = token
					return &cluster.ClientStub{}, nil
				}
				DeferCleanup(func() { newClusterClient = orig })

				w := httptest.NewRecorder()
				ep.handle(&Handlers{}, w, envSourceRequest("team-a", ep.resource))

				Expect(w.Code).To(Equal(http.StatusOK))
				Expect(gotToken).To(Equal("ocp-token"))
			})

			It("rejects a namespace that is not a valid name", func() {
				w := httptest.NewRecorder()
				ep.handle(&Handlers{}, w, envSourceRequest("Not_Valid", ep.resource))

				Expect(w.Code).To(Equal(http.StatusBadRequest))
			})

			It("returns 403 when the caller may not list them", func() {
				withClusterStub(ep.stub(func(context.Context, string) ([]cluster.KeyedResource, error) {
					return nil, cluster.ErrNamespaceForbidden
				}))

				w := httptest.NewRecorder()
				ep.handle(&Handlers{}, w, envSourceRequest("team-a", ep.resource))

				Expect(w.Code).To(Equal(http.StatusForbidden))
			})

			It("returns 502 when listing fails", func() {
				withClusterStub(ep.stub(func(context.Context, string) ([]cluster.KeyedResource, error) {
					return nil, errors.New("boom")
				}))

				w := httptest.NewRecorder()
				ep.handle(&Handlers{}, w, envSourceRequest("team-a", ep.resource))

				Expect(w.Code).To(Equal(http.StatusBadGateway))
			})

			It("returns 502 when the cluster cannot be reached", func() {
				withClusterClientError(errors.New("no route to host"))

				w := httptest.NewRecorder()
				ep.handle(&Handlers{}, w, envSourceRequest("team-a", ep.resource))

				Expect(w.Code).To(Equal(http.StatusBadGateway))
			})
		})
	}

})
