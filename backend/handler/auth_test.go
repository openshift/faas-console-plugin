package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("GET /api/v1/auth/user", func() {
	It("returns the authenticated user", func() {
		withSCMStub(&scm.ClientStub{
			OnGetUser: func(ctx context.Context) (*scm.User, error) {
				return &scm.User{Login: "alice", AvatarURL: "https://example.com/avatar"}, nil
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/user", nil)
		req.Header.Set("X-SCM-Token", "valid-pat")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetUser(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		var resp scm.User
		Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
		Expect(resp.Login).To(Equal("alice"))
		Expect(resp.AvatarURL).To(Equal("https://example.com/avatar"))
	})

	It("returns 401 when the SCM token is invalid", func() {
		withSCMStub(&scm.ClientStub{
			OnGetUser: func(ctx context.Context) (*scm.User, error) {
				return nil, scm.ErrUnauthorized
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/user", nil)
		req.Header.Set("X-SCM-Token", "bad-token")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetUser(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("rejects requests without an X-SCM-Token header", func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/user", nil)
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetUser(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("returns 502 when the SCM API is unavailable", func() {
		withSCMStub(&scm.ClientStub{
			OnGetUser: func(ctx context.Context) (*scm.User, error) {
				return nil, errors.New("connection refused")
			},
		})

		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/user", nil)
		req.Header.Set("X-SCM-Token", "some-token")
		w := httptest.NewRecorder()
		(&Handlers{}).HandleGetUser(w, req)

		Expect(w.Code).To(Equal(http.StatusBadGateway))
	})
})
