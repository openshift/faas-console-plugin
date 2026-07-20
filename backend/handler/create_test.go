package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("POST /api/v1/func/create", func() {
	validBody := func() []byte {
		body, _ := json.Marshal(createRequest{
			Name:      "my-func",
			Runtime:   "go",
			Registry:  "image-registry.openshift-image-registry.svc:5000/default",
			Namespace: "default",
			Branch:    "main",
			Owner:     "alice",
			Repo:      "my-func",
		})
		return body
	}

	It("provisions cluster resources and creates the GitHub repository", func() {
		calls := map[string]int{}

		ghMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodPost && r.URL.Path == "/user/repos":
				calls["createRepo"]++
				w.WriteHeader(http.StatusCreated)
			case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/topics"):
				calls["setTopics"]++
				json.NewEncoder(w).Encode(map[string][]string{"names": {"serverless-function"}})
			case strings.Contains(r.URL.Path, "/git/ref/"):
				calls["getRef"]++
				json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "headsha"}})
			case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/git/commits/"):
				calls["getCommit"]++
				json.NewEncoder(w).Encode(map[string]any{"sha": "headsha", "tree": map[string]string{"sha": "treesha"}})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/blobs"):
				calls["createBlob"]++
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "blobsha"})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/trees"):
				calls["createTree"]++
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "newtreesha"})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/commits"):
				calls["createCommit"]++
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "newcommitsha"})
			case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/git/refs/"):
				calls["updateRef"]++
				json.NewEncoder(w).Encode(map[string]string{})
			case strings.Contains(r.URL.Path, "/actions/secrets/public-key"):
				calls["getPublicKey"]++
				json.NewEncoder(w).Encode(map[string]string{"key_id": "kid123", "key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="})
			case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/actions/secrets/"):
				calls["storeSecret"]++
				w.WriteHeader(http.StatusCreated)
			case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/repos/"):
				calls["getRepoInfo"]++
				json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
			default:
				GinkgoWriter.Printf("unexpected GitHub %s %s\n", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		DeferCleanup(ghMock.Close)

		k8sMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/apis/config.openshift.io/v1/infrastructures/cluster":
				calls["getInfraURL"]++
				json.NewEncoder(w).Encode(map[string]any{"status": map[string]string{"apiServerURL": "https://api.test-cluster.example.com:6443"}})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/serviceaccounts"):
				calls["k8s-sa"]++
				w.WriteHeader(http.StatusCreated)
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/roles"):
				calls["k8s-role"]++
				w.WriteHeader(http.StatusCreated)
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/rolebindings"):
				calls["k8s-rb"]++
				w.WriteHeader(http.StatusCreated)
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/token"):
				calls["k8s-token"]++
				json.NewEncoder(w).Encode(map[string]any{"status": map[string]string{"token": "sa-token"}})
			default:
				GinkgoWriter.Printf("unexpected K8s %s %s\n", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		DeferCleanup(k8sMock.Close)

		h := &Handlers{githubBaseURL: ghMock.URL, k8sBaseURL: k8sMock.URL}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(validBody()))
		req.Header.Set("X-GitHub-Token", "test-pat")
		req.Header.Set("Authorization", "Bearer ocp-token")
		w := httptest.NewRecorder()
		h.HandleFuncCreate(w, req)

		Expect(w.Code).To(Equal(http.StatusCreated), w.Body.String())
		for _, op := range []string{"getInfraURL", "createRepo", "setTopics", "getRepoInfo",
			"getPublicKey", "storeSecret",
			"getRef", "getCommit", "createTree", "createCommit", "updateRef",
			"k8s-sa", "k8s-role", "k8s-token"} {
			Expect(calls[op]).NotTo(BeZero(), "operation %q was not called", op)
		}
		Expect(calls["k8s-rb"]).To(Equal(2))
		Expect(calls["createBlob"]).NotTo(BeZero())
	})

	It("rejects requests without an X-GitHub-Token", func() {
		h := &Handlers{}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(validBody()))
		req.Header.Set("Authorization", "Bearer ocp-token")
		w := httptest.NewRecorder()
		h.HandleFuncCreate(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("rejects requests without an Authorization header", func() {
		h := &Handlers{}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(validBody()))
		req.Header.Set("X-GitHub-Token", "pat")
		w := httptest.NewRecorder()
		h.HandleFuncCreate(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	DescribeTable("rejects invalid function configurations",
		func(req createRequest) {
			h := &Handlers{}
			body, _ := json.Marshal(req)
			r := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(body))
			r.Header.Set("X-GitHub-Token", "pat")
			r.Header.Set("Authorization", "Bearer ocp-token")
			w := httptest.NewRecorder()
			h.HandleFuncCreate(w, r)
			Expect(w.Code).To(Equal(http.StatusBadRequest))
		},
		Entry("invalid function name", createRequest{Name: "INVALID", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("unsupported runtime", createRequest{Name: "fn", Runtime: "ruby", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("invalid branch name", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "bad branch!", Owner: "a", Repo: "r"}),
		Entry("invalid namespace", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "UPPER", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("missing registry", createRequest{Name: "fn", Runtime: "go", Registry: "", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("internal registry namespace mismatch", createRequest{Name: "fn", Runtime: "go", Registry: "image-registry.openshift-image-registry.svc:5000/default", Namespace: "test", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("missing owner", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "", Repo: "r"}),
		Entry("missing repo", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: ""}),
	)
})
