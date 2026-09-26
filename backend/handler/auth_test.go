package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("POST /api/v1/auth/login", func() {
	BeforeEach(func() {
		withSCMStub(&scm.ClientStub{
			OnGetUser: func(ctx context.Context) (*scm.User, error) {
				return &scm.User{Login: "alice-gh", AvatarURL: "https://example.com/avatar"}, nil
			},
		})
	})

	// Asserted through the store rather than on what the handler passed it: the
	// token it just minted must work for its owner and for nobody else.
	It("binds the session to the OpenShift user that created it", func() {
		h := resolvingTo(testOCPUser)
		w := httptest.NewRecorder()

		h.HandleLogin(w, loginRequest("ghp_valid"))

		Expect(w.Code).To(Equal(http.StatusCreated))
		var resp map[string]string
		Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())

		credential, err := h.sessionStore.GetCredential(context.Background(), resp["token"], testOCPUser)
		Expect(err).NotTo(HaveOccurred())
		Expect(credential.Secret).To(Equal("ghp_valid"))

		_, err = h.sessionStore.GetCredential(context.Background(), resp["token"], mallory)
		Expect(err).To(HaveOccurred())
	})

	It("returns the session token and the GitHub profile, never the PAT", func() {
		w := httptest.NewRecorder()

		resolvingTo(testOCPUser).HandleLogin(w, loginRequest("ghp_valid"))

		var resp map[string]string
		Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
		Expect(resp).To(HaveKeyWithValue("login", "alice-gh"))
		Expect(resp).To(HaveKeyWithValue("avatarUrl", "https://example.com/avatar"))
		Expect(resp).To(HaveLen(3)) // token, login, avatarUrl and nothing else
		Expect(resp["token"]).NotTo(BeEmpty())
		Expect(resp["token"]).NotTo(Equal("ghp_valid"))
	})

	It("returns 401 when the OpenShift token is rejected", func() {
		h := failingToResolve(fmt.Errorf("%w: token rejected by the API server", identity.ErrUnauthenticated))
		w := httptest.NewRecorder()

		h.HandleLogin(w, loginRequest("ghp_valid"))

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
		// Nothing is stored for a caller with no identity to bind to, so the
		// cluster still holds only the session the test started with.
		Expect(sessionSecrets()).To(HaveLen(1))
	})

	// Not 401: the API server being unreachable says nothing about the caller,
	// and the frontend answers 401 by throwing the session away. A blip must
	// not cost the user a connection they still have.
	It("returns 503 when the identity cannot be looked up at all", func() {
		h := failingToResolve(errors.New("dial tcp: connection refused"))
		w := httptest.NewRecorder()

		h.HandleLogin(w, loginRequest("ghp_valid"))

		Expect(w.Code).To(Equal(http.StatusServiceUnavailable))
		Expect(sessionSecrets()).To(HaveLen(1))
	})

	It("returns 401 when the console forwarded no user token", func() {
		h := resolvingTo(testOCPUser)
		req := loginRequest("ghp_valid")
		req.Header.Del("Authorization")
		w := httptest.NewRecorder()

		h.HandleLogin(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})
})

