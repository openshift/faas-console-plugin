package identity

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
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
	It("rejects an empty token instead of calling the API server", func() {
		resolver := NewResolver("https://api.example.com:6443", nil)

		_, err := resolver.Resolve(context.Background(), "")
		Expect(err).To(MatchError(ErrUnauthenticated))
	})

	// A cached answer must be served without a second API server call, and must
	// stop being served once it expires. Asserted against the map directly: the
	// resolver has no seam for faking SelfSubjectReview, so a live call is the
	// only alternative and there is no cluster in a unit test.
	It("serves cached answers until they expire", func() {
		r := &reviewResolver{entries: map[string]cacheEntry{}}
		const token = "sha256~console-token"
		alice := User{Username: "alice", UID: "uid-1"}

		r.store(cacheKey(token), alice)

		user, err := r.Resolve(context.Background(), token)
		Expect(err).NotTo(HaveOccurred())
		Expect(user).To(Equal(alice))

		// Past the TTL the entry is ignored, so Resolve falls through to the API
		// server and fails for want of one rather than serving the stale answer.
		r.entries[cacheKey(token)] = cacheEntry{user: alice, expiresAt: time.Now().Add(-time.Second)}
		_, err = r.Resolve(context.Background(), token)
		Expect(err).To(HaveOccurred(), "Resolve should not serve an expired entry")
	})
})

var _ = Describe("cacheKey", func() {
	const token = "sha256~secret-console-token"

	It("hides the token", func() {
		Expect(cacheKey(token)).NotTo(Equal(token))
	})

	It("is stable for the same token", func() {
		Expect(cacheKey(token)).To(Equal(cacheKey(token)))
	})

	It("differs for different tokens", func() {
		Expect(cacheKey(token)).NotTo(Equal(cacheKey(token + "x")))
	})
})

// Expired entries are dropped on write, or the map grows with every console
// token the backend has ever seen.
var _ = Describe("store", func() {
	It("prunes expired entries and keeps the new one", func() {
		r := &reviewResolver{entries: map[string]cacheEntry{
			"stale": {user: User{Username: "bob"}, expiresAt: time.Now().Add(-time.Second)},
		}}

		r.store("fresh", User{Username: "alice"})

		Expect(r.entries).NotTo(HaveKey("stale"))
		Expect(r.entries).To(HaveKey("fresh"))
	})
})
