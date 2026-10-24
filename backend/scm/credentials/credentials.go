// Package auth keeps SCM credentials in Kubernetes Secrets instead of the
// browser. Callers hand it the OpenShift bearer token the console proxy
// forwarded and get a credential back; resolving that token to a user, and
// keying the Secret by it, is this package's own business. The credential
// itself never leaves the backend.
package credentials

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/openshift/faas-console-plugin/backend/identity"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const (
	credentialTTL       = 7 * 24 * time.Hour
	secretNamePrefix    = "scm-cred-"
	secretDataKey       = "credential"
	CredentialTypePAT   = "pat"
	CredentialTypeOAuth = "oauth"
)

var ErrNoCredential = errors.New("no stored credential for user")

type Credential struct {
	Owner     string // SCM username
	AvatarURL string
	Token     string // the PAT or OAuth token itself
	Type      string // CredentialTypePAT or CredentialTypeOAuth
}

type Store struct {
	client    kubernetes.Interface
	namespace string
	resolver  identity.Resolver
}

type secretData struct {
	Credential string        `json:"credential"`
	Type       string        `json:"type"`  // CredentialTypePAT or CredentialTypeOAuth
	Owner      string        `json:"owner"` // GitHub username or other identifier
	AvatarURL  string        `json:"avatarUrl,omitempty"`
	User       identity.User `json:"user"`
	ExpiresAt  time.Time     `json:"expiresAt"`
}

func NewStore(cfg *rest.Config, namespace string, resolver identity.Resolver) (*Store, error) {
	if namespace == "" {
		return nil, fmt.Errorf("credential namespace is required")
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("create kubernetes client: %w", err)
	}
	return NewStoreWithClient(client, namespace, resolver), nil
}

func NewStoreWithClient(client kubernetes.Interface, namespace string, resolver identity.Resolver) *Store {
	return &Store{client: client, namespace: namespace, resolver: resolver}
}

// resolveUser turns the console's bearer token into the user it belongs to.
// Every public method starts here, so a caller can never reach a credential
// without having proved whose it is.
func (s *Store) resolveUser(ctx context.Context, ocpToken string) (identity.User, error) {
	user, err := s.resolver.ResolveUserIdentity(ctx, ocpToken)
	if err != nil {
		return identity.User{}, fmt.Errorf("resolve OpenShift user: %w", err)
	}
	return user, nil
}

func (s *Store) SaveCredential(ctx context.Context, ocpToken string, cred Credential) error {
	user, err := s.resolveUser(ctx, ocpToken)
	if err != nil {
		return err
	}
	return s.write(ctx, user, secretData{
		Credential: cred.Token,
		Type:       cred.Type,
		Owner:      cred.Owner,
		AvatarURL:  cred.AvatarURL,
		User:       user,
		ExpiresAt:  time.Now().Add(credentialTTL),
	})
}

func (s *Store) GetCredential(ctx context.Context, ocpToken string) (Credential, error) {
	user, err := s.resolveUser(ctx, ocpToken)
	if err != nil {
		return Credential{}, err
	}

	data, err := s.read(ctx, user)
	if err != nil {
		return Credential{}, err
	}
	if err := s.dropIfExpired(ctx, user, data); err != nil {
		return Credential{}, err
	}

	return Credential{
		Owner:     data.Owner,
		AvatarURL: data.AvatarURL,
		Token:     data.Credential,
		Type:      data.Type,
	}, nil
}

func (s *Store) DeleteCredential(ctx context.Context, ocpToken string) error {
	user, err := s.resolveUser(ctx, ocpToken)
	if err != nil {
		return err
	}

	return s.deleteFor(ctx, user)
}

func (s *Store) deleteFor(ctx context.Context, user identity.User) error {
	err := s.client.CoreV1().Secrets(s.namespace).Delete(ctx, secretName(user), metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete credential secret: %w", err)
	}
	return nil
}

func (s *Store) read(ctx context.Context, user identity.User) (secretData, error) {
	secret, err := s.client.CoreV1().Secrets(s.namespace).Get(ctx, secretName(user), metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return secretData{}, ErrNoCredential
		}
		return secretData{}, fmt.Errorf("get secret: %w", err)
	}

	dataBytes, ok := secret.Data[secretDataKey]
	if !ok {
		slog.Warn("credential secret has no usable payload", "secret", secret.Name)
		return secretData{}, ErrNoCredential
	}

	var data secretData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return secretData{}, fmt.Errorf("unmarshal credential data: %w", err)
	}

	if !data.User.Matches(user) {
		slog.Warn("stored credential does not belong to the caller",
			"storedUser", data.User.Username, "caller", user.Username)
		return secretData{}, ErrNoCredential
	}

	return data, nil
}

func (s *Store) dropIfExpired(ctx context.Context, user identity.User, data secretData) error {
	if !time.Now().After(data.ExpiresAt) {
		return nil
	}
	if err := s.deleteFor(ctx, user); err != nil {
		slog.Error("failed to delete expired credential", "err", err)
	}
	return ErrNoCredential
}

func (s *Store) write(ctx context.Context, user identity.User, data secretData) error {
	dataBytes, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal secret data: %w", err)
	}

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName(user),
			Namespace: s.namespace,
			Labels: map[string]string{
				"app":  "console-functions-plugin",
				"type": "scm-credential",
			},
		},
		Data: map[string][]byte{
			secretDataKey: dataBytes,
		},
	}

	secrets := s.client.CoreV1().Secrets(s.namespace)
	if _, err := secrets.Create(ctx, secret, metav1.CreateOptions{}); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return fmt.Errorf("create secret: %w", err)
		}
		if _, err := secrets.Update(ctx, secret, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update secret: %w", err)
		}
	}
	return nil
}

func secretName(user identity.User) string {
	key := "uid:" + user.UID
	if user.UID == "" {
		key = "user:" + user.Username
	}
	sum := sha256.Sum256([]byte(key))
	return secretNamePrefix + hex.EncodeToString(sum[:])
}
