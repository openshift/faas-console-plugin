package handler

import (
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

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
