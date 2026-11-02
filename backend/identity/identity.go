// Package identity answers "which OpenShift user is behind this request?".
// The console proxy forwards the console user's bearer token, but the token is
// opaque, so the only way to learn the identity is to ask the API server.
package identity

import (
	"context"
	"errors"
	"fmt"

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
	ResolveUserIdentity(ctx context.Context, token string) (User, error)
}

func NewResolver(host string, caCert []byte) Resolver {
	return &reviewResolver{host: host, caCert: caCert}
}

type reviewResolver struct {
	host   string
	caCert []byte
}

func (r *reviewResolver) ResolveUserIdentity(ctx context.Context, token string) (User, error) {
	if token == "" {
		return User{}, fmt.Errorf("%w: no bearer token", ErrUnauthenticated)
	}

	cfg, err := kube.UserConfig(r.host, token, r.caCert)
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

	return user, nil
}

// ResolverStub is a test double. It resolves every token to the same user
// unless OnResolve says otherwise.
type ResolverStub struct {
	OnResolve func(ctx context.Context, token string) (User, error)
}

func (s *ResolverStub) ResolveUserIdentity(ctx context.Context, token string) (User, error) {
	// The real resolver refuses an empty token before it reaches the API
	// server. A stub that answered one would let callers pass tests they
	// would fail in production.
	if token == "" {
		return User{}, fmt.Errorf("%w: no bearer token", ErrUnauthenticated)
	}
	if s.OnResolve != nil {
		return s.OnResolve(ctx, token)
	}
	return User{Username: "tester", UID: "tester-uid"}, nil
}
