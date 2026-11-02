package credentials

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
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	ktesting "k8s.io/client-go/testing"
)

const testNamespace = "console-functions-plugin"

// alice owns every credential these tests store; mallory is a second OpenShift
// user who must never reach it. The tokens stand in for what the console proxy
// forwards, which is all the store is ever given.
var (
	alice   = identity.User{Username: "alice", UID: "alice-uid"}
	mallory = identity.User{Username: "mallory", UID: "mallory-uid"}
)

const (
	aliceToken   = "alice-ocp-token"
	malloryToken = "mallory-ocp-token"
)

// tokenResolver plays the API server: it knows these two tokens and refuses
// everything else, the way a cluster refuses a token it did not issue.
func tokenResolver() identity.Resolver {
	return &identity.ResolverStub{
		OnResolve: func(_ context.Context, token string) (identity.User, error) {
			switch token {
			case aliceToken:
				return alice, nil
			case malloryToken:
				return mallory, nil
			}
			return identity.User{}, identity.ErrUnauthenticated
		},
	}
}

var alicePAT = Credential{Owner: "alice-gh", AvatarURL: "https://avatars/alice", Token: "ghp_secret", Type: CredentialTypePAT}

var _ = Describe("Store", func() {
	var (
		ctx   context.Context
		store *Store
	)

	newTestStore := func(objects ...runtime.Object) *Store {
		GinkgoHelper()
		store, err := NewStoreWithClient(fake.NewClientset(objects...), testNamespace, tokenResolver())
		Expect(err).NotTo(HaveOccurred())
		return store
	}

	BeforeEach(func() {
		ctx = context.Background()
		store = newTestStore()
	})

	Describe("Save", func() {
		It("saves the credential when its Secret is deleted during a reconnect", func() {
			client := fake.NewClientset(secretFor(alice))
			var err error
			store, err = NewStoreWithClient(client, testNamespace, tokenResolver())
			Expect(err).NotTo(HaveOccurred())
			client.PrependReactor("update", "secrets", func(action ktesting.Action) (bool, runtime.Object, error) {
				err := client.Tracker().Delete(corev1.SchemeGroupVersion.WithResource("secrets"), testNamespace, secretName(alice))
				if err != nil {
					return true, nil, err
				}
				return true, nil, apierrors.NewNotFound(schema.GroupResource{Resource: "secrets"}, secretName(alice))
			})
			rotated := Credential{Owner: "alice-gh", Token: "ghp_rotated", Type: CredentialTypePAT}

			Expect(store.Save(ctx, aliceToken, rotated)).To(Succeed())

			credential, err := store.Get(ctx, aliceToken)
			Expect(err).NotTo(HaveOccurred())
			Expect(credential).To(Equal(rotated))
		})

		It("stores the secret in the configured namespace", func() {
			Expect(store.Save(ctx, aliceToken, alicePAT)).To(Succeed())

			secret, err := store.client.CoreV1().Secrets(testNamespace).Get(ctx, secretName(alice), metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
			Expect(secret.Namespace).To(Equal(testNamespace))
		})

		// The credential type and owner are written but never read back on the
		// request path, so only a test against the stored bytes keeps them
		// honest. They exist so that whoever reads a Secret can tell what it
		// holds and whose account it is without trying it.
		It("records the credential type and owner", func() {
			oauth := Credential{Owner: "alice-gh", Token: "gho_secret", Type: CredentialTypeOAuth}
			Expect(store.Save(ctx, aliceToken, oauth)).To(Succeed())

			data := readSecretData(store, alice)
			Expect(data.Type).To(Equal(CredentialTypeOAuth))
			Expect(data.Owner).To(Equal("alice-gh"))
			Expect(data.User).To(Equal(alice))
		})

		// Without a user to bind to there is nothing to key the Secret by, so
		// a token the cluster will not identify must not store anything.
		It("refuses a token the cluster does not recognise", func() {
			Expect(store.Save(ctx, "not-a-token", alicePAT)).To(MatchError(identity.ErrUnauthenticated))
		})

		It("refuses a request carrying no token at all", func() {
			Expect(store.Save(ctx, "", alicePAT)).To(MatchError(identity.ErrUnauthenticated))
		})

		// Reconnecting must not orphan the previous Secret: it would still hold
		// a live PAT and nothing would ever delete it.
		It("replaces an existing credential rather than adding another", func() {
			Expect(store.Save(ctx, aliceToken, alicePAT)).To(Succeed())

			rotated := Credential{Owner: "alice-gh", Token: "ghp_rotated", Type: CredentialTypePAT}
			Expect(store.Save(ctx, aliceToken, rotated)).To(Succeed())

			secrets, err := store.client.CoreV1().Secrets(testNamespace).List(ctx, metav1.ListOptions{})
			Expect(err).NotTo(HaveOccurred())
			Expect(secrets.Items).To(HaveLen(1), "a user should own one secret")

			credential, err := store.Get(ctx, aliceToken)
			Expect(err).NotTo(HaveOccurred())
			Expect(credential.Token).To(Equal("ghp_rotated"))
		})
	})

	Describe("Get", func() {
		It("returns the stored credential", func() {
			Expect(store.Save(ctx, aliceToken, alicePAT)).To(Succeed())

			credential, err := store.Get(ctx, aliceToken)
			Expect(err).NotTo(HaveOccurred())
			Expect(credential.Token).To(Equal("ghp_secret"))
		})

		// The caller has to be able to tell a PAT from an OAuth token without
		// trying it, which is the whole reason this returns a Credential rather
		// than the bare string it holds.
		It("returns the type and owner alongside the secret", func() {
			Expect(store.Save(ctx, aliceToken, alicePAT)).To(Succeed())

			credential, err := store.Get(ctx, aliceToken)
			Expect(err).NotTo(HaveOccurred())
			Expect(credential.Type).To(Equal(CredentialTypePAT))
			Expect(credential.Owner).To(Equal("alice-gh"))
			Expect(credential.AvatarURL).To(Equal("https://avatars/alice"))
		})

		It("reports ErrNoCredential for a user with nothing stored", func() {
			_, err := store.Get(ctx, aliceToken)
			Expect(err).To(MatchError(ErrNoCredential))
		})

		// The OpenShift identity is now the only key, so the binding written
		// into the Secret is what has to be checked. It is verified on every
		// read rather than inferred from where the Secret was found, because a
		// deleted and recreated account could hash to the same name.
		It("refuses a credential bound to a different OpenShift user", func() {
			store = newTestStore(secretAt(mallory, alice))

			_, err := store.Get(ctx, malloryToken)
			Expect(err).To(MatchError(ErrNoCredential))
		})

		It("does not reach another OpenShift user's credential", func() {
			store = newTestStore(secretFor(alice))

			// mallory hashes to a different Secret name, so this is the ordinary miss.
			_, err := store.Get(ctx, malloryToken)
			Expect(err).To(MatchError(ErrNoCredential))

			// The rightful owner keeps the credential: a failed read by somebody
			// else must not cost them their connection.
			_, err = store.Get(ctx, aliceToken)
			Expect(err).NotTo(HaveOccurred(), "owner should still reach their credential")
		})

		It("rejects and deletes an expired credential", func() {
			store = newTestStore(secretFor(alice, func(d *secretData) {
				d.ExpiresAt = time.Now().Add(-time.Minute)
			}))

			_, err := store.Get(ctx, aliceToken)
			Expect(err).To(MatchError(ErrNoCredential))

			_, err = store.client.CoreV1().Secrets(testNamespace).Get(ctx, secretName(alice), metav1.GetOptions{})
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "expired credential secret should be deleted")
		})

		// Secrets written before the session token was removed key their payload
		// under "session". Reporting them as nothing stored is what lets the user
		// reconnect and overwrite them, instead of wedging on a read error.
		It("reports ErrNoCredential for a secret left by the old session format", func() {
			stale := secretFor(alice)
			stale.Data = map[string][]byte{"session": stale.Data[secretDataKey]}
			store = newTestStore(stale)

			_, err := store.Get(ctx, aliceToken)
			Expect(err).To(MatchError(ErrNoCredential))
		})
	})

	Describe("Delete", func() {
		It("removes the secret", func() {
			Expect(store.Save(ctx, aliceToken, alicePAT)).To(Succeed())

			Expect(store.Delete(ctx, aliceToken)).To(Succeed())

			_, err := store.Get(ctx, aliceToken)
			Expect(err).To(MatchError(ErrNoCredential))
		})

		// Disconnecting is something the browser does on its way out; failing it
		// because there was nothing to delete would only produce noise.
		It("succeeds when there is nothing to delete", func() {
			Expect(store.Delete(ctx, aliceToken)).To(Succeed())
		})

		// Revocation follows the identity, so one user disconnecting must not
		// take another user's credential with it.
		It("leaves another user's credential alone", func() {
			store = newTestStore(secretFor(alice))

			Expect(store.Delete(ctx, malloryToken)).To(Succeed())

			_, err := store.Get(ctx, aliceToken)
			Expect(err).NotTo(HaveOccurred())
		})
	})
})

