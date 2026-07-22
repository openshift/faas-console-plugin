package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("GET /api/v1/func/{owner}/{name}/files", func() {
	It("returns all files from the repository", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.Path, "/git/trees/") {
				json.NewEncoder(w).Encode(map[string]any{
					"tree": []map[string]any{
						{"path": "func.go", "mode": "100644", "type": "blob", "sha": "sha1"},
					},
				})
			} else {
				json.NewEncoder(w).Encode(map[string]string{
					"content":  "cGFja2FnZSBtYWlu",
					"encoding": "base64",
				})
			}
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files", nil)
			req.Header.Set("X-SCM-Token", "test-pat")
			req.SetPathValue("owner", "alice")
			req.SetPathValue("name", "my-func")
			w := httptest.NewRecorder()
			(&Handlers{}).HandleGetFiles(w, req)

			Expect(w.Code).To(Equal(http.StatusOK))
			var files []scm.FileEntry
			Expect(json.NewDecoder(w.Body).Decode(&files)).To(Succeed())
			Expect(files).To(HaveLen(1))
			Expect(files[0].Path).To(Equal("func.go"))
			Expect(files[0].Content).To(Equal("package main"))
		})
	})

	It("rejects requests without an X-SCM-Token", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files", nil)
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("rejects requests with an invalid owner or repo name", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/../evil/files", nil)
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "../evil")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("forwards the ?ref query parameter to GitHub", func() {
		var capturedRef string
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.Path, "/git/trees/") {
				capturedRef = r.URL.Path
				json.NewEncoder(w).Encode(map[string]any{"tree": []map[string]any{}})
			}
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files?ref=develop", nil)
			req.Header.Set("X-SCM-Token", "test-pat")
			req.SetPathValue("owner", "alice")
			req.SetPathValue("name", "my-func")
			w := httptest.NewRecorder()
			(&Handlers{}).HandleGetFiles(w, req)

			Expect(w.Code).To(Equal(http.StatusOK))
			Expect(capturedRef).To(ContainSubstring("develop"))
		})
	})

	It("returns 401 when the GitHub token is invalid", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files", nil)
			req.Header.Set("X-SCM-Token", "bad-token")
			req.SetPathValue("owner", "alice")
			req.SetPathValue("name", "my-func")
			w := httptest.NewRecorder()
			(&Handlers{}).HandleGetFiles(w, req)

			Expect(w.Code).To(Equal(http.StatusUnauthorized))
		})
	})

	It("returns 502 when the GitHub API is unavailable", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"message": "Internal Server Error"})
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files", nil)
			req.Header.Set("X-SCM-Token", "test-pat")
			req.SetPathValue("owner", "alice")
			req.SetPathValue("name", "my-func")
			w := httptest.NewRecorder()
			(&Handlers{}).HandleGetFiles(w, req)

			Expect(w.Code).To(Equal(http.StatusBadGateway))
		})
	})
})

var _ = Describe("PUT /api/v1/func/{owner}/{name}/files", func() {
	It("commits the changes to the branch", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.Contains(r.URL.Path, "/git/ref/"):
				json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "headsha"}})
			case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/git/commits/"):
				json.NewEncoder(w).Encode(map[string]any{"sha": "headsha", "tree": map[string]string{"sha": "treesha"}})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/blobs"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "blobsha"})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/trees"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "newtreesha"})
			case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/commits"):
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]string{"sha": "newcommitsha"})
			case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/git/refs/"):
				json.NewEncoder(w).Encode(map[string]string{})
			}
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			body, _ := json.Marshal(putFilesRequest{
				Files:   []scm.FileEntry{{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"}},
				Message: "Update function files",
				Branch:  "main",
			})
			req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(body))
			req.Header.Set("X-SCM-Token", "test-pat")
			req.SetPathValue("owner", "alice")
			req.SetPathValue("name", "my-func")
			w := httptest.NewRecorder()
			(&Handlers{}).HandlePutFiles(w, req)

			Expect(w.Code).To(Equal(http.StatusNoContent))
		})
	})

	It("rejects requests without an X-SCM-Token", func() {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", nil)
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("rejects requests with an invalid owner or repo name", func() {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
			Message: "update",
			Branch:  "main",
		})
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/../evil/my-func/files", bytes.NewBuffer(body))
		req.Header.Set("X-SCM-Token", "token")
		req.SetPathValue("owner", "../evil")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with an empty file list", func() {
		body, _ := json.Marshal(putFilesRequest{Files: []scm.FileEntry{}, Message: "update", Branch: "main"})
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(body))
		req.Header.Set("X-SCM-Token", "token")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests without a commit message", func() {
		body, _ := json.Marshal(putFilesRequest{Files: []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}}, Branch: "main"})
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(body))
		req.Header.Set("X-SCM-Token", "token")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("returns 401 when the GitHub token is invalid", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			body, _ := json.Marshal(putFilesRequest{
				Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
				Message: "update",
				Branch:  "main",
			})
			req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(body))
			req.Header.Set("X-SCM-Token", "bad-token")
			req.SetPathValue("owner", "alice")
			req.SetPathValue("name", "my-func")
			w := httptest.NewRecorder()
			(&Handlers{}).HandlePutFiles(w, req)

			Expect(w.Code).To(Equal(http.StatusUnauthorized))
		})
	})

	It("returns 502 when the GitHub API is unavailable", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"message": "Internal Server Error"})
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			body, _ := json.Marshal(putFilesRequest{
				Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
				Message: "update",
				Branch:  "main",
			})
			req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(body))
			req.Header.Set("X-SCM-Token", "test-pat")
			req.SetPathValue("owner", "alice")
			req.SetPathValue("name", "my-func")
			w := httptest.NewRecorder()
			(&Handlers{}).HandlePutFiles(w, req)

			Expect(w.Code).To(Equal(http.StatusBadGateway))
		})
	})
})
