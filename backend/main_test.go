package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/handler"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
)

func TestRoutes(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Routes Suite")
}

var _ = Describe("API routes", func() {

	It("connects, reads the account, and disconnects without requiring a pre-existing credential", func() {
		original := config.SCMRegistry
		config.SCMRegistry = scm.Registry{scm.GitHub: func(string) scm.Client {
			return &scm.ClientStub{OnGetUser: func(context.Context) (*scm.User, error) {
				return &scm.User{Login: "alice"}, nil
			}}
		}}
		DeferCleanup(func() { config.SCMRegistry = original })
		mux := testMux(make(credentials.MapProvider))

		Expect(serveRoute(mux, http.MethodDelete, "/api/v1/scm/github/credential", "").Code).To(Equal(http.StatusNoContent))
		Expect(serveRoute(mux, http.MethodGet, "/api/v1/scm/github/credential", "").Code).To(Equal(http.StatusNotFound))
		Expect(serveRoute(mux, http.MethodPost, "/api/v1/scm/github/credential", `{"pat":"test-pat"}`).Code).To(Equal(http.StatusCreated))
		Expect(serveRoute(mux, http.MethodGet, "/api/v1/scm/github/credential", "").Code).To(Equal(http.StatusOK))
		Expect(serveRoute(mux, http.MethodDelete, "/api/v1/scm/github/credential", "").Code).To(Equal(http.StatusNoContent))
		Expect(serveRoute(mux, http.MethodGet, "/api/v1/scm/github/credential", "").Code).To(Equal(http.StatusNotFound))
	})

	It("uses each caller's saved PAT and disconnects only the requesting caller", func() {
		original := config.SCMRegistry
		config.SCMRegistry = scm.Registry{scm.GitHub: func(pat string) scm.Client {
			return &scm.ClientStub{
				OnGetUser: func(context.Context) (*scm.User, error) {
					return &scm.User{Login: strings.TrimSuffix(pat, "-pat") + "-gh"}, nil
				},
				OnGetFiles: func(_ context.Context, owner, _, _ string) ([]scm.FileEntry, error) {
					if pat != owner+"-pat" {
						return nil, scm.ErrUnauthorized
					}
					return []scm.FileEntry{{Path: "func.yaml", Content: "name: " + owner}}, nil
				},
			}
		}}
		DeferCleanup(func() { config.SCMRegistry = original })
		mux := testMux(make(credentials.MapProvider))
		for _, owner := range []string{"alice", "bob"} {
			response := serveRouteAs(mux, owner+"-ocp", http.MethodPost, "/api/v1/scm/github/credential", `{"pat":"`+owner+`-pat"}`)
			Expect(response.Code).To(Equal(http.StatusCreated))
		}
		for _, owner := range []string{"alice", "bob"} {
			account := serveRouteAs(mux, owner+"-ocp", http.MethodGet, "/api/v1/scm/github/credential", "")
			Expect(account.Code).To(Equal(http.StatusOK))
			Expect(account.Body.String()).To(MatchJSON(`{"login":"` + owner + `-gh","avatarUrl":""}`))
			files := serveRouteAs(mux, owner+"-ocp", http.MethodGet, "/api/v1/func/"+owner+"/fn/files", "")
			Expect(files.Code).To(Equal(http.StatusOK))
			Expect(files.Body.String()).To(ContainSubstring("name: " + owner))
		}

		Expect(serveRouteAs(mux, "bob-ocp", http.MethodDelete, "/api/v1/scm/github/credential", "").Code).To(Equal(http.StatusNoContent))
		Expect(serveRouteAs(mux, "bob-ocp", http.MethodGet, "/api/v1/scm/github/credential", "").Code).To(Equal(http.StatusNotFound))
		alice := serveRouteAs(mux, "alice-ocp", http.MethodGet, "/api/v1/scm/github/credential", "")
		Expect(alice.Code).To(Equal(http.StatusOK))
		Expect(alice.Body.String()).To(MatchJSON(`{"login":"alice-gh","avatarUrl":""}`))
	})

	It("preserves file path parameters through the protected mux", func() {
		original := config.SCMRegistry
		config.SCMRegistry = scm.Registry{scm.GitHub: func(pat string) scm.Client {
			return &scm.ClientStub{OnGetFiles: func(_ context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				if pat != "test-pat" {
					return nil, scm.ErrUnauthorized
				}
				return []scm.FileEntry{{Path: owner + "/" + repo + "/" + ref}}, nil
			}}
		}}
		DeferCleanup(func() { config.SCMRegistry = original })
		mux := testMux(credentials.MapProvider{"ocp-token": {Token: "test-pat"}})

		w := serveRoute(mux, http.MethodGet, "/api/v1/func/alice/fn/files?ref=main", "")

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(w.Body.String()).To(ContainSubstring("alice/fn/main"))
	})

	It("keeps health, static files, and workflow SSE outside the credential middleware", func() {
		provider := credentials.ProviderStub{OnGet: func(context.Context, string) (credentials.Credential, error) {
			return credentials.Credential{}, errors.New("cluster unavailable")
		}}
		mux := testMux(provider)

		Expect(serveRoute(mux, http.MethodGet, "/healthz", "").Code).To(Equal(http.StatusOK))
		Expect(serveRoute(mux, http.MethodGet, "/", "").Body.String()).To(Equal("static content"))
		Expect(serveRoute(mux, http.MethodGet, "/api/v1/scm/github/credential", "").Code).To(Equal(http.StatusServiceUnavailable))
		watch := serveRoute(mux, http.MethodGet, "/api/v1/func/workflow-run/watch", "")
		Expect(watch.Code).To(Equal(http.StatusOK))
		Expect(watch.Header().Get("Content-Type")).To(Equal("text/event-stream"))
		Expect(watch.Body.String()).To(ContainSubstring(`"code":503`))
	})
})

func testMux(provider credentials.Provider) *http.ServeMux {
	h := handler.New(nil, "", "", 0, provider)
	return newMux(h, provider, fstest.MapFS{"index.html": {Data: []byte("static content")}})
}

func serveRoute(mux http.Handler, method, path, body string) *httptest.ResponseRecorder {
	return serveRouteAs(mux, "ocp-token", method, path, body)
}

func serveRouteAs(mux http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}
