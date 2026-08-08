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

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("GET /api/v1/func/list", func() {
	It("returns enriched list items", func() {
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

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/list", nil)
		req.Header.Set("X-SCM-Token", "valid-pat")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].Owner).To(Equal("alice"))
		Expect(items[0].RepoName).To(Equal("my-func"))
		Expect(items[0].URL).To(Equal("https://github.com/alice/my-func"))
		Expect(items[0].DefaultBranch).To(Equal("main"))
		Expect(items[0].Name).To(Equal("my-func"))
		Expect(items[0].Namespace).To(Equal("demo"))
		Expect(items[0].Runtime).To(Equal("go"))
	})

	It("returns items with empty fields when func.yaml cannot be read", func() {
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

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/list", nil)
		req.Header.Set("X-SCM-Token", "valid-pat")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		var items []listItem
		Expect(json.NewDecoder(w.Body).Decode(&items)).To(Succeed())
		Expect(items).To(HaveLen(1))
		Expect(items[0].RepoName).To(Equal("broken"))
		Expect(items[0].Name).To(BeEmpty())
		Expect(items[0].Namespace).To(BeEmpty())
		Expect(items[0].Runtime).To(BeEmpty())
	})

	It("returns empty list when no repos found", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, nil
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/list", nil)
		req.Header.Set("X-SCM-Token", "valid-pat")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, req)

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

	It("returns 401 when the SCM token is invalid", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, scm.ErrUnauthorized
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/list", nil)
		req.Header.Set("X-SCM-Token", "bad-token")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 502 when the SCM API is unavailable", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, errors.New("connection refused")
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/list", nil)
		req.Header.Set("X-SCM-Token", "some-token")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleListFunctions(w, req)

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})
