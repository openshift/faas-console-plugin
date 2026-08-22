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

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/scm"
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

	doCreate := func(setup func()) *httptest.ResponseRecorder {
		setup()
		h := &Handlers{externalAPIServerURL: "https://api.test-cluster.example.com:6443"}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBuffer(validBody()))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.Header.Set("Authorization", "Bearer ocp-token")
		w := httptest.NewRecorder()
		h.HandleFuncCreate(w, req)
		return w
	}

	It("creates the function successfully", func() {
		var gotTopics []string
		var gotSecretName string
		var gotPushOwner, gotPushRepo, gotPushBranch, gotPushMessage string
		var gotPushFiles []scm.FileEntry
		w := doCreate(func() {
			withSCMStub(&scmStub{
				initRepo: func(ctx context.Context, owner, name, branch string, topics []string) error {
					gotTopics = topics
					return nil
				},
				storeSecret: func(ctx context.Context, owner, repo, name, value string) error {
					gotSecretName = name
					return nil
				},
				pushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
					gotPushOwner, gotPushRepo, gotPushBranch, gotPushMessage = owner, repo, branch, message
					gotPushFiles = files
					return nil
				},
			})
			withClusterStub(&clusterStub{})
		})
		Expect(w.Code).To(Equal(http.StatusCreated))
		Expect(gotTopics).To(Equal([]string{"serverless-function"}))
		Expect(gotSecretName).To(Equal("KUBECONFIG"))
		Expect(gotPushOwner).To(Equal("alice"))
		Expect(gotPushRepo).To(Equal("my-func"))
		Expect(gotPushBranch).To(Equal("main"))
		Expect(gotPushMessage).To(Equal("Initialize Knative function project"))
		Expect(gotPushFiles).NotTo(BeEmpty())
	})

	DescribeTable("maps upstream errors to HTTP status codes",
		func(setup func(), expectedCode int) {
			w := doCreate(setup)
			Expect(w.Code).To(Equal(expectedCode))
		},
		Entry("scaffold generation fails", func() {
			orig := generateScaffold
			generateScaffold = func(cfg functions.ScaffoldConfig) ([]scm.FileEntry, error) {
				return nil, errors.New("disk full")
			}
			DeferCleanup(func() { generateScaffold = orig })
		}, http.StatusInternalServerError),

		Entry("cluster client connection fails", func() {
			orig := newClusterClient
			newClusterClient = func(host, token string, caCert []byte) (cluster.Client, error) {
				return nil, errors.New("connection refused")
			}
			DeferCleanup(func() { newClusterClient = orig })
		}, http.StatusBadGateway),

		Entry("InitRepo returns ErrRepoExists", func() {
			withSCMStub(&scmStub{
				initRepo: func(ctx context.Context, owner, name, branch string, topics []string) error {
					return scm.ErrRepoExists
				},
			})
			withClusterStub(&clusterStub{})
		}, http.StatusConflict),

		Entry("InitRepo returns ErrUnauthorized", func() {
			withSCMStub(&scmStub{
				initRepo: func(ctx context.Context, owner, name, branch string, topics []string) error {
					return scm.ErrUnauthorized
				},
			})
			withClusterStub(&clusterStub{})
		}, http.StatusUnauthorized),

		Entry("InitRepo returns generic error", func() {
			withSCMStub(&scmStub{
				initRepo: func(ctx context.Context, owner, name, branch string, topics []string) error {
					return errors.New("connection refused")
				},
			})
			withClusterStub(&clusterStub{})
		}, http.StatusBadGateway),

		Entry("StoreSecret returns ErrUnauthorized", func() {
			withSCMStub(&scmStub{
				storeSecret: func(ctx context.Context, owner, repo, name, value string) error {
					return scm.ErrUnauthorized
				},
			})
			withClusterStub(&clusterStub{})
		}, http.StatusUnauthorized),

		Entry("StoreSecret returns generic error", func() {
			withSCMStub(&scmStub{
				storeSecret: func(ctx context.Context, owner, repo, name, value string) error {
					return errors.New("connection refused")
				},
			})
			withClusterStub(&clusterStub{})
		}, http.StatusBadGateway),

		Entry("PushFiles returns ErrUnauthorized", func() {
			withSCMStub(&scmStub{
				pushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
					return scm.ErrUnauthorized
				},
			})
			withClusterStub(&clusterStub{})
		}, http.StatusUnauthorized),

		Entry("PushFiles returns generic error", func() {
			withSCMStub(&scmStub{
				pushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
					return errors.New("connection refused")
				},
			})
			withClusterStub(&clusterStub{})
		}, http.StatusBadGateway),
	)

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

	It("returns 400 for a malformed request body", func() {
		h := &Handlers{}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/func/create", bytes.NewBufferString("not json"))
		req.Header.Set("X-SCM-Token", "test-pat")
		req.Header.Set("Authorization", "Bearer ocp-token")
		w := httptest.NewRecorder()
		h.HandleFuncCreate(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
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
		Entry("env var missing name", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r",
			EnvVars: []functions.EnvVar{{Name: "", Value: "v"}}}),
		Entry("env var invalid name", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r",
			EnvVars: []functions.EnvVar{{Name: "123BAD", Source: "value", Value: "v"}}}),
		Entry("secret env var missing resourceName", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r",
			EnvVars: []functions.EnvVar{{Name: "X", Source: "secret", ResourceKey: "k"}}}),
		Entry("secret env var missing resourceKey", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r",
			EnvVars: []functions.EnvVar{{Name: "X", Source: "secret", ResourceName: "s"}}}),
		Entry("configMap env var missing resourceName", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r",
			EnvVars: []functions.EnvVar{{Name: "X", Source: "configMap", ResourceKey: "k"}}}),
		Entry("invalid env var source", createRequest{Name: "fn", Runtime: "go", Registry: "r", Namespace: "ns", Branch: "main", Owner: "a", Repo: "r",
			EnvVars: []functions.EnvVar{{Name: "X", Source: "invalid"}}}),
	)

	Describe("rollback on failure", func() {
		It("rolls back cluster resources when GenerateKubeconfig fails", func() {
			calls := map[string]int{}
			recordCall := func(key string) { calls[key]++ }

			w := doCreate(func() {
				withSCMStub(&scmStub{
					deleteRepo: func(ctx context.Context, owner, repo string) error {
						recordCall("deleteRepo")
						return nil
					},
				})
				withClusterStub(&clusterStub{
					requestToken: func(ctx context.Context, namespace string) (string, error) {
						return "", errors.New("token endpoint unavailable")
					},
					deleteServiceAccount: func(ctx context.Context, namespace string) error {
						recordCall("deleteServiceAccount")
						return nil
					},
					deleteRole: func(ctx context.Context, namespace string) error {
						recordCall("deleteRole")
						return nil
					},
					deleteRoleBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteRoleBinding")
						return nil
					},
					deleteImageBuilderBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteImageBuilderBinding")
						return nil
					},
				})
			})
			Expect(w.Code).To(Equal(http.StatusBadGateway))
			Expect(calls).To(HaveKey("deleteServiceAccount"))
			Expect(calls).To(HaveKey("deleteRole"))
			Expect(calls).To(HaveKey("deleteRoleBinding"))
			Expect(calls).To(HaveKey("deleteImageBuilderBinding"))
			Expect(calls).NotTo(HaveKey("deleteRepo"))
		})

		It("rolls back cluster resources when InitRepo fails", func() {
			calls := map[string]int{}
			recordCall := func(key string) { calls[key]++ }

			w := doCreate(func() {
				withSCMStub(&scmStub{
					initRepo: func(ctx context.Context, owner, name, branch string, topics []string) error {
						return errors.New("github down")
					},
					deleteRepo: func(ctx context.Context, owner, repo string) error {
						recordCall("deleteRepo")
						return nil
					},
				})
				withClusterStub(&clusterStub{
					deleteServiceAccount: func(ctx context.Context, namespace string) error {
						recordCall("deleteServiceAccount")
						return nil
					},
					deleteRole: func(ctx context.Context, namespace string) error {
						recordCall("deleteRole")
						return nil
					},
					deleteRoleBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteRoleBinding")
						return nil
					},
					deleteImageBuilderBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteImageBuilderBinding")
						return nil
					},
				})
			})
			Expect(w.Code).To(Equal(http.StatusBadGateway))
			Expect(calls).To(HaveKey("deleteServiceAccount"))
			Expect(calls).To(HaveKey("deleteRole"))
			Expect(calls).To(HaveKey("deleteRoleBinding"))
			Expect(calls).To(HaveKey("deleteImageBuilderBinding"))
			Expect(calls).NotTo(HaveKey("deleteRepo"))
		})

		It("rolls back cluster resources and repo when StoreSecret fails", func() {
			calls := map[string]int{}
			recordCall := func(key string) { calls[key]++ }

			w := doCreate(func() {
				withSCMStub(&scmStub{
					storeSecret: func(ctx context.Context, owner, repo, name, value string) error {
						return errors.New("github down")
					},
					deleteRepo: func(ctx context.Context, owner, repo string) error {
						recordCall("deleteRepo")
						return nil
					},
				})
				withClusterStub(&clusterStub{
					deleteServiceAccount: func(ctx context.Context, namespace string) error {
						recordCall("deleteServiceAccount")
						return nil
					},
					deleteRole: func(ctx context.Context, namespace string) error {
						recordCall("deleteRole")
						return nil
					},
					deleteRoleBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteRoleBinding")
						return nil
					},
					deleteImageBuilderBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteImageBuilderBinding")
						return nil
					},
				})
			})
			Expect(w.Code).To(Equal(http.StatusBadGateway))
			Expect(calls).To(HaveKey("deleteServiceAccount"))
			Expect(calls).To(HaveKey("deleteRole"))
			Expect(calls).To(HaveKey("deleteRoleBinding"))
			Expect(calls).To(HaveKey("deleteImageBuilderBinding"))
			Expect(calls).To(HaveKey("deleteRepo"))
		})

		It("rolls back cluster resources and repo when PushFiles fails", func() {
			calls := map[string]int{}
			recordCall := func(key string) { calls[key]++ }

			w := doCreate(func() {
				withSCMStub(&scmStub{
					pushFiles: func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
						return errors.New("github down")
					},
					deleteRepo: func(ctx context.Context, owner, repo string) error {
						recordCall("deleteRepo")
						return nil
					},
				})
				withClusterStub(&clusterStub{
					deleteServiceAccount: func(ctx context.Context, namespace string) error {
						recordCall("deleteServiceAccount")
						return nil
					},
					deleteRole: func(ctx context.Context, namespace string) error {
						recordCall("deleteRole")
						return nil
					},
					deleteRoleBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteRoleBinding")
						return nil
					},
					deleteImageBuilderBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteImageBuilderBinding")
						return nil
					},
				})
			})
			Expect(w.Code).To(Equal(http.StatusBadGateway))
			Expect(calls).To(HaveKey("deleteServiceAccount"))
			Expect(calls).To(HaveKey("deleteRole"))
			Expect(calls).To(HaveKey("deleteRoleBinding"))
			Expect(calls).To(HaveKey("deleteImageBuilderBinding"))
			Expect(calls).To(HaveKey("deleteRepo"))
		})

		It("does not roll back when all steps succeed", func() {
			calls := map[string]int{}
			recordCall := func(key string) { calls[key]++ }

			w := doCreate(func() {
				withSCMStub(&scmStub{
					deleteRepo: func(ctx context.Context, owner, repo string) error {
						recordCall("deleteRepo")
						return nil
					},
				})
				withClusterStub(&clusterStub{
					deleteServiceAccount: func(ctx context.Context, namespace string) error {
						recordCall("deleteServiceAccount")
						return nil
					},
					deleteRole: func(ctx context.Context, namespace string) error {
						recordCall("deleteRole")
						return nil
					},
					deleteRoleBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteRoleBinding")
						return nil
					},
					deleteImageBuilderBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteImageBuilderBinding")
						return nil
					},
				})
			})
			Expect(w.Code).To(Equal(http.StatusCreated))
			Expect(calls).To(BeEmpty())
		})

		It("does not roll back pre-existing cluster resources", func() {
			calls := map[string]int{}
			recordCall := func(key string) { calls[key]++ }

			w := doCreate(func() {
				withSCMStub(&scmStub{
					initRepo: func(ctx context.Context, owner, name, branch string, topics []string) error {
						return errors.New("github down")
					},
					deleteRepo: func(ctx context.Context, owner, repo string) error {
						recordCall("deleteRepo")
						return nil
					},
				})
				withClusterStub(&clusterStub{
					createServiceAccount: func(ctx context.Context, namespace string) (bool, error) {
						return false, nil
					},
					applyRole: func(ctx context.Context, namespace string) (bool, error) {
						return false, nil
					},
					createRoleBinding: func(ctx context.Context, namespace string) (bool, error) {
						return false, nil
					},
					createImageBuilderBinding: func(ctx context.Context, namespace string) (bool, error) {
						return false, nil
					},
					deleteServiceAccount: func(ctx context.Context, namespace string) error {
						recordCall("deleteServiceAccount")
						return nil
					},
					deleteRole: func(ctx context.Context, namespace string) error {
						recordCall("deleteRole")
						return nil
					},
					deleteRoleBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteRoleBinding")
						return nil
					},
					deleteImageBuilderBinding: func(ctx context.Context, namespace string) error {
						recordCall("deleteImageBuilderBinding")
						return nil
					},
				})
			})
			Expect(w.Code).To(Equal(http.StatusBadGateway))
			Expect(calls).NotTo(HaveKey("deleteServiceAccount"))
			Expect(calls).NotTo(HaveKey("deleteRole"))
			Expect(calls).NotTo(HaveKey("deleteRoleBinding"))
			Expect(calls).NotTo(HaveKey("deleteImageBuilderBinding"))
			Expect(calls).NotTo(HaveKey("deleteRepo"))
		})

		It("returns the original error when rollback also fails", func() {
			w := doCreate(func() {
				withSCMStub(&scmStub{
					initRepo: func(ctx context.Context, owner, name, branch string, topics []string) error {
						return errors.New("github down")
					},
				})
				withClusterStub(&clusterStub{
					deleteServiceAccount: func(ctx context.Context, namespace string) error {
						return errors.New("rollback failed")
					},
					deleteRole: func(ctx context.Context, namespace string) error {
						return errors.New("rollback failed")
					},
					deleteRoleBinding: func(ctx context.Context, namespace string) error {
						return errors.New("rollback failed")
					},
					deleteImageBuilderBinding: func(ctx context.Context, namespace string) error {
						return errors.New("rollback failed")
					},
				})
			})
			Expect(w.Code).To(Equal(http.StatusBadGateway))
		})
	})
})