var _ = Describe("NewStore", func() {
	It("rejects an empty namespace when a client is supplied directly", func() {
		store, err := NewStoreWithClient(fake.NewClientset(), "", tokenResolver())
		Expect(err).To(MatchError("credential namespace is required"))
		Expect(store).To(BeNil())
	})

	It("rejects an empty namespace", func() {
		_, err := NewStore(&rest.Config{}, "", tokenResolver())
		Expect(err).To(MatchError("credential namespace is required"))
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
	Expect(err).NotTo(HaveOccurred(), "credential secret not found")

	var data secretData
	Expect(json.Unmarshal(secret.Data[secretDataKey], &data)).To(Succeed())
	return data
}

// secretFor builds a stored credential owned by user. Each mutator adjusts it,
// so a test states only the field it is about.
func secretFor(user identity.User, mutators ...func(*secretData)) *corev1.Secret {
	return secretAt(user, user, mutators...)
}

// secretAt builds a credential stored under name's Secret but bound to boundTo,
// which is how a test separates "where the Secret was found" from "whose it is".
func secretAt(name, boundTo identity.User, mutators ...func(*secretData)) *corev1.Secret {
	d := secretData{
		Token:     "ghp_secret",
		Type:      CredentialTypePAT,
		Owner:     "alice-gh",
		AvatarURL: "https://avatars/alice",
		User:      boundTo,
		ExpiresAt: time.Now().Add(credentialTTL),
	}
	for _, mutate := range mutators {
		mutate(&d)
	}

	data, err := json.Marshal(d)
	if err != nil {
		panic(err)
	}
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: secretName(name), Namespace: testNamespace},
		Data:       map[string][]byte{secretDataKey: data},
	}
}
