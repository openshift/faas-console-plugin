package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"

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
		var mu sync.Mutex
		calls := map[string]int{}
		inc := func(key string) { mu.Lock(); calls[key]++; mu.Unlock() }

		ghMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodPost && r.URL.Path == "/user/repos":
				inc("createRepo")
				w.WriteHeader(http.StatusCreated)
			case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/topics"):
				inc("setTopics")
				json.NewEncoder(w).Encode(map[string][]string{"names": {"serverless-function"}})
			case strings.Contains(r.URL.Path, "/git/ref/"):
				inc("getRef")
				json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "headsha"}})
			case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/git/commits/"):
				inc("getCommit")
				json.NewEncoder(w).Encode(map[string]any{"sha": "headsha", "tree": map[string]string{"sha": "treesha"}})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/blobs"):
				inc("createBlob")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "blobsha"})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/trees"):
				inc("createTree")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "newtreesha"})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/commits"):
				inc("createCommit")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "newcommitsha"})
			case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/git/refs/"):
				inc("updateRef")
				json.NewEncoder(w).Encode(map[string]string{})
			case strings.Contains(r.URL.Path, "/actions/secrets/public-key"):
				inc("getPublicKey")
				json.NewEncoder(w).Encode(map[string]string{"key_id": "kid123", "key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="})
			case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/actions/secrets/"):
				inc("storeSecret")
				w.WriteHeader(http.StatusCreated)
			case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/repos/"):
				inc("getRepoInfo")
				json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
			default:
				GinkgoWriter.Printf("unexpected GitHub %s %s\n", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		DeferCleanup(ghMock.Close)

		k8sMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch {
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/serviceaccounts"):
				inc("k8s-sa")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/roles"):
				inc("k8s-role")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/rolebindings"):
				inc("k8s-rb")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/token"):
				inc("k8s-token")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{"status": map[string]string{"token": "sa-token"}})
			default:
				GinkgoWriter.Printf("unexpected K8s %s %s\n", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		DeferCleanup(k8sMock.Close)

		withSCMMock(ghMock.URL, func() {
			h := &Handlers{kubeHost: k8sMock.URL, externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(validBody()))
			req.Header.Set("X-SCM-Token", "test-pat")
			req.Header.Set("Authorization", "Bearer ocp-token")
			w := httptest.NewRecorder()
			h.HandleFuncCreate(w, req)

			Expect(w.Code).To(Equal(http.StatusCreated), w.Body.String())
			for _, op := range []string{"createRepo", "setTopics", "getRepoInfo",
				"getPublicKey", "storeSecret",
				"getRef", "getCommit", "createTree", "createCommit", "updateRef",
				"k8s-sa", "k8s-role", "k8s-token"} {
				Expect(calls[op]).NotTo(BeZero(), "operation %q was not called", op)
			}
			Expect(calls["k8s-rb"]).To(Equal(2))
			Expect(calls["createBlob"]).NotTo(BeZero())
		})
	})

	It("returns 409 when the SCM repository already exists", func() {
		ghMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && r.URL.Path == "/user/repos" {
				w.WriteHeader(http.StatusUnprocessableEntity)
				json.NewEncoder(w).Encode(map[string]any{
					"message": "Repository creation failed.",
					"errors":  []map[string]string{{"resource": "Repository", "code": "custom", "field": "name", "message": "name already exists on this account"}},
				})
			}
		}))
		DeferCleanup(ghMock.Close)

		k8sMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch {
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/serviceaccounts"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/roles"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/rolebindings"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/token"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{"status": map[string]string{"token": "sa-token"}})
			}
		}))
		DeferCleanup(k8sMock.Close)

		withSCMMock(ghMock.URL, func() {
			h := &Handlers{kubeHost: k8sMock.URL, externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(validBody()))
			req.Header.Set("X-SCM-Token", "test-pat")
			req.Header.Set("Authorization", "Bearer ocp-token")
			w := httptest.NewRecorder()
			h.HandleFuncCreate(w, req)

			Expect(w.Code).To(Equal(http.StatusConflict))
		})
	})

	It("returns 502 when cluster provisioning fails", func() {
		k8sMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]any{"reason": "Forbidden", "message": "forbidden"})
		}))
		DeferCleanup(k8sMock.Close)

		withSCMMock("http://unused", func() {
			h := &Handlers{kubeHost: k8sMock.URL, externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(validBody()))
			req.Header.Set("X-SCM-Token", "test-pat")
			req.Header.Set("Authorization", "Bearer ocp-token")
			w := httptest.NewRecorder()
			h.HandleFuncCreate(w, req)

			Expect(w.Code).To(Equal(http.StatusBadGateway))
		})
	})

	It("returns 400 for a malformed request body", func() {
		h := &Handlers{}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBufferString("not json"))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.Header.Set("Authorization", "Bearer ocp-token")
		w := httptest.NewRecorder()
		h.HandleFuncCreate(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("returns 401 when the SCM token is rejected mid-flow", func() {
		ghMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && r.URL.Path == "/user/repos" {
				w.WriteHeader(http.StatusUnauthorized)
				json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
			}
		}))
		DeferCleanup(ghMock.Close)

		k8sMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch {
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/serviceaccounts"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/roles"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/rolebindings"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/token"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{"status": map[string]string{"token": "sa-token"}})
			}
		}))
		DeferCleanup(k8sMock.Close)

		withSCMMock(ghMock.URL, func() {
			h := &Handlers{kubeHost: k8sMock.URL, externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(validBody()))
			req.Header.Set("X-SCM-Token", "test-pat")
			req.Header.Set("Authorization", "Bearer ocp-token")
			w := httptest.NewRecorder()
			h.HandleFuncCreate(w, req)

			Expect(w.Code).To(Equal(http.StatusUnauthorized))
		})
	})

	It("rejects requests without an X-SCM-Token", func() {
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
		req.Header.Set("X-SCM-Token", "pat")
		w := httptest.NewRecorder()
		h.HandleFuncCreate(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	DescribeTable("rejects invalid function configurations",
		func(req createRequest) {
			h := &Handlers{}
			body, _ := json.Marshal(req)
			r := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(body))
			r.Header.Set("X-SCM-Token", "pat")
			r.Header.Set("Authorization", "Bearer ocp-token")
			w := httptest.NewRecorder()
			h.HandleFuncCreate(w, r)
			Expect(w.Code).To(Equal(http.StatusBadRequest))
		},
		Entry("invalid function name", createRequest{Name: "INVALID", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("unsupported runtime", createRequest{Name: "fn", Runtime: "ruby", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("invalid branch name", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "bad branch!", Owner: "a", Repo: "r"}),
		Entry("refs/ branch prefix", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "refs/heads/main", Owner: "a", Repo: "r"}),
		Entry("invalid namespace", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "UPPER", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("missing registry", createRequest{Name: "fn", Runtime: "go", Registry: "", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("internal registry namespace mismatch", createRequest{Name: "fn", Runtime: "go", Registry: "image-registry.openshift-image-registry.svc:5000/default", Namespace: "test", Branch: "main", Owner: "a", Repo: "r"}),
		Entry("missing owner", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "", Repo: "r"}),
		Entry("missing repo", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: ""}),
	)
})
