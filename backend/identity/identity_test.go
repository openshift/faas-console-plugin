package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var _ = Describe("User.Matches", func() {
	// Asserted in both directions: a binding check that held one way round but
	// not the other would be a hole rather than a quirk.
	DescribeTable("comparing two identities",
		func(a, b User, match bool) {
			Expect(a.Matches(b)).To(Equal(match))
			Expect(b.Matches(a)).To(Equal(match), "Matches should be symmetric")
		},
		Entry("same username and uid",
			User{Username: "alice", UID: "uid-1"}, User{Username: "alice", UID: "uid-1"}, true),
		// kube:admin is backed by a static Secret, not a User object, so the API
		// server reports no UID for it.
		Entry("same username, neither has a uid",
			User{Username: "kube:admin"}, User{Username: "kube:admin"}, true),
		// A deleted and recreated account keeps the name but gets a fresh UID,
		// and must not inherit the old user's sessions.
		Entry("same username, different uid",
			User{Username: "alice", UID: "uid-1"}, User{Username: "alice", UID: "uid-2"}, false),
		Entry("different username, same uid",
			User{Username: "alice", UID: "uid-1"}, User{Username: "mallory", UID: "uid-1"}, false),
		Entry("uid known on one side only",
			User{Username: "alice", UID: "uid-1"}, User{Username: "alice"}, false),
		// Guards sessions written before the binding existed: an empty stored
		// user must not match an empty caller.
		Entry("both empty", User{}, User{}, false),
		Entry("empty against a real user",
			User{}, User{Username: "alice", UID: "uid-1"}, false),
	)
})

var _ = Describe("Resolve", func() {
	It("rejects a previously accepted token after the API server revokes it", func() {
		var revoked atomic.Bool
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if revoked.Load() {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(metav1.Status{
					Status: metav1.StatusFailure, Reason: metav1.StatusReasonUnauthorized, Code: http.StatusUnauthorized,
				})
				return
			}
			_ = json.NewEncoder(w).Encode(authenticationv1.SelfSubjectReview{
				Status: authenticationv1.SelfSubjectReviewStatus{
					UserInfo: authenticationv1.UserInfo{Username: "alice", UID: "uid-1"},
				},
			})
		}))
		DeferCleanup(server.Close)
		resolver := NewResolver(server.URL, nil)

		user, err := resolver.ResolveUserIdentity(context.Background(), "console-token")
		Expect(err).NotTo(HaveOccurred())
		Expect(user).To(Equal(User{Username: "alice", UID: "uid-1"}))

		revoked.Store(true)
		_, err = resolver.ResolveUserIdentity(context.Background(), "console-token")
		Expect(err).To(MatchError(ErrUnauthenticated))
	})

	It("rejects an empty token instead of calling the API server", func() {
		resolver := NewResolver("https://api.example.com:6443", nil)

		_, err := resolver.ResolveUserIdentity(context.Background(), "")
		Expect(err).To(MatchError(ErrUnauthenticated))
	})
})
