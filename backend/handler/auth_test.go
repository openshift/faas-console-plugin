package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("POST /api/v1/auth/login", func() {
	var h *Handlers

	BeforeEach(func() {
		h = &Handlers{}
	})

	It("validates the GitHub token and returns the user identity", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			Expect(r.Header.Get("Authorization")).To(Equal("Bearer valid-pat"))
			json.NewEncoder(w).Encode(map[string]string{"login": "alice", "avatar_url": "https://example.com/avatar"})
		}))
		DeferCleanup(mock.Close)
		h.githubBaseURL = mock.URL

		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"pat":"valid-pat"}`))
		w := httptest.NewRecorder()
		h.HandleAuthLogin(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		var resp scm.User
		Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
		Expect(resp.Login).To(Equal("alice"))
	})

	It("rejects requests with an invalid GitHub token", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
		}))
		DeferCleanup(mock.Close)
		h.githubBaseURL = mock.URL

		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"pat":"bad-token"}`))
		w := httptest.NewRecorder()
		h.HandleAuthLogin(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("rejects requests with a missing PAT", func() {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"pat":""}`))
		w := httptest.NewRecorder()
		h.HandleAuthLogin(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("rejects malformed request bodies", func() {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString("not-json"))
		w := httptest.NewRecorder()
		h.HandleAuthLogin(w, req)

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	It("returns 502 when the GitHub API is unavailable", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"message": "Internal Server Error"})
		}))
		DeferCleanup(mock.Close)
		h.githubBaseURL = mock.URL

		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"pat":"some-token"}`))
		w := httptest.NewRecorder()
		h.HandleAuthLogin(w, req)

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})

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
