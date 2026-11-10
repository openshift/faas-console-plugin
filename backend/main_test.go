package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

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

	DescribeTable("rejects API routes without an OpenShift token before reaching the handler",
		func(method, path string) {
			provider := credentials.ProviderStub{}
			mux := testMux(provider)
			req := httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(`{"pat":"test-pat"}`))
			w := httptest.NewRecorder()

			mux.ServeHTTP(w, req)

			Expect(w.Code).To(Equal(http.StatusUnauthorized))
		},
		Entry("save credential", http.MethodPost, "/api/v1/scm/github/credential"),
		Entry("read credential", http.MethodGet, "/api/v1/scm/github/credential"),
		Entry("delete credential", http.MethodDelete, "/api/v1/scm/github/credential"),
		Entry("list functions", http.MethodGet, "/api/v1/func/list"),
	)

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

	// The stream reports a missing token as an app-error frame, which
	// RequireOCPToken would turn into a plain HTTP 401.
	It("keeps workflow SSE outside the OpenShift token middleware", func() {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/func/workflow-run/watch", nil)
		w := httptest.NewRecorder()

		testMux(credentials.ProviderStub{}).ServeHTTP(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(w.Header().Get("Content-Type")).To(Equal("text/event-stream"))
		Expect(w.Body.String()).To(ContainSubstring(`"code":401`))
	})
})

var _ = Describe("SCM registry", func() {
	It("applies the workflow polling interval to clients for a custom GitHub API URL", func() {
		srv := httptest.NewServer(fakeWorkflowGitHub())
		DeferCleanup(srv.Close)

		expectPollsAtConfiguredInterval(newSCMRegistry(srv.URL, 10*time.Millisecond).Client(scm.GitHub, "test-pat"))
	})

	// Runs offline: the GitHub client captures http.DefaultTransport when it is
	// built, so swapping in a transport that serves the fake in-process keeps
	// every request off the network while the client still targets github.com.
	It("applies the workflow polling interval to clients for github.com when no API URL is set", func() {
		fake := fakeWorkflowGitHub()
		var offTarget atomic.Int32
		original := http.DefaultTransport
		DeferCleanup(func() { http.DefaultTransport = original })
		http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.URL.Scheme != "https" || r.URL.Host != "api.github.com" {
				offTarget.Add(1)
				return nil, fmt.Errorf("unexpected request to %s", r.URL)
			}
			rec := httptest.NewRecorder()
			fake.ServeHTTP(rec, r)
			res := rec.Result()
			res.Request = r
			return res, nil
		})

		expectPollsAtConfiguredInterval(newSCMRegistry("", 10*time.Millisecond).Client(scm.GitHub, "test-pat"))
		Expect(offTarget.Load()).To(BeZero(), "every request should target https://api.github.com")
	})
})

// fakeWorkflowGitHub serves the endpoints WatchWorkflowRuns needs for one
// repository whose run is in progress on the first poll and completed after.
func fakeWorkflowGitHub() http.HandlerFunc {
	var polls atomic.Int32
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/user":
			_ = json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
		case r.URL.Path == "/search/repositories":
			_ = json.NewEncoder(w).Encode(map[string]any{"total_count": 1, "items": []map[string]any{{
				"name":           "fn",
				"html_url":       "https://example.com/alice/fn",
				"default_branch": "main",
				"owner":          map[string]any{"login": "alice"},
			}}})
		case strings.Contains(r.URL.Path, "/actions/workflows/"):
			run := map[string]any{"id": 1, "status": "completed", "conclusion": "success"}
			if polls.Add(1) == 1 {
				run = map[string]any{"id": 1, "status": "in_progress"}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"total_count": 1, "workflow_runs": []any{run}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

// expectPollsAtConfiguredInterval watches workflow runs through client and
// expects the run's completion within 1s, which a client polling at the 3s
// default cannot report.
func expectPollsAtConfiguredInterval(client scm.Client) {
	GinkgoHelper()
	watch, err := client.WatchWorkflowRuns(context.Background(), "func-deploy.yaml")
	Expect(err).NotTo(HaveOccurred())
	DeferCleanup(watch.Stop)

	var event scm.WorkflowRunsEvent
	Eventually(watch.ResultChan()).Should(Receive(&event))
	Expect(event.Runs["alice/fn"].Status).To(Equal(scm.InProgress))

	Eventually(watch.ResultChan()).WithTimeout(time.Second).Should(Receive(&event))
	Expect(event.Runs["alice/fn"].Status).To(Equal(scm.Succeeded))
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func testMux(provider credentials.Provider) *http.ServeMux {
	h := handler.New(nil, "", "", "test-cluster-id", 0, provider)
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
