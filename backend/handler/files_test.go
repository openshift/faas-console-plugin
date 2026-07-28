package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("GET /api/v1/func/{owner}/{name}/files", func() {
	It("returns all files from the repository using HEAD as the default ref", func() {
		var gotOwner, gotRepo, gotRef string
		withSCMStub(&scmStub{
			getFiles: func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				gotOwner, gotRepo, gotRef = owner, repo, ref
				return []scm.FileEntry{
					{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"},
				}, nil
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files", nil)
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

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
		withSCMStub(&scmStub{
			getFiles: func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				gotRef = ref
				return []scm.FileEntry{
					{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"},
				}, nil
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files?ref=develop", nil)
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(gotRef).To(Equal("develop"))
	})

	It("rejects requests without an X-SCM-Token", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files", nil)
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("rejects requests with an invalid owner", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/../evil/files", nil)
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "../evil")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with an invalid repo name", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/../evil/files", nil)
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "../evil")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with an invalid ref parameter", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files?ref=HEAD%3Fevil%3D1", nil)
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("returns 401 when the SCM token is invalid", func() {
		withSCMStub(&scmStub{
			getFiles: func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				return nil, scm.ErrUnauthorized
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files", nil)
		req.Header.Set("X-SCM-Token", "bad-token")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 502 when the SCM API is unavailable", func() {
		withSCMStub(&scmStub{
			getFiles: func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
				return nil, errors.New("connection refused")
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/alice/my-func/files", nil)
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetFiles(w, req)

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

	It("commits the changes to the branch", func() {
		var gotOwner, gotRepo, gotBranch, gotMessage string
		var gotFiles []scm.FileEntry
		withSCMStub(&scmStub{
			pushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				gotOwner, gotRepo, gotBranch, gotMessage = owner, repo, branch, message
				gotFiles = files
				return nil
			},
		})

		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(validPutBody()))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(gotOwner).To(Equal("alice"))
		Expect(gotRepo).To(Equal("my-func"))
		Expect(gotBranch).To(Equal("main"))
		Expect(gotMessage).To(Equal("Update function files"))
		Expect(gotFiles).To(HaveLen(1))
		Expect(gotFiles[0].Path).To(Equal("func.go"))
	})

	It("rejects requests without an X-SCM-Token", func() {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", nil)
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("rejects requests with an invalid owner", func() {
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

	It("rejects requests with an invalid repo name", func() {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
			Message: "update",
			Branch:  "main",
		})
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/../evil/files", bytes.NewBuffer(body))
		req.Header.Set("X-SCM-Token", "token")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "../evil")
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

	It("rejects requests with an empty branch", func() {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
			Message: "update",
			Branch:  "",
		})
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(body))
		req.Header.Set("X-SCM-Token", "token")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects a malformed request body", func() {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBufferString("not json"))
		req.Header.Set("X-SCM-Token", "token")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects requests with a refs/ prefix in the branch name", func() {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "f.go", Mode: "100644", Content: "x", Type: "blob"}},
			Message: "update",
			Branch:  "refs/heads/main",
		})
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

	It("returns 401 when the SCM token is invalid", func() {
		withSCMStub(&scmStub{
			pushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				return scm.ErrUnauthorized
			},
		})

		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(validPutBody()))
		req.Header.Set("X-SCM-Token", "bad-token")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 502 when the SCM API is unavailable", func() {
		withSCMStub(&scmStub{
			pushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				return errors.New("connection refused")
			},
		})

		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(validPutBody()))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})
