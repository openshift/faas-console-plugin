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

var _ = Describe("POST /api/v1/func/{owner}/{name}/deploy", func() {
	validBody := func() []byte {
		body, _ := json.Marshal(deployRequest{Branch: "main"})
		return body
	}

	It("dispatches the workflow and returns 202", func() {
		var gotOwner, gotRepo, gotFile, gotRef string
		withSCMStub(&scm.ClientStub{
			OnDispatchWorkflow: func(ctx context.Context, owner, repo, workflowFileName, ref string) error {
				gotOwner, gotRepo, gotFile, gotRef = owner, repo, workflowFileName, ref
				return nil
			},
		})

		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/alice/my-func/deploy", bytes.NewBuffer(validBody()))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleFuncDeploy(w, req)

		Expect(w.Code).To(Equal(http.StatusAccepted))
		Expect(gotOwner).To(Equal("alice"))
		Expect(gotRepo).To(Equal("my-func"))
		Expect(gotFile).To(Equal("func-deploy.yaml"))
		Expect(gotRef).To(Equal("main"))
	})

	It("rejects requests without an X-SCM-Token", func() {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/alice/my-func/deploy", bytes.NewBuffer(validBody()))
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleFuncDeploy(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("rejects an invalid owner", func() {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/../evil/my-func/deploy", bytes.NewBuffer(validBody()))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "../evil")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleFuncDeploy(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects an empty branch", func() {
		body, _ := json.Marshal(deployRequest{Branch: ""})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/alice/my-func/deploy", bytes.NewBuffer(body))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleFuncDeploy(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects a branch with a refs/ prefix", func() {
		body, _ := json.Marshal(deployRequest{Branch: "refs/heads/main"})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/alice/my-func/deploy", bytes.NewBuffer(body))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleFuncDeploy(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("returns 401 when the SCM token is invalid", func() {
		withSCMStub(&scm.ClientStub{
			OnDispatchWorkflow: func(ctx context.Context, owner, repo, workflowFileName, ref string) error {
				return scm.ErrUnauthorized
			},
		})

		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/alice/my-func/deploy", bytes.NewBuffer(validBody()))
		req.Header.Set("X-SCM-Token", "bad-token")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleFuncDeploy(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 502 when the SCM API is unavailable", func() {
		withSCMStub(&scm.ClientStub{
			OnDispatchWorkflow: func(ctx context.Context, owner, repo, workflowFileName, ref string) error {
				return errors.New("connection refused")
			},
		})

		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/alice/my-func/deploy", bytes.NewBuffer(validBody()))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleFuncDeploy(w, req)

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})
