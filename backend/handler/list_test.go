package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	fn "knative.dev/func/pkg/functions"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

func listRequest() *http.Request {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/func/list", nil)
	req.Header.Set("X-SCM-Token", "valid-pat")
	req.Header.Set("Authorization", "Bearer ocp-token")
	return req
}

var _ = Describe("GET /api/v1/func/list", func() {
	It("returns enriched list items sourced from the repo", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			getFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
		})
		withFunctionsClient(&functionsClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].Owner).To(Equal("alice"))
		Expect(items[0].RepoName).To(Equal("my-func"))
		Expect(items[0].RepoURL).To(Equal("https://github.com/alice/my-func"))
		Expect(items[0].DefaultBranch).To(Equal("main"))
		Expect(items[0].Name).To(Equal("my-func"))
		Expect(items[0].Namespace).To(Equal("demo"))
		Expect(items[0].Runtime).To(Equal("go"))
		Expect(items[0].Source).To(Equal(sourceRepo))
	})

	It("includes cluster-only functions with source cluster", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) { return nil, nil },
		})
		withFunctionsClient(&functionsClientStub{
			list: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				return []fn.ListItem{{Name: "cluster-only", Namespace: "demo", Runtime: "node"}}, nil
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].Name).To(Equal("cluster-only"))
		Expect(items[0].Namespace).To(Equal("demo"))
		Expect(items[0].Runtime).To(Equal("node"))
		Expect(items[0].RepoName).To(BeEmpty())
		Expect(items[0].Source).To(Equal(sourceCluster))
	})

	It("keeps source repo for a function present in both repo and cluster", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			getFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
		})
		withFunctionsClient(&functionsClientStub{
			list: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				return []fn.ListItem{{Name: "my-func", Namespace: "demo"}}, nil
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].RepoName).To(Equal("my-func"))
		Expect(items[0].Source).To(Equal(sourceRepo))
	})

	It("falls back to repo-only results when the cluster list fails", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			getFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
		})
		withFunctionsClient(&functionsClientStub{
			list: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				return nil, errors.New("knative not installed")
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].RepoName).To(Equal("my-func"))
		Expect(items[0].Source).To(Equal(sourceRepo))
	})

	It("falls back to repo-only results when the cluster connection fails", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			getFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
		})
		withFunctionsClientError(errors.New("cannot reach cluster"))

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].RepoName).To(Equal("my-func"))
		Expect(items[0].Source).To(Equal(sourceRepo))
	})

	It("returns error when func.yaml cannot be read", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "broken", URL: "https://github.com/alice/broken", DefaultBranch: "main"},
				}, nil
			},
			getFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "", fmt.Errorf("not found")
			},
		})
		withFunctionsClient(&functionsClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].RepoName).To(Equal("broken"))
		Expect(items[0].Name).To(BeEmpty())
		Expect(items[0].Namespace).To(BeEmpty())
		Expect(items[0].Runtime).To(BeEmpty())
		Expect(items[0].Err).To(Equal("failed to read func.yaml"))
	})

	It("returns error when func.yaml contains invalid YAML", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "bad-yaml", URL: "https://github.com/alice/bad-yaml", DefaultBranch: "main"},
				}, nil
			},
			getFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "}{not yaml", nil
			},
		})
		withFunctionsClient(&functionsClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].RepoName).To(Equal("bad-yaml"))
		Expect(items[0].Name).To(BeEmpty())
		Expect(items[0].Err).To(Equal("invalid func.yaml"))
	})

	It("returns empty list when no repos or cluster functions found", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, nil
			},
		})
		withFunctionsClient(&functionsClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(BeEmpty())
	})

	It("returns 401 when no X-SCM-Token header is provided", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/list", nil)
		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 401 when no Authorization header is provided", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/list", nil)
		req.Header.Set("X-SCM-Token", "valid-pat")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 401 when the SCM token is invalid", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, scm.ErrUnauthorized
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 502 when the SCM API is unavailable", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, errors.New("connection refused")
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})
