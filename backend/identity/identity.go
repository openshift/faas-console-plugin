// Package identity answers "which OpenShift user is behind this request?".
// The console proxy forwards the console user's bearer token, but the token is
// opaque, so the only way to learn the identity is to ask the API server.
package identity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/openshift/faas-console-plugin/backend/kube"
	authenticationv1 "k8s.io/api/authentication/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

var ErrUnauthenticated = errors.New("bearer token not accepted")

type User struct {
	Username string `json:"username"`
	UID      string `json:"uid,omitempty"`
}

func (u User) Matches(other User) bool {
	if u.UID != "" || other.UID != "" {
		return u.UID == other.UID && u.Username == other.Username
	}
	return u.Username != "" && u.Username == other.Username
}

// Resolver turns a bearer token into the user it authenticates as.
type Resolver interface {
	Resolve(ctx context.Context, token string) (User, error)
}

// users OCP identity is cached for 1 hour
const cacheTTL = time.Hour

func NewResolver(host string, caCert []byte) Resolver {
	return &reviewResolver{host: host, caCert: caCert, entries: map[string]cacheEntry{}}
}

type reviewResolver struct {
	host   string
	caCert []byte

	mu      sync.Mutex
	entries map[string]cacheEntry
}

type cacheEntry struct {
	user      User
	expiresAt time.Time
}

func (r *reviewResolver) Resolve(ctx context.Context, token string) (User, error) {
	if token == "" {
		return User{}, fmt.Errorf("%w: no bearer token", ErrUnauthenticated)
	}

	key := cacheKey(token)
	if user, ok := r.lookup(key); ok {
		return user, nil
	}

	cfg, err := kube.RESTConfig(r.host, token, r.caCert)
	if err != nil {
		return User{}, fmt.Errorf("build rest config: %w", err)
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return User{}, fmt.Errorf("create kubernetes client: %w", err)
	}

	review, err := client.AuthenticationV1().SelfSubjectReviews().Create(ctx, &authenticationv1.SelfSubjectReview{}, metav1.CreateOptions{})
	if err != nil {
		// A refused token and an unreachable API server both fail here, and only
		// the first one means the caller should be logged out.
		if apierrors.IsUnauthorized(err) || apierrors.IsForbidden(err) {
			return User{}, fmt.Errorf("%w: %v", ErrUnauthenticated, err)
		}
		return User{}, fmt.Errorf("self subject review: %w", err)
	}

	user := User{Username: review.Status.UserInfo.Username, UID: review.Status.UserInfo.UID}
	if user.Username == "" {
		return User{}, fmt.Errorf("%w: self subject review returned no username", ErrUnauthenticated)
	}

	r.store(key, user)
	return user, nil
}

// cacheKey hashes the token so it is never held in a map key that could end up
// in a heap dump or a debug print.
func cacheKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (r *reviewResolver) lookup(key string) (User, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry, ok := r.entries[key]
	if !ok || time.Now().After(entry.expiresAt) {
		return User{}, false
	}
	return entry.user, true
}

func (r *reviewResolver) store(key string, user User) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Nothing ever removes an entry explicitly, so drop the stale ones here
	now := time.Now()
	for k, entry := range r.entries {
		if now.After(entry.expiresAt) {
			delete(r.entries, k)
		}
	}

	r.entries[key] = cacheEntry{user: user, expiresAt: now.Add(cacheTTL)}
}

// ResolverStub is a test double. It resolves every token to the same user
// unless OnResolve says otherwise.
type ResolverStub struct {
	OnResolve func(ctx context.Context, token string) (User, error)
}

func (s *ResolverStub) Resolve(ctx context.Context, token string) (User, error) {
	if s.OnResolve != nil {
		return s.OnResolve(ctx, token)
	}
	return User{Username: "tester", UID: "tester-uid"}, nil
}
