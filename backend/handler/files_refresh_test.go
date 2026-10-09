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

var _ = Describe("PUT /api/v1/func/{owner}/{name}/files - credential refresh", func() {
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
		return &Handlers{
			externalAPIServerURL: "https://api.test-cluster.example.com:6443",
			saTokenExpiry:        config.DefaultSATokenExpiry,
		}
	}

	const funcYaml = "name: my-func\nnamespace: demo\nruntime: go\n"
	validFuncYaml := func(ctx context.Context, owner, repo, ref, path string) (string, error) {
		return funcYaml, nil
	}

	It("provisions RBAC and refreshes the deploy kubeconfig on every push", func() {
		var gotNamespace, gotRef, gotPath string
		var gotSecretName, gotKubeconfig string
		var gotPushBranch, gotPushMessage string
		var gotPushFiles []scm.FileEntry
		withClusterStub(&cluster.ClientStub{
			OnRequestToken: func(ctx context.Context, namespace string, saTokenExpiry int64) (*authenticationv1.TokenRequestStatus, error) {
				gotNamespace = namespace
				return &authenticationv1.TokenRequestStatus{Token: "fresh-sa-token", ExpirationTimestamp: metav1.NewTime(time.Now().Add(7 * 24 * time.Hour))}, nil
			},
		})
		withSCMStub(&scm.ClientStub{
			OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
				gotRef, gotPath = ref, path
				return funcYaml, nil
			},
			OnStoreSecret: func(ctx context.Context, owner, repo, name, value string) error {
				gotSecretName, gotKubeconfig = name, value
				return nil
			},
			OnPushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
				gotPushBranch, gotPushMessage = branch, message
				gotPushFiles = files
				return nil
			},
		})

		w := httptest.NewRecorder()
		newHandlers().HandlePutFiles(w, newRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(gotRef).To(Equal("main"))
		Expect(gotPath).To(Equal("func.yaml"))
		Expect(gotNamespace).To(Equal("demo"))
		Expect(gotSecretName).To(Equal(repoSecretKubeconfig))
		Expect(gotKubeconfig).To(ContainSubstring("fresh-sa-token"))
		// PushFiles runs last, so asserting its payload confirms the commit happened.
		Expect(gotPushBranch).To(Equal("main"))
		Expect(gotPushMessage).To(Equal("Update function files"))
		Expect(gotPushFiles).To(HaveLen(1))
		Expect(gotPushFiles[0].Path).To(Equal("func.go"))
	})

	It("uses the configured service account token expiry when refreshing", func() {
		var requestedExpiry int64
		withClusterStub(&cluster.ClientStub{
			OnRequestToken: func(ctx context.Context, namespace string, saTokenExpiry int64) (*authenticationv1.TokenRequestStatus, error) {
				requestedExpiry = saTokenExpiry
				return &authenticationv1.TokenRequestStatus{Token: "fresh-sa-token", ExpirationTimestamp: metav1.NewTime(time.Now().Add(7 * 24 * time.Hour))}, nil
			},
		})
		withSCMStub(&scm.ClientStub{OnGetFileContent: validFuncYaml})
		w := httptest.NewRecorder()

		newHandlers().HandlePutFiles(w, newRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(requestedExpiry).To(Equal(config.DefaultSATokenExpiry))
	})

	It("rejects requests without an OCP token", func() {
		withSCMStub(&scm.ClientStub{})
		req := newRequest()
		req.Header.Del("Authorization")
		w := httptest.NewRecorder()

		newHandlers().HandlePutFiles(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
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

	// Each entry fails one step of the refresh chain; 502 (not 204) proves the
	// flow stopped there, so the secret update and commit never ran.
	DescribeTable("returns 502 when a refresh step fails",
		func(setup func()) {
			setup()
			w := httptest.NewRecorder()

			newHandlers().HandlePutFiles(w, newRequest())

			Expect(w.Code).To(Equal(http.StatusBadGateway))
		},
		Entry("reading func.yaml fails", func() {
			withClusterStub(&cluster.ClientStub{})
			withSCMStub(&scm.ClientStub{
				OnGetFileContent: func(ctx context.Context, owner, repo, ref, path string) (string, error) {
					return "", errors.New("github unavailable")
				},
			})
		}),
		Entry("requesting a fresh token fails", func() {
			withClusterStub(&cluster.ClientStub{
				OnRequestToken: func(ctx context.Context, namespace string, saTokenExpiry int64) (*authenticationv1.TokenRequestStatus, error) {
					return nil, errors.New("token endpoint unavailable")
				},
			})
			withSCMStub(&scm.ClientStub{OnGetFileContent: validFuncYaml})
		}),
		Entry("updating the deployment secret fails", func() {
			withClusterStub(&cluster.ClientStub{})
			withSCMStub(&scm.ClientStub{
				OnGetFileContent: validFuncYaml,
				OnStoreSecret: func(ctx context.Context, owner, repo, name, value string) error {
					return errors.New("github unavailable")
				},
			})
		}),
	)
})
