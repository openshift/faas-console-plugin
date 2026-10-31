package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

func filesRequest(method, owner, name, query string, body io.Reader) *http.Request {
	req := httptest.NewRequestWithContext(testCredentialContext(), method, "/api/v1/func/"+owner+"/"+name+"/files"+query, body)
	req.SetPathValue("owner", owner)
	req.SetPathValue("name", name)
	return req
}

var _ = Describe("GET /api/v1/func/{owner}/{name}/files", func() {
	It("returns all files from the repository using HEAD as the default ref", func() {
		var gotOwner, gotRepo, gotRef string
		withSCMStub(&scm.ClientStub{
			OnGetFiles: func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				gotOwner, gotRepo, gotRef = owner, repo, ref
				return []scm.FileEntry{
					{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"},
				}, nil
			},
		})

		req := filesRequest(http.MethodGet, "alice", "my-func", "", nil)
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(gotOwner).To(Equal("alice"))
		Expect(gotRepo).To(Equal("my-func"))
		Expect(gotRef).To(Equal("HEAD"))
		var files []scm.FileEntry
		Expect(json.NewDecoder(w.Body).Decode(&files)).To(Succeed())
		Expect(files).To(HaveLen(1))
		Expect(files[0].Path).To(Equal("func.go"))
		Expect(files[0].Content).To(Equal("package main"))
	})

	It("forwards the ?ref query parameter to the SCM client", func() {
		var gotRef string
		withSCMStub(&scm.ClientStub{
			OnGetFiles: func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				gotRef = ref
				return []scm.FileEntry{
					{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"},
				}, nil
			},
		})

		req := filesRequest(http.MethodGet, "alice", "my-func", "?ref=develop", nil)
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(gotRef).To(Equal("develop"))
	})

	It("rejects requests with an invalid owner", func() {
		req := filesRequest(http.MethodGet, "../evil", "my-func", "", nil)
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with an invalid repo name", func() {
		req := filesRequest(http.MethodGet, "alice", "../evil", "", nil)
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with an invalid ref parameter", func() {
		req := filesRequest(http.MethodGet, "alice", "my-func", "?ref=HEAD%3Fevil%3D1", nil)
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("returns 403 when the SCM token is invalid", func() {
		withSCMStub(&scm.ClientStub{
			OnGetFiles: func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				return nil, scm.ErrUnauthorized
			},
		})

		req := filesRequest(http.MethodGet, "alice", "my-func", "", nil)
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusForbidden))
	})

	It("returns 502 when the SCM API is unavailable", func() {
		withSCMStub(&scm.ClientStub{
			OnGetFiles: func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				return nil, errors.New("connection refused")
			},
		})

		req := filesRequest(http.MethodGet, "alice", "my-func", "", nil)
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})

var _ = Describe("PUT /api/v1/func/{owner}/{name}/files", func() {
	validPutBody := func() []byte {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"}},
			Message: "Update function files",
			Branch:  "main",
		})
		return body
	}
	withValidPutSCMStub := func(stub *scm.ClientStub) {
		if stub.OnGetFileContent == nil {
			stub.OnGetFileContent = func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			}
		}
		withSCMStub(stub)
	}

	It("commits the changes to the branch", func() {
		var gotOwner, gotRepo, gotBranch, gotMessage string
		var gotFiles []scm.FileEntry
		withClusterStub(&cluster.ClientStub{})
		withValidPutSCMStub(&scm.ClientStub{
			OnPushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				gotOwner, gotRepo, gotBranch, gotMessage = owner, repo, branch, message
				gotFiles = files
				return nil
			},
		})

		req := filesRequest(http.MethodPut, "alice", "my-func", "", bytes.NewBuffer(validPutBody()))
		w := httptest.NewRecorder()
		h := &Handlers{externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(gotOwner).To(Equal("alice"))
		Expect(gotRepo).To(Equal("my-func"))
		Expect(gotBranch).To(Equal("main"))
		Expect(gotMessage).To(Equal("Update function files"))
		Expect(gotFiles).To(HaveLen(1))
		Expect(gotFiles[0].Path).To(Equal("func.go"))
	})

	It("rejects requests with an invalid owner", func() {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
			Message: "update",
			Branch:  "main",
		})
		req := filesRequest(http.MethodPut, "../evil", "my-func", "", bytes.NewBuffer(body))
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with an invalid repo name", func() {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
			Message: "update",
			Branch:  "main",
		})
		req := filesRequest(http.MethodPut, "alice", "../evil", "", bytes.NewBuffer(body))
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with an empty file list", func() {
		body, _ := json.Marshal(putFilesRequest{Files: []scm.FileEntry{}, Message: "update", Branch: "main"})
		req := filesRequest(http.MethodPut, "alice", "my-func", "", bytes.NewBuffer(body))
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with an empty branch", func() {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
			Message: "update",
			Branch:  "",
		})
		req := filesRequest(http.MethodPut, "alice", "my-func", "", bytes.NewBuffer(body))
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects a malformed request body", func() {
		req := filesRequest(http.MethodPut, "alice", "my-func", "", bytes.NewBufferString("not json"))
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with a refs/ prefix in the branch name", func() {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
			Message: "update",
			Branch:  "refs/heads/main",
		})
		req := filesRequest(http.MethodPut, "alice", "my-func", "", bytes.NewBuffer(body))
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests without a commit message", func() {
		body, _ := json.Marshal(putFilesRequest{Files: []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}}, Branch: "main"})
		req := filesRequest(http.MethodPut, "alice", "my-func", "", bytes.NewBuffer(body))
		w := httptest.NewRecorder()
		h := &Handlers{}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("returns 403 when the SCM token is invalid", func() {
		withClusterStub(&cluster.ClientStub{})
		withValidPutSCMStub(&scm.ClientStub{
			OnPushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				return scm.ErrUnauthorized
			},
		})

		req := filesRequest(http.MethodPut, "alice", "my-func", "", bytes.NewBuffer(validPutBody()))
		w := httptest.NewRecorder()
		h := &Handlers{externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusForbidden))
	})

	It("returns 502 when the SCM API is unavailable", func() {
		withClusterStub(&cluster.ClientStub{})
		withValidPutSCMStub(&scm.ClientStub{
			OnPushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				return errors.New("connection refused")
			},
		})

		req := filesRequest(http.MethodPut, "alice", "my-func", "", bytes.NewBuffer(validPutBody()))
		w := httptest.NewRecorder()
		h := &Handlers{externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
		h.HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})
