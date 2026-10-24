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

var _ = Describe("POST /api/v1/scm/github/credential", func() {
	BeforeEach(func() {
		withSCMStub(&scm.ClientStub{
			OnGetUser: func(ctx context.Context) (*scm.User, error) {
				return &scm.User{Login: "alice-gh", AvatarURL: "https://example.com/avatar"}, nil
			},
		})
	})

	// Asserted through the store rather than on what the handler passed it: the
	// credential it just wrote must be reachable by its owner and by nobody else.
	It("binds the credential to the OpenShift user that stored it", func() {
		h := resolvingTo(testOCPUser)
		w := httptest.NewRecorder()

		h.HandleSaveSCMCredential(w, saveTokenRequest("ghp_valid"))

		Expect(w.Code).To(Equal(http.StatusCreated))

		credential, err := h.scmCredentials.GetCredential(context.Background(), testOCPToken)
		Expect(err).NotTo(HaveOccurred())
		Expect(credential.Token).To(Equal("ghp_valid"))

		_, err = storeAs(mallory).GetCredential(context.Background(), testOCPToken)
		Expect(err).To(HaveOccurred())
	})

	It("returns the GitHub profile, never the token", func() {
		w := httptest.NewRecorder()

		resolvingTo(testOCPUser).HandleSaveSCMCredential(w, saveTokenRequest("ghp_valid"))

		var resp map[string]string
		Expect(json.NewDecoder(w.Body).Decode(&resp)).To(Succeed())
		Expect(resp).To(HaveKeyWithValue("login", "alice-gh"))
		Expect(resp).To(HaveKeyWithValue("avatarUrl", "https://example.com/avatar"))
		Expect(resp).To(HaveLen(2)) // login, avatarUrl and nothing else
	})

	It("returns 400 when no token was sent", func() {
		w := httptest.NewRecorder()

		resolvingTo(testOCPUser).HandleSaveSCMCredential(w, saveTokenRequest(""))

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

		resolvingTo(testOCPUser).HandleSaveSCMCredential(w, saveTokenRequest("ghp_bad"))

		Expect(w.Code).To(Equal(http.StatusForbidden))
		// A token GitHub refuses is never written, so the caller keeps whatever
		// they already had rather than losing it to a typo.
		Expect(credentialSecrets()).To(HaveLen(1))
	})

	It("returns 401 when the OpenShift token is rejected", func() {
		h := failingToResolve(fmt.Errorf("%w: token rejected by the API server", identity.ErrUnauthenticated))
		w := httptest.NewRecorder()

		h.HandleSaveSCMCredential(w, saveTokenRequest("ghp_valid"))

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
		// Nothing is stored for a caller with no identity to bind to, so the
		// cluster still holds only the credential the test started with.
		Expect(credentialSecrets()).To(HaveLen(1))
	})

	// Not 401: the API server being unreachable says nothing about the caller,
	// and the frontend answers 401 by disconnecting. A blip must not cost the
	// user a connection they still have.
	It("returns 503 when the identity cannot be looked up at all", func() {
		h := failingToResolve(errors.New("dial tcp: connection refused"))
		w := httptest.NewRecorder()

		h.HandleSaveSCMCredential(w, saveTokenRequest("ghp_valid"))

		Expect(w.Code).To(Equal(http.StatusServiceUnavailable))
		Expect(credentialSecrets()).To(HaveLen(1))
	})

	It("returns 401 when the console forwarded no user token", func() {
		h := resolvingTo(testOCPUser)
		req := saveTokenRequest("ghp_valid")
		req.Header.Del("Authorization")
		w := httptest.NewRecorder()

		h.HandleSaveSCMCredential(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})
})

var _ = Describe("GET /api/v1/scm/github/credential", func() {
	getRequest := func() *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/scm/github/credential", nil)
		req.Header.Set("Authorization", "Bearer "+testOCPToken)
		return req
	}

	// The whole point of keying on identity alone: a browser that has never
	// seen this credential is connected by its OpenShift token and nothing else.
	It("reports the GitHub account behind a stored credential", func() {
		h := resolvingTo(testOCPUser)
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
		h := resolvingTo(testOCPUser)
		w := httptest.NewRecorder()

		h.HandleGetSCMCredential(w, getRequest())

		Expect(w.Body.String()).NotTo(ContainSubstring("test-pat"))
	})

	// A caller with nothing stored is not an authentication failure: they are
	// known, they have simply never connected. The frontend reads 404 as "show
	// the connect prompt" rather than "something went wrong".
	It("returns 404 when the user has no stored credential", func() {
		h := resolvingTo(mallory)
		w := httptest.NewRecorder()

		h.HandleGetSCMCredential(w, getRequest())

		Expect(w.Code).To(Equal(http.StatusNotFound))
	})

	It("returns 401 when the OpenShift token is rejected", func() {
		h := failingToResolve(fmt.Errorf("%w: token rejected by the API server", identity.ErrUnauthenticated))
		w := httptest.NewRecorder()

		h.HandleGetSCMCredential(w, getRequest())

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	// Not 404: the frontend reads that as "there is nothing stored" and shows
	// the connect prompt. Being unable to read the credential is not the same
	// as there not being one.
	It("returns 503 when the identity cannot be looked up at all", func() {
		h := failingToResolve(errors.New("dial tcp: connection refused"))
		w := httptest.NewRecorder()

		h.HandleGetSCMCredential(w, getRequest())

		Expect(w.Code).To(Equal(http.StatusServiceUnavailable))
	})
})

var _ = Describe("DELETE /api/v1/scm/github/credential", func() {
	deleteRequest := func() *http.Request {
		req := httptest.NewRequest(http.MethodDelete, "/api/v1/scm/github/credential", nil)
		authenticate(req)
		return req
	}

	It("deletes the credential of the user it belongs to", func() {
		h := resolvingTo(testOCPUser)
		w := httptest.NewRecorder()

		h.HandleDeleteSCMCredential(w, deleteRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(credentialSecrets()).To(BeEmpty())
	})

	// Revocation follows the identity. Reaching the backend as one user must
	// not be a way to disconnect somebody else's GitHub account.
	It("leaves another user's credential alone", func() {
		h := resolvingTo(mallory)
		w := httptest.NewRecorder()

		h.HandleDeleteSCMCredential(w, deleteRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(credentialSecrets()).To(HaveLen(1))
	})

	It("returns 204 without touching the store when the user cannot be resolved", func() {
		h := failingToResolve(errors.New("token rejected by the API server"))
		w := httptest.NewRecorder()

		h.HandleDeleteSCMCredential(w, deleteRequest())

		Expect(w.Code).To(Equal(http.StatusNoContent))
		Expect(credentialSecrets()).To(HaveLen(1))
	})
})

// mallory is a second OpenShift user, who has no credential of their own.
var mallory = identity.User{Username: "mallory", UID: "mallory-uid"}

// resolvingTo builds handlers whose requests authenticate as user.
func resolvingTo(user identity.User) *Handlers {
	return testHandlersResolving(Handlers{}, &identity.ResolverStub{
		OnResolve: func(context.Context, string) (identity.User, error) { return user, nil },
	})
}

// failingToResolve builds handlers that cannot identify their caller. The error
// is the test's to choose: whether it wraps identity.ErrUnauthenticated is what
// decides between blaming the caller and blaming the backend.
func failingToResolve(cause error) *Handlers {
	return testHandlersResolving(Handlers{}, &identity.ResolverStub{
		OnResolve: func(context.Context, string) (identity.User, error) { return identity.User{}, cause },
	})
}

func saveTokenRequest(pat string) *http.Request {
	body, err := json.Marshal(map[string]string{"pat": pat})
	Expect(err).NotTo(HaveOccurred())
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/v1/scm/github/credential", bytes.NewBuffer(body))
	return authenticate(req)
}
