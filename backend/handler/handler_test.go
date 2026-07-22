package handler

import (
	"net/http"
	"net/http/httptest"
	"sync"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

var scmRegistryMu sync.Mutex

func withSCMMock(mockURL string, fn func()) {
	scmRegistryMu.Lock()
	orig := config.SCMRegistry
	config.SCMRegistry = scm.Registry{
		scm.GitHub: func(token string) scm.Client { return github.NewWithBaseURL(token, mockURL) },
	}
	scmRegistryMu.Unlock()
	DeferCleanup(func() {
		scmRegistryMu.Lock()
		config.SCMRegistry = orig
		scmRegistryMu.Unlock()
	})
	fn()
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
