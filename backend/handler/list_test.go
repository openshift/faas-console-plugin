package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/scm"
	fn "knative.dev/func/pkg/functions"
)

func listRequest() *http.Request {
	return scopedListRequest("?all=true")
}

func scopedListRequest(query string) *http.Request {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/func/list"+query, nil)
	req.Header.Set("X-SCM-Token", "valid-pat")
	req.Header.Set("Authorization", "Bearer ocp-token")
	return req
}

var _ = Describe("GET /api/v1/func/list", func() {
	It("returns enriched list items sourced from the repo", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
		})
		withFunctionsClient(&functions.ClientStub{})

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
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) { return nil, nil },
		})
		withFunctionsClient(&functions.ClientStub{
			OnList: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
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
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
		})
		withFunctionsClient(&functions.ClientStub{
			OnList: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
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

	It("keeps both entries when the same name exists in different namespaces", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
		})
		withFunctionsClient(&functions.ClientStub{
			OnList: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				return []fn.ListItem{{Name: "my-func", Namespace: "prod"}}, nil
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(2))
		Expect(items).To(ContainElement(SatisfyAll(
			HaveField("Name", "my-func"), HaveField("Namespace", "demo"), HaveField("Source", sourceRepo),
		)))
		Expect(items).To(ContainElement(SatisfyAll(
			HaveField("Name", "my-func"), HaveField("Namespace", "prod"), HaveField("Source", sourceCluster),
		)))
	})

	It("falls back to repo-only results when the cluster list fails", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
		})
		withFunctionsClient(&functions.ClientStub{
			OnList: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
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
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "my-func", URL: "https://github.com/alice/my-func", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
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
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "broken", URL: "https://github.com/alice/broken", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "", fmt.Errorf("not found")
			},
		})
		withFunctionsClient(&functions.ClientStub{})

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
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "bad-yaml", URL: "https://github.com/alice/bad-yaml", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "}{not yaml", nil
			},
		})
		withFunctionsClient(&functions.ClientStub{})

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

	It("returns 502 when both repo and cluster listing fail", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, errors.New("connection refused")
			},
		})
		withFunctionsClientError(errors.New("cannot reach cluster"))

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})

	It("returns empty list when no repos or cluster functions found", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, nil
			},
		})
		withFunctionsClient(&functions.ClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(strings.TrimSpace(w.Body.String())).To(Equal("[]"))
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
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, scm.ErrUnauthorized
			},
		})
		withFunctionsClient(&functions.ClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, listRequest())

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 400 when neither namespace nor all is provided", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) { return nil, nil },
		})
		withFunctionsClient(&functions.ClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, scopedListRequest(""))

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("returns 400 when namespace is empty", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) { return nil, nil },
		})
		withFunctionsClient(&functions.ClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, scopedListRequest("?namespace="))

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("scopes repo and cluster functions to the requested namespace", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "in-demo", URL: "https://github.com/alice/in-demo", DefaultBranch: "main"},
					{Owner: "alice", Name: "in-other", URL: "https://github.com/alice/in-other", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				if repo == "in-demo" {
					return "name: in-demo\nnamespace: demo\nruntime: go\n", nil
				}
				return "name: in-other\nnamespace: other\nruntime: go\n", nil
			},
		})
		var gotNamespace string
		withFunctionsClient(&functions.ClientStub{
			OnList: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				gotNamespace = namespace
				return []fn.ListItem{{Name: "cluster-in-demo", Namespace: "demo", Runtime: "node"}}, nil
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, scopedListRequest("?namespace=demo"))

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(gotNamespace).To(Equal("demo"))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(2))
		names := []string{items[0].Name, items[1].Name}
		Expect(names).To(ConsistOf("in-demo", "cluster-in-demo"))
	})

	It("drops repo functions whose func.yaml cannot be attributed to the namespace when scoped", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "broken", URL: "https://github.com/alice/broken", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "", fmt.Errorf("not found")
			},
		})
		withFunctionsClient(&functions.ClientStub{})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, scopedListRequest("?namespace=demo"))

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(BeEmpty())
	})

	It("returns all functions unfiltered and cluster-wide when all=true", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "in-demo", URL: "https://github.com/alice/in-demo", DefaultBranch: "main"},
					{Owner: "alice", Name: "in-other", URL: "https://github.com/alice/in-other", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				if repo == "in-demo" {
					return "name: in-demo\nnamespace: demo\nruntime: go\n", nil
				}
				return "name: in-other\nnamespace: other\nruntime: go\n", nil
			},
		})
		var gotNamespace = "unset"
		withFunctionsClient(&functions.ClientStub{
			OnList: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				gotNamespace = namespace
				return []fn.ListItem{{Name: "cluster-only", Namespace: "prod", Runtime: "node"}}, nil
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, scopedListRequest("?all=true"))

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(gotNamespace).To(Equal(""))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(3))
	})

	It("gives all=true precedence over a specific namespace", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "in-other", URL: "https://github.com/alice/in-other", DefaultBranch: "main"},
				}, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: in-other\nnamespace: other\nruntime: go\n", nil
			},
		})
		var gotNamespace = "unset"
		withFunctionsClient(&functions.ClientStub{
			OnList: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				gotNamespace = namespace
				return nil, nil
			},
		})

		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, scopedListRequest("?all=true&namespace=demo"))

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(gotNamespace).To(Equal(""))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].Name).To(Equal("in-other"))
	})

	It("falls back to cluster-only results when the SCM API is unavailable", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, errors.New("connection refused")
			},
		})
		withFunctionsClient(&functions.ClientStub{
			OnList: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
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
		Expect(items[0].Source).To(Equal(sourceCluster))
	})
})
