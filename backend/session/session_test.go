package session

import (
	"context"
	"encoding/json"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/identity"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
)

const testNamespace = "console-functions-plugin"

// alice owns every credential these tests store; mallory is a second OpenShift
// user who must never reach it.
var (
	alice   = identity.User{Username: "alice", UID: "alice-uid"}
	mallory = identity.User{Username: "mallory", UID: "mallory-uid"}
)

var alicePAT = Credential{Owner: "alice-gh", AvatarURL: "https://avatars/alice", Secret: "ghp_secret", Type: CredentialTypePAT}

var _ = Describe("Store", func() {
	var (
		ctx   context.Context
		store *Store
	)

	newTestStore := func(objects ...runtime.Object) *Store {
		return NewStoreWithClient(fake.NewClientset(objects...), testNamespace)
	}

	BeforeEach(func() {
		ctx = context.Background()
		store = newTestStore()
	})

	Describe("CreateSession", func() {
		It("stores the secret in the configured namespace", func() {
			_, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			secret, err := store.client.CoreV1().Secrets(testNamespace).Get(ctx, secretName(alice), metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
			Expect(secret.Namespace).To(Equal(testNamespace))
		})

		// The credential type and owner are written but never read back on the
		// request path, so only a test against the stored bytes keeps them
		// honest. They exist so that whoever reads a Secret can tell what it
		// holds and whose account it is without trying it.
		It("records the credential type and owner", func() {
			oauth := Credential{Owner: "alice-gh", Secret: "gho_secret", Type: CredentialTypeOAuth}
			_, err := store.CreateSession(ctx, alice, oauth)
			Expect(err).NotTo(HaveOccurred())

			data := readSecretData(store, alice)
			Expect(data.Type).To(Equal(CredentialTypeOAuth))
			Expect(data.Owner).To(Equal("alice-gh"))
			Expect(data.User).To(Equal(alice))
		})

		It("requires an OpenShift user to bind to", func() {
			_, err := store.CreateSession(ctx, identity.User{}, alicePAT)
			Expect(err).To(HaveOccurred())
		})

		// Reconnecting must not orphan the previous Secret: it would still hold
		// a live PAT and nothing would ever delete it.
		It("replaces an existing credential rather than adding another", func() {
			first, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			second := Credential{Owner: "alice-gh", Secret: "ghp_rotated", Type: CredentialTypePAT}
			secondToken, err := store.CreateSession(ctx, alice, second)
			Expect(err).NotTo(HaveOccurred())

			secrets, err := store.client.CoreV1().Secrets(testNamespace).List(ctx, metav1.ListOptions{})
			Expect(err).NotTo(HaveOccurred())
			Expect(secrets.Items).To(HaveLen(1), "a user should own one secret")

			_, err = store.GetCredential(ctx, first, alice)
			Expect(err).To(MatchError(ErrInvalidSession), "the replaced token should stop working")

			credential, err := store.GetCredential(ctx, secondToken, alice)
			Expect(err).NotTo(HaveOccurred())
			Expect(credential.Secret).To(Equal("ghp_rotated"))
		})
	})

	Describe("GetCredential", func() {
		It("returns the stored credential", func() {
			token, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			credential, err := store.GetCredential(ctx, token, alice)
			Expect(err).NotTo(HaveOccurred())
			Expect(credential.Secret).To(Equal("ghp_secret"))
		})

		// The caller has to be able to tell a PAT from an OAuth token without
		// trying it, which is the whole reason this returns a Credential rather
		// than the bare string it holds.
		It("returns the type and owner alongside the secret", func() {
			token, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			credential, err := store.GetCredential(ctx, token, alice)
			Expect(err).NotTo(HaveOccurred())
			Expect(credential.Type).To(Equal(CredentialTypePAT))
			Expect(credential.Owner).To(Equal("alice-gh"))
			Expect(credential.AvatarURL).To(Equal("https://avatars/alice"))
		})

		It("rejects a token presented by a different OpenShift user", func() {
			token, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			_, err = store.GetCredential(ctx, token, mallory)
			Expect(err).To(HaveOccurred())

			// The rightful owner keeps the credential: a stolen token must not
			// be a way to revoke somebody else's.
			_, err = store.GetCredential(ctx, token, alice)
			Expect(err).NotTo(HaveOccurred(), "owner should still reach their credential")
		})

		// The Secret is found by identity, not by token, so the token itself has
		// to be checked against the one that was issued. Without that check any
		// string would unlock the caller's own credential.
		It("rejects a token that was never issued", func() {
			_, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			_, err = store.GetCredential(ctx, "nosuchtoken", alice)
			Expect(err).To(MatchError(ErrInvalidSession))
		})

		It("reports ErrNoCredential for a user with nothing stored", func() {
			_, err := store.GetCredential(ctx, "nosuchtoken", alice)
			Expect(err).To(MatchError(ErrNoCredential))
		})

		It("rejects an expired session token but leaves the credential reissuable", func() {
			store = newTestStore(secretFor(alice, func(d *secretData) {
				d.SessionExpiresAt = time.Now().Add(-time.Minute)
			}))

			_, err := store.GetCredential(ctx, "issued-token", alice)
			Expect(err).To(MatchError(ErrInvalidSession))

			// The credential outlives the token on purpose: that is what makes a
			// reissue possible instead of asking for the PAT again.
			_, err = store.Reissue(ctx, alice)
			Expect(err).NotTo(HaveOccurred(), "the credential should survive an expired session token")
		})

		It("rejects and deletes an expired credential", func() {
			store = newTestStore(secretFor(alice, func(d *secretData) {
				d.ExpiresAt = time.Now().Add(-time.Minute)
			}))

			_, err := store.GetCredential(ctx, "issued-token", alice)
			Expect(err).To(MatchError(ErrNoCredential))

			_, err = store.client.CoreV1().Secrets(testNamespace).Get(ctx, secretName(alice), metav1.GetOptions{})
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "expired credential secret should be deleted")
		})
	})

	Describe("Reissue", func() {
		// The point of the whole re-key: a browser that lost its token gets a
		// working one back without the user retyping their PAT.
		It("returns a working session carrying the SCM account", func() {
			_, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			sess, err := store.Reissue(ctx, alice)
			Expect(err).NotTo(HaveOccurred())
			Expect(sess.Owner).To(Equal("alice-gh"))
			Expect(sess.AvatarURL).To(Equal("https://avatars/alice"))

			credential, err := store.GetCredential(ctx, sess.Token, alice)
			Expect(err).NotTo(HaveOccurred())
			Expect(credential.Secret).To(Equal("ghp_secret"))
		})

		// Two tabs refreshing must converge on one handle. If each got its own,
		// every refresh would invalidate the other tab's token and they would
		// refresh each other in a loop.
		It("keeps an unexpired token stable across calls", func() {
			token, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			first, err := store.Reissue(ctx, alice)
			Expect(err).NotTo(HaveOccurred())
			second, err := store.Reissue(ctx, alice)
			Expect(err).NotTo(HaveOccurred())

			Expect(first.Token).To(Equal(token))
			Expect(second.Token).To(Equal(token))
		})

		It("mints a fresh token once the old one expired", func() {
			store = newTestStore(secretFor(alice, func(d *secretData) {
				d.SessionExpiresAt = time.Now().Add(-time.Minute)
			}))

			sess, err := store.Reissue(ctx, alice)
			Expect(err).NotTo(HaveOccurred())
			Expect(sess.Token).NotTo(Equal("issued-token"), "an expired token should be replaced, not handed back")

			_, err = store.GetCredential(ctx, sess.Token, alice)
			Expect(err).NotTo(HaveOccurred(), "the new token should work")

			_, err = store.GetCredential(ctx, "issued-token", alice)
			Expect(err).To(MatchError(ErrInvalidSession), "the expired token should stop working once replaced")
		})

		It("reports ErrNoCredential for a user with nothing stored", func() {
			_, err := store.Reissue(ctx, alice)
			Expect(err).To(MatchError(ErrNoCredential))
		})

		It("refuses an expired credential", func() {
			store = newTestStore(secretFor(alice, func(d *secretData) {
				d.ExpiresAt = time.Now().Add(-time.Minute)
			}))

			_, err := store.Reissue(ctx, alice)
			Expect(err).To(MatchError(ErrNoCredential))
		})

		It("does not reach another OpenShift user's credential", func() {
			store = newTestStore(secretFor(alice))

			// mallory hashes to a different Secret name, so this is the ordinary miss.
			_, err := store.Reissue(ctx, mallory)
			Expect(err).To(MatchError(ErrNoCredential))
		})
	})

	Describe("DeleteSession", func() {
		It("removes the secret", func() {
			token, err := store.CreateSession(ctx, alice, alicePAT)
			Expect(err).NotTo(HaveOccurred())

			Expect(store.DeleteSession(ctx, alice)).To(Succeed())

			_, err = store.GetCredential(ctx, token, alice)
			Expect(err).To(MatchError(ErrNoCredential))
		})

		// Disconnecting is something the browser does on its way out; failing it
		// because there was nothing to delete would only produce noise.
		It("succeeds when there is nothing to delete", func() {
			Expect(store.DeleteSession(ctx, alice)).To(Succeed())
		})
	})
})