var _ = Describe("POST /api/v1/auth/logout", func() {
	logoutRequest := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
		authenticate(req)
		return req
	}

	It("deletes the session of the user it belongs to", func() {
		h := resolvingTo(testOCPUser)
		w := httptest.NewRecorder()

		h.HandleLogout(w, logoutRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(sessionSecrets()).To(BeEmpty())
	})

	// Revocation follows the identity, not the handle. Holding somebody else's
	// token must not be a way to disconnect their GitHub account.
	It("leaves the session alone when another user presents the token", func() {
		h := resolvingTo(mallory)
		w := httptest.NewRecorder()

		h.HandleLogout(w, logoutRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(sessionSecrets()).To(HaveLen(1))
	})

	// The browser disconnects with whatever it has. An expired or missing handle
	// is the ordinary case after the session TTL passes, and the user still
	// expects the credential to be gone.
	It("revokes the credential even without a session header", func() {
		h := resolvingTo(testOCPUser)
		req := logoutRequest()
		req.Header.Del(sessionHeader)
		w := httptest.NewRecorder()

		h.HandleLogout(w, req)

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(sessionSecrets()).To(BeEmpty())
	})

	It("returns 204 without touching the store when the user cannot be resolved", func() {
		h := failingToResolve(errors.New("token rejected by the API server"))
		w := httptest.NewRecorder()

		h.HandleLogout(w, logoutRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(sessionSecrets()).To(HaveLen(1))
	})
})

var _ = Describe("POST /api/v1/auth/session", func() {
	// No session header on purpose: the endpoint exists for a browser that has
	// none, so requiring one would defeat it.
	sessionRequest := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/session", nil)
		req.Header.Set("Authorization", "Bearer "+testOCPToken)
		return req
	}

	It("hands back a working session for a stored credential", func() {
		h := resolvingTo(testOCPUser)
		w := httptest.NewRecorder()

		h.HandleResumeSession(w, sessionRequest())

		Expect(w.Code).To(Equal(http.StatusOK))
		var resp map[string]string
		Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
		Expect(resp).To(HaveKeyWithValue("login", "tester"))

		credential, err := h.sessionStore.GetCredential(context.Background(), resp["token"], testOCPUser)
		Expect(err).NotTo(HaveOccurred())
		Expect(credential.Secret).To(Equal("test-pat"))
	})

	// A caller with nothing stored is not an authentication failure: they are
	// known, they have simply never connected. The frontend turns every 401 into
	// "the session is gone" and retries here, so answering 401 would recurse.
	It("returns 404 when the user has no stored credential", func() {
		h := resolvingTo(mallory)
		w := httptest.NewRecorder()

		h.HandleResumeSession(w, sessionRequest())

		Expect(w.Code).To(Equal(http.StatusNotFound))
	})

	It("returns 401 when the OpenShift token is rejected", func() {
		h := failingToResolve(fmt.Errorf("%w: token rejected by the API server", identity.ErrUnauthenticated))
		w := httptest.NewRecorder()

		h.HandleResumeSession(w, sessionRequest())

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	// This endpoint is what the frontend calls to recover a lost token, so
	// answering 401 here would send it straight back round to itself.
	It("returns 503 when the identity cannot be looked up at all", func() {
		h := failingToResolve(errors.New("dial tcp: connection refused"))
		w := httptest.NewRecorder()

		h.HandleResumeSession(w, sessionRequest())

		Expect(w.Code).To(Equal(http.StatusServiceUnavailable))
	})
})

// mallory is a second OpenShift user holding a session token that is not theirs.
var mallory = identity.User{Username: "mallory", UID: "mallory-uid"}

// resolvingTo builds handlers whose requests authenticate as user.
func resolvingTo(user identity.User) *Handlers {
	return testHandlers(Handlers{identityResolver: &identity.ResolverStub{
		OnResolve: func(context.Context, string) (identity.User, error) { return user, nil },
	}})
}

// failingToResolve builds handlers that cannot identify their caller. The error
// is the test's to choose: whether it wraps identity.ErrUnauthenticated is what
// decides between blaming the caller and blaming the backend.
func failingToResolve(cause error) *Handlers {
	return testHandlers(Handlers{identityResolver: &identity.ResolverStub{
		OnResolve: func(context.Context, string) (identity.User, error) { return identity.User{}, cause },
	}})
}

func loginRequest(pat string) *http.Request {
	body, err := json.Marshal(map[string]string{"pat": pat})
	Expect(err).NotTo(HaveOccurred())
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/v1/auth/login", bytes.NewBuffer(body))
	authenticate(req)
	// Logging in is how a session is obtained, so there is none to send yet.
	req.Header.Del(sessionHeader)
	return req
}
