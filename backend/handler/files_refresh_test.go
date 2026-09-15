package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/scm"
	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var _ = Describe("PUT files deployment credential refresh", func() {
	validBody := func() []byte {
		body, _ := json.Marshal(putFilesRequest{
			Files:   []scm.FileEntry{{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"}},
			Message: "Update function files",
			Branch:  "main",
		})
		return body
	}
	newRequest := func() *http.Request {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/func/alice/my-func/files", bytes.NewBuffer(validBody()))
		req.Header.Set("Authorization", "Bearer ocp-token")
		req.Header.Set("X-SCM-Token", "test-pat")
		req.SetPathValue("owner", "alice")
		req.SetPathValue("name", "my-func")
		return req
	}
	newHandlers := func() *Handlers {
		return &Handlers{externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
	}

	It("refreshes the deploy kubeconfig before committing the changes", func() {
		var calls []string
		var gotKubeconfig string
		var gotTokenExpiry int64
		expiration := time.Now().Add(12 * time.Hour).UTC().Format(time.RFC3339)
		newExpiration := metav1.NewTime(time.Now().Add(7 * 24 * time.Hour))
		withClusterStub(&cluster.ClientStub{
			OnRequestToken: func(ctx context.Context, namespace string, saTokenExpiry int64) (*authenticationv1.TokenRequestStatus, error) {
				calls = append(calls, "requestToken")
				Expect(namespace).To(Equal("demo"))
				gotTokenExpiry = saTokenExpiry
				return &authenticationv1.TokenRequestStatus{Token: "fresh-sa-token", ExpirationTimestamp: newExpiration}, nil
			},
		})
		withSCMStub(&scm.ClientStub{
			OnGetVariable: func(ctx context.Context, owner, repo, name string) (string, error) {
				calls = append(calls, "getExpiration")
				Expect(name).To(Equal(repoKubeconfigExpireAt))
				return expiration, nil
			},
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				calls = append(calls, "getFuncYaml")
				Expect(ref).To(Equal("main"))
				Expect(path).To(Equal("func.yaml"))
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
			OnStoreSecret: func(ctx context.Context, owner, repo, name, value string) error {
				calls = append(calls, "storeSecret")
				Expect(owner).To(Equal("alice"))
				Expect(repo).To(Equal("my-func"))
				Expect(name).To(Equal("KUBECONFIG"))
				gotKubeconfig = value
				return nil
			},
			OnStoreVariable: func(ctx context.Context, owner, repo, name, value string) error {
				calls = append(calls, "storeExpiration")
				Expect(name).To(Equal(repoKubeconfigExpireAt))
				Expect(value).To(Equal(newExpiration.Time.UTC().Format(time.RFC3339)))
				return nil
			},
			OnPushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				calls = append(calls, "pushFiles")
				return nil
			},
		})

		w := httptest.NewRecorder()
		h := newHandlers()
		h.saTokenExpiry = 7 * 24 * 60 * 60
		h.HandlePutFiles(w, newRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(calls).To(Equal([]string{"getExpiration", "getFuncYaml", "requestToken", "storeSecret", "storeExpiration", "pushFiles"}))
		Expect(gotTokenExpiry).To(Equal(int64(7 * 24 * 60 * 60)))
		Expect(gotKubeconfig).To(ContainSubstring("fresh-sa-token"))
	})

	It("commits changes without refreshing credentials when they expire in more than 24 hours", func() {
		var tokenRequested, filesPushed bool
		withClusterStub(&cluster.ClientStub{
			OnRequestToken: func(ctx context.Context, namespace string, saTokenExpiry int64) (*authenticationv1.TokenRequestStatus, error) {
				tokenRequested = true
				return nil, errors.New("token refresh was not expected")
			},
		})
		withSCMStub(&scm.ClientStub{
			OnGetVariable: func(ctx context.Context, owner, repo, name string) (string, error) {
				return time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339), nil
			},
			OnPushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				filesPushed = true
				return nil
			},
		})
		w := httptest.NewRecorder()
		req := newRequest()
		req.Header.Del("Authorization")

		newHandlers().HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(tokenRequested).To(BeFalse())
		Expect(filesPushed).To(BeTrue())
	})

	It("rejects requests without an OCP token", func() {
		req := newRequest()
		req.Header.Del("Authorization")
		w := httptest.NewRecorder()

		newHandlers().HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("does not update the secret or commit files when token refresh fails", func() {
		var secretUpdated, filesPushed bool
		withClusterStub(&cluster.ClientStub{
			OnRequestToken: func(ctx context.Context, namespace string, saTokenExpiry int64) (*authenticationv1.TokenRequestStatus, error) {
				return nil, errors.New("token endpoint unavailable")
			},
		})
		withSCMStub(&scm.ClientStub{
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
			OnStoreSecret: func(ctx context.Context, owner, repo, name, value string) error {
				secretUpdated = true
				return nil
			},
			OnPushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				filesPushed = true
				return nil
			},
		})
		w := httptest.NewRecorder()

		newHandlers().HandlePutFiles(w, newRequest())

		Expect(w.Code).To(Equal(http.StatusBadGateway))
		Expect(secretUpdated).To(BeFalse())
		Expect(filesPushed).To(BeFalse())
	})

	It("does not commit files when updating the deployment secret fails", func() {
		var filesPushed bool
		withClusterStub(&cluster.ClientStub{})
		withSCMStub(&scm.ClientStub{
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: demo\nruntime: go\n", nil
			},
			OnStoreSecret: func(ctx context.Context, owner, repo, name, value string) error {
				return errors.New("github unavailable")
			},
			OnPushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				filesPushed = true
				return nil
			},
		})
		w := httptest.NewRecorder()

		newHandlers().HandlePutFiles(w, newRequest())

		Expect(w.Code).To(Equal(http.StatusBadGateway))
		Expect(filesPushed).To(BeFalse())
	})

	It("rejects an invalid namespace read from func.yaml", func() {
		withSCMStub(&scm.ClientStub{
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				return "name: my-func\nnamespace: ../other\nruntime: go\n", nil
			},
		})
		w := httptest.NewRecorder()

		newHandlers().HandlePutFiles(w, newRequest())

		Expect(w.Code).To(Equal(http.StatusUnprocessableEntity))
	})
})

var _ = Describe("tokenNeedsRefresh", func() {
	now := time.Date(2026, time.January, 15, 12, 0, 0, 0, time.UTC)

	It("refreshes at the 24-hour boundary", func() {
		expiration := now.Add(config.TokenRefreshWindow).Format(time.RFC3339)

		Expect(tokenNeedsRefresh(expiration, now)).To(BeTrue())
	})

	It("does not refresh when expiration is beyond the 24-hour window", func() {
		expiration := now.Add(config.TokenRefreshWindow + time.Second).Format(time.RFC3339)

		Expect(tokenNeedsRefresh(expiration, now)).To(BeFalse())
	})

	DescribeTable("refreshes when expiration cannot be trusted",
		func(expiration string) {
			Expect(tokenNeedsRefresh(expiration, now)).To(BeTrue())
		},
		Entry("missing", ""),
		Entry("malformed", "not-a-timestamp"),
	)
})
