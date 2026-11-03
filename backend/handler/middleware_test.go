package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
)

var _ = Describe("RequireOCPToken", func() {
	DescribeTable("rejects missing or malformed bearer authentication",
		func(authorization string) {
			req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/func/list", nil)
			req.Header.Set("Authorization", authorization)
			w := httptest.NewRecorder()
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })

			RequireOCPToken(next).ServeHTTP(w, req)

			Expect(w.Code).To(Equal(http.StatusUnauthorized))
			Expect(w.Body.String()).To(MatchJSON(`{"message":"authentication required"}`))
		},
		Entry("missing header", ""),
		Entry("empty bearer token", "Bearer "),
		Entry("wrong authentication scheme", "Basic credentials"),
	)

	It("makes the caller token available to the next handler", func() {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/func/list", nil)
		authenticate(req)
		w := httptest.NewRecorder()
		next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{"ocpToken": ocpTokenFrom(r.Context())})
		})

		RequireOCPToken(next).ServeHTTP(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(w.Body.String()).To(MatchJSON(`{"ocpToken":"ocp-token"}`))
	})
})

var _ = Describe("RequireSCMCredential", func() {
	request := func() *http.Request {
		return httptest.NewRequestWithContext(testOCPTokenContext(), http.MethodGet, "/api/v1/func/list", nil)
	}

	It("makes the stored credential and caller token available to the next handler", func() {
		w := httptest.NewRecorder()
		next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			credential := credentialFrom(r.Context())
			writeJSON(w, http.StatusOK, map[string]string{"scmToken": credential.Token, "ocpToken": credential.ocpToken})
		})

		RequireSCMCredential(next, withCredentialProviderStub()).ServeHTTP(w, request())

		Expect(w.Code).To(Equal(http.StatusOK))
		Expect(w.Body.String()).To(MatchJSON(`{"scmToken":"test-pat","ocpToken":"ocp-token"}`))
	})

	DescribeTable("reports credential lookup failures before entering the next handler",
		func(cause error, code int) {
			w := httptest.NewRecorder()
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })

			RequireSCMCredential(next, withCredentialProviderError(cause)).ServeHTTP(w, request())

			Expect(w.Code).To(Equal(code))
		},
		Entry("rejected OpenShift token", identity.ErrUnauthenticated, http.StatusUnauthorized),
		Entry("missing credential", credentials.ErrNoCredential, http.StatusUnauthorized),
		Entry("unavailable store", errors.New("cluster unavailable"), http.StatusServiceUnavailable),
	)

	It("rejects callers who have no credential even when another caller is connected", func() {
		w := httptest.NewRecorder()
		next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })

		RequireSCMCredential(next, credentials.MapProvider{"other-token": {Token: "other-pat"}}).ServeHTTP(w, request())

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})
})

var _ = Describe("LoggingMiddleware", func() {
	It("turns a panic into a 500", func() {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/func/list", nil)
		w := httptest.NewRecorder()
		next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") })

		LoggingMiddleware(next).ServeHTTP(w, req)

		Expect(w.Code).To(Equal(http.StatusInternalServerError))
		Expect(w.Body.String()).To(MatchJSON(`{"message":"internal server error"}`))
	})
})
