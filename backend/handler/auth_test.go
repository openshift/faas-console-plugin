package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("GET /api/v1/auth/user", func() {
	It("validates the GitHub token and returns the user identity", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			Expect(r.Header.Get("Authorization")).To(Equal("Bearer valid-pat"))
			json.NewEncoder(w).Encode(map[string]string{"login": "alice", "avatar_url": "https://example.com/avatar"})
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/user", nil)
			req.Header.Set("X-SCM-Token", "valid-pat")
			w := httptest.NewRecorder()
			(&Handlers{}).HandleAuthLogin(w, req)

			Expect(w.Code).To(Equal(http.StatusOK))
			var resp scm.User
			Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
			Expect(resp.Login).To(Equal("alice"))
			Expect(resp.AvatarURL).To(Equal("https://example.com/avatar"))
		})
	})

	It("rejects requests with an invalid GitHub token", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/user", nil)
			req.Header.Set("X-SCM-Token", "bad-token")
			w := httptest.NewRecorder()
			(&Handlers{}).HandleAuthLogin(w, req)

			Expect(w.Code).To(Equal(http.StatusUnauthorized))
		})
	})

	It("rejects requests without an X-SCM-Token header", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/user", nil)
		w := httptest.NewRecorder()
		(&Handlers{}).HandleAuthLogin(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 502 when the GitHub API is unavailable", func() {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"message": "Internal Server Error"})
		}))
		DeferCleanup(mock.Close)
		withSCMMock(mock.URL, func() {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/user", nil)
			req.Header.Set("X-SCM-Token", "some-token")
			w := httptest.NewRecorder()
			(&Handlers{}).HandleAuthLogin(w, req)

			Expect(w.Code).To(Equal(http.StatusBadGateway))
		})
	})
})
