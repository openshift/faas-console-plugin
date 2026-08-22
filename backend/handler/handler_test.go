package handler

import (
	"context"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	fn "knative.dev/func/pkg/functions"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

type scmStub struct {
	getUser        func(ctx context.Context) (*scm.User, error)
	listRepos      func(ctx context.Context) ([]scm.Repo, error)
	getFileContent func(ctx context.Context, owner, repo, ref, path string) (string, error)
	getFiles       func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error)
	pushFiles      func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error
	initRepo       func(ctx context.Context, owner, name, branch string, topics []string) error
	storeSecret    func(ctx context.Context, owner, repo, name, value string) error
	deleteRepo     func(ctx context.Context, owner, repo string) error
}

func (s *scmStub) GetUser(ctx context.Context) (*scm.User, error) {
	if s.getUser != nil {
		return s.getUser(ctx)
	}
	return &scm.User{}, nil
}

func (s *scmStub) ListRepos(ctx context.Context) ([]scm.Repo, error) {
	if s.listRepos != nil {
		return s.listRepos(ctx)
	}
	return nil, nil
}

func (s *scmStub) GetFileContent(ctx context.Context, owner, repo, ref, path string) (string, error) {
	if s.getFileContent != nil {
		return s.getFileContent(ctx, owner, repo, ref, path)
	}
	return "", nil
}

func (s *scmStub) GetFiles(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
	if s.getFiles != nil {
		return s.getFiles(ctx, owner, repo, ref)
	}
	return nil, nil
}

func (s *scmStub) PushFiles(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
	if s.pushFiles != nil {
		return s.pushFiles(ctx, owner, repo, branch, message, files)
	}
	return nil
}

func (s *scmStub) InitRepo(ctx context.Context, owner, name, branch string, topics []string) error {
	if s.initRepo != nil {
		return s.initRepo(ctx, owner, name, branch, topics)
	}
	return nil
}

func (s *scmStub) StoreSecret(ctx context.Context, owner, repo, name, value string) error {
	if s.storeSecret != nil {
		return s.storeSecret(ctx, owner, repo, name, value)
	}
	return nil
}

func (s *scmStub) DeleteRepo(ctx context.Context, owner, repo string) error {
	if s.deleteRepo != nil {
		return s.deleteRepo(ctx, owner, repo)
	}
	return nil
}

func withSCMStub(stub scm.Client) {
	orig := config.SCMRegistry
	config.SCMRegistry = scm.Registry{
		scm.GitHub: func(token string) scm.Client { return stub },
	}
	DeferCleanup(func() { config.SCMRegistry = orig })
}

type clusterStub struct {
	createServiceAccount      func(ctx context.Context, namespace string) (bool, error)
	applyRole                 func(ctx context.Context, namespace string) (bool, error)
	createRoleBinding         func(ctx context.Context, namespace string) (bool, error)
	createImageBuilderBinding func(ctx context.Context, namespace string) (bool, error)
	requestToken              func(ctx context.Context, namespace string) (string, error)
	deleteServiceAccount      func(ctx context.Context, namespace string) error
	deleteRole                func(ctx context.Context, namespace string) error
	deleteRoleBinding         func(ctx context.Context, namespace string) error
	deleteImageBuilderBinding func(ctx context.Context, namespace string) error
}

func (s *clusterStub) CreateServiceAccount(ctx context.Context, namespace string) (bool, error) {
	if s.createServiceAccount != nil {
		return s.createServiceAccount(ctx, namespace)
	}
	return true, nil
}

func (s *clusterStub) ApplyRole(ctx context.Context, namespace string) (bool, error) {
	if s.applyRole != nil {
		return s.applyRole(ctx, namespace)
	}
	return true, nil
}

func (s *clusterStub) CreateRoleBinding(ctx context.Context, namespace string) (bool, error) {
	if s.createRoleBinding != nil {
		return s.createRoleBinding(ctx, namespace)
	}
	return true, nil
}

func (s *clusterStub) CreateImageBuilderBinding(ctx context.Context, namespace string) (bool, error) {
	if s.createImageBuilderBinding != nil {
		return s.createImageBuilderBinding(ctx, namespace)
	}
	return true, nil
}

func (s *clusterStub) RequestToken(ctx context.Context, namespace string) (string, error) {
	if s.requestToken != nil {
		return s.requestToken(ctx, namespace)
	}
	return "stub-token", nil
}

func (s *clusterStub) DeleteServiceAccount(ctx context.Context, namespace string) error {
	if s.deleteServiceAccount != nil {
		return s.deleteServiceAccount(ctx, namespace)
	}
	return nil
}

func (s *clusterStub) DeleteRole(ctx context.Context, namespace string) error {
	if s.deleteRole != nil {
		return s.deleteRole(ctx, namespace)
	}
	return nil
}

func (s *clusterStub) DeleteRoleBinding(ctx context.Context, namespace string) error {
	if s.deleteRoleBinding != nil {
		return s.deleteRoleBinding(ctx, namespace)
	}
	return nil
}

func (s *clusterStub) DeleteImageBuilderBinding(ctx context.Context, namespace string) error {
	if s.deleteImageBuilderBinding != nil {
		return s.deleteImageBuilderBinding(ctx, namespace)
	}
	return nil
}

func withClusterStub(stub cluster.Client) {
	orig := newClusterClient
	newClusterClient = func(host, token string, caCert []byte) (cluster.Client, error) {
		return stub, nil
	}
	DeferCleanup(func() { newClusterClient = orig })
}

type functionsClientStub struct {
	list func(ctx context.Context, namespace string) ([]fn.ListItem, error)
}

func (s *functionsClientStub) List(ctx context.Context, namespace string) ([]fn.ListItem, error) {
	if s.list != nil {
		return s.list(ctx, namespace)
	}
	return nil, nil
}

func withFunctionsClient(stub functions.Client) {
	orig := newFunctionsClient
	newFunctionsClient = func(host, token string, caCert []byte) (functions.Client, error) {
		return stub, nil
	}
	DeferCleanup(func() { newFunctionsClient = orig })
}

func withFunctionsClientError(err error) {
	orig := newFunctionsClient
	newFunctionsClient = func(host, token string, caCert []byte) (functions.Client, error) {
		return nil, err
	}
	DeferCleanup(func() { newFunctionsClient = orig })
}

var _ = Describe("extractOCPToken", func() {
	It("extracts the token from a Bearer Authorization header", func() {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer my-token")
		tok, ok := extractOCPToken(req)
		Expect(ok).To(BeTrue())
		Expect(tok).To(Equal("my-token"))
	})

	It("rejects missing Authorization headers", func() {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		_, ok := extractOCPToken(req)
		Expect(ok).To(BeFalse())
	})

	It("rejects non-Bearer Authorization headers", func() {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
		_, ok := extractOCPToken(req)
		Expect(ok).To(BeFalse())
	})
})