var _ = Describe("NewStore", func() {
	It("rejects an empty namespace", func() {
		_, err := NewStore(nil, "")
		Expect(err).To(HaveOccurred())
	})
})

var _ = Describe("generateToken", func() {
	It("is unique and full length", func() {
		token1, err := generateToken()
		Expect(err).NotTo(HaveOccurred())
		token2, err := generateToken()
		Expect(err).NotTo(HaveOccurred())

		Expect(token1).NotTo(Equal(token2))
		// Hex doubles the byte count, and a short token is a guessable token.
		Expect(token1).To(HaveLen(tokenLength * 2))
	})
})

var _ = Describe("secretName", func() {
	It("hides the identity it is derived from", func() {
		name := secretName(alice)

		Expect(name).NotTo(Equal(secretName(mallory)), "different users should not share a secret name")
		Expect(name).To(Equal(secretName(alice)), "a user's secret name should be stable across calls")

		// The name shows up in audit logs and in `oc get secrets`.
		Expect(name).NotTo(ContainSubstring(alice.Username))
		Expect(name).NotTo(ContainSubstring(alice.UID))
	})

	// kube:admin has no UID, so the username is the only key available. A user
	// who does have a UID must not be reachable through their username alone.
	It("separates UIDs from usernames", func() {
		byUID := secretName(identity.User{Username: "alice", UID: "shared"})
		byName := secretName(identity.User{Username: "shared"})

		Expect(byUID).NotTo(Equal(byName))
	})

	// The Secret holds an OAuth token just as readily as a PAT, and a name
	// claiming otherwise would have to be migrated rather than corrected.
	It("does not name the credential type", func() {
		Expect(secretName(alice)).NotTo(ContainSubstring("pat"))
	})
})

func readSecretData(store *Store, user identity.User) secretData {
	GinkgoHelper()

	secret, err := store.client.CoreV1().Secrets(testNamespace).Get(context.Background(), secretName(user), metav1.GetOptions{})
	Expect(err).NotTo(HaveOccurred(), "session secret not found")

	var data secretData
	Expect(json.Unmarshal(secret.Data["session"], &data)).To(Succeed())
	return data
}

// secretFor builds a stored credential for user, holding the session token
// "issued-token". Each mutator adjusts it, so a test states only the field it
// is about.
func secretFor(user identity.User, mutators ...func(*secretData)) *corev1.Secret {
	now := time.Now()
	d := secretData{
		Credential:       "ghp_secret",
		Type:             CredentialTypePAT,
		Owner:            "alice-gh",
		AvatarURL:        "https://avatars/alice",
		User:             user,
		SessionToken:     "issued-token",
		SessionExpiresAt: now.Add(sessionTTL),
		ExpiresAt:        now.Add(credentialTTL),
	}
	for _, mutate := range mutators {
		mutate(&d)
	}

	data, err := json.Marshal(d)
	if err != nil {
		panic(err)
	}
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: secretName(user), Namespace: testNamespace},
		Data:       map[string][]byte{"session": data},
	}
}
