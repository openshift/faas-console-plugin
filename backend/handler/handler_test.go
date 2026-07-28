package handler

import (
	"context"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/cluster"
	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

type scmStub struct {
	getUser     func(ctx context.Context) (*scm.User, error)
	getFiles    func(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error)
	pushFiles   func(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error
	initRepo    func(ctx context.Context, owner, name, branch string, topics []string) error
	storeSecret func(ctx context.Context, owner, repo, name, value string) error
}

func (s *scmStub) GetUser(ctx context.Context) (*scm.User, error) {
	if s.getUser != nil {
		return s.getUser(ctx)
	}
	return &scm.User{}, nil
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


func withSCMStub(stub scm.Client) {
	orig := config.SCMRegistry
	config.SCMRegistry = scm.Registry{
		scm.GitHub: func(token string) scm.Client { return stub },
	}
	DeferCleanup(func() { config.SCMRegistry = orig })
}

type clusterStub struct {
	createServiceAccount      func(ctx context.Context, namespace string) error
	applyRole                 func(ctx context.Context, namespace string) error
	createRoleBinding         func(ctx context.Context, namespace string) error
	createImageBuilderBinding func(ctx context.Context, namespace string) error
	requestToken              func(ctx context.Context, namespace string) (string, error)
}

func (s *clusterStub) CreateServiceAccount(ctx context.Context, namespace string) error {
	if s.createServiceAccount != nil {
		return s.createServiceAccount(ctx, namespace)
	}
	return nil
}

func (s *clusterStub) ApplyRole(ctx context.Context, namespace string) error {
	if s.applyRole != nil {
		return s.applyRole(ctx, namespace)
	}
	return nil
}

func (s *clusterStub) CreateRoleBinding(ctx context.Context, namespace string) error {
	if s.createRoleBinding != nil {
		return s.createRoleBinding(ctx, namespace)
	}
	return nil
}

func (s *clusterStub) CreateImageBuilderBinding(ctx context.Context, namespace string) error {
	if s.createImageBuilderBinding != nil {
		return s.createImageBuilderBinding(ctx, namespace)
	}
	return nil
}

func (s *clusterStub) RequestToken(ctx context.Context, namespace string) (string, error) {
	if s.requestToken != nil {
		return s.requestToken(ctx, namespace)
	}
	return "stub-token", nil
}

func withClusterStub(stub cluster.Client) {
	orig := newClusterClient
	newClusterClient = func(host, token string, caCert []byte) (cluster.Client, error) {
		return stub, nil
	}
	DeferCleanup(func() { newClusterClient = orig })
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
