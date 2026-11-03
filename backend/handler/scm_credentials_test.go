package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
)

var _ = Describe("POST /api/v1/scm/github/credential", func() {
	BeforeEach(func() {
		withSCMStub(&scm.ClientStub{
			OnGetUser: func(ctx context.Context) (*scm.User, error) {
				return &scm.User{Login: "alice-gh", AvatarURL: "https://example.com/avatar"}, nil
			},
		})
	})

	It("returns the GitHub profile, never the token", func() {
		w := httptest.NewRecorder()

		h := &Handlers{scmCredentials: withCredentialProviderStub()}

		h.HandleSaveSCMCredential(w, saveTokenRequest("ghp_valid"))

		var resp map[string]string
		Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
		Expect(resp).To(HaveKeyWithValue("login", "alice-gh"))
		Expect(resp).To(HaveKeyWithValue("avatarUrl", "https://example.com/avatar"))
		Expect(resp).To(HaveLen(2)) // login, avatarUrl and nothing else
	})

	It("saves the credential with the token's expiry", func() {
		expiresAt := time.Date(2026, 11, 26, 9, 42, 22, 0, time.UTC)
		withSCMStub(&scm.ClientStub{
			OnGetUser: func(ctx context.Context) (*scm.User, error) {
				return &scm.User{Login: "alice-gh", TokenExpiresAt: expiresAt}, nil
			},
		})
		provider := withCredentialProviderStub()
		h := &Handlers{scmCredentials: provider}

		h.HandleSaveSCMCredential(httptest.NewRecorder(), saveTokenRequest("ghp_valid"))

		Expect(provider[testOCPToken].ExpiresAt).To(Equal(expiresAt))
	})

	It("returns 400 when no token was sent", func() {
		w := httptest.NewRecorder()

		h := &Handlers{scmCredentials: withCredentialProviderStub()}

		h.HandleSaveSCMCredential(w, saveTokenRequest(""))

		Expect(w.Code).To(Equal(http.StatusBadRequest))
	})

	// Not 401: the frontend reads that one status as "the connection is
	// gone" and disconnects, which would throw away a working session over a
	// mistyped PAT. The SCM provider refusing a token the user just supplied
	// is the same class of problem as it refusing a stored one.
	It("returns 403 when the SCM provider rejects the token", func() {
		withSCMStub(&scm.ClientStub{
			OnGetUser: func(ctx context.Context) (*scm.User, error) { return nil, scm.ErrUnauthorized },
		})
		w := httptest.NewRecorder()

		h := &Handlers{scmCredentials: withCredentialProviderStub()}
		h.HandleSaveSCMCredential(w, saveTokenRequest("ghp_bad"))

		Expect(w.Code).To(Equal(http.StatusForbidden))
	})

	It("returns 401 when the OpenShift token is rejected", func() {
		h := failingCredentialHandler(fmt.Errorf("%w: token rejected by the API server", identity.ErrUnauthenticated))
		w := httptest.NewRecorder()

		h.HandleSaveSCMCredential(w, saveTokenRequest("ghp_valid"))

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	// Not 401: the API server being unreachable says nothing about the caller,
	// and the frontend answers 401 by disconnecting. A blip must not cost the
	// user a connection they still have.
	It("returns 503 when the identity cannot be looked up at all", func() {
		h := failingCredentialHandler(errors.New("dial tcp: connection refused"))
		w := httptest.NewRecorder()

		h.HandleSaveSCMCredential(w, saveTokenRequest("ghp_valid"))

		Expect(w.Code).To(Equal(http.StatusServiceUnavailable))
	})
})

var _ = Describe("GET /api/v1/scm/github/credential", func() {
	getRequest := func() *http.Request {
		return httptest.NewRequestWithContext(testOCPTokenContext(), http.MethodGet, "/api/v1/scm/github/credential", nil)
	}

	// The whole point of keying on identity alone: a browser that has never
	// seen this credential is connected by its OpenShift token and nothing else.
	It("reports the GitHub account behind a stored credential", func() {
		h := &Handlers{scmCredentials: withCredentialProviderStub()}
		w := httptest.NewRecorder()

		h.HandleGetSCMCredential(w, getRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var resp map[string]string
		Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
		Expect(resp).To(HaveKeyWithValue("login", "tester"))
		Expect(resp).To(HaveLen(2)) // login, avatarUrl and nothing else
	})

	// The stored token answers requests on the backend; handing it back to the
	// browser would undo the entire reason it lives in a Secret.
	It("never returns the token itself", func() {
		h := &Handlers{scmCredentials: withCredentialProviderStub()}
		w := httptest.NewRecorder()

		h.HandleGetSCMCredential(w, getRequest())

		Expect(w.Body.String()).NotTo(ContainSubstring("test-pat"))
	})

	// 404, not 401: the frontend reads 404 as "ask for a PAT", while 401
	// would disconnect a caller who is merely not connected yet.
	DescribeTable("reports lookup failures",
		func(cause error, code int) {
			h := failingCredentialHandler(cause)
			w := httptest.NewRecorder()

			h.HandleGetSCMCredential(w, getRequest())

			Expect(w.Code).To(Equal(code))
		},
		Entry("unconnected account", credentials.ErrNoCredential, http.StatusNotFound),
		Entry("rejected OpenShift token", identity.ErrUnauthenticated, http.StatusUnauthorized),
		Entry("unavailable store", errors.New("cluster unavailable"), http.StatusServiceUnavailable),
	)

})

var _ = Describe("DELETE /api/v1/scm/github/credential", func() {
	It("returns 204 when the credential provider is unavailable", func() {
		h := failingCredentialHandler(errors.New("token rejected by the API server"))
		w := httptest.NewRecorder()

		req := httptest.NewRequestWithContext(testOCPTokenContext(), http.MethodDelete, "/api/v1/scm/github/credential", nil)

		h.HandleDeleteSCMCredential(w, req)

		Expect(w.Code).To(Equal(http.StatusNoContent))
	})
})

func failingCredentialHandler(cause error) *Handlers {
	return &Handlers{scmCredentials: withCredentialProviderError(cause)}
}

func saveTokenRequest(pat string) *http.Request {
	body, err := json.Marshal(map[string]string{"pat": pat})
	Expect(err).NotTo(HaveOccurred())
	return httptest.NewRequestWithContext(testOCPTokenContext(), http.MethodPost, "/api/v1/scm/github/credential", bytes.NewBuffer(body))
}
