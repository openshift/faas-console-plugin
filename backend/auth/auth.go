// Package auth keeps SCM credentials in Kubernetes Secrets instead of the
// browser. A caller's OpenShift identity is the only key: it names the Secret
// and is verified against the binding inside it, and the credential itself
// never leaves the backend. Who the caller is comes from the auth/identity
// subpackage.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/openshift/faas-console-plugin/backend/auth/identity"
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
	Secret    string // the PAT or OAuth token itself
	Type      string // CredentialTypePAT or CredentialTypeOAuth
}

type Store struct {
	client    kubernetes.Interface
	namespace string
}

type secretData struct {
	Credential string        `json:"credential"`
	Type       string        `json:"type"`  // CredentialTypePAT or CredentialTypeOAuth
	Owner      string        `json:"owner"` // GitHub username or other identifier
	AvatarURL  string        `json:"avatarUrl,omitempty"`
	User       identity.User `json:"user"`
	ExpiresAt  time.Time     `json:"expiresAt"`
}

func NewStore(cfg *rest.Config, namespace string) (*Store, error) {
	if namespace == "" {
		return nil, fmt.Errorf("credential namespace is required")
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("create kubernetes client: %w", err)
	}
	return &Store{client: client, namespace: namespace}, nil
}

func NewStoreWithClient(client kubernetes.Interface, namespace string) *Store {
	return &Store{client: client, namespace: namespace}
}

func (s *Store) SaveCredential(ctx context.Context, user identity.User, cred Credential) error {
	if user.Username == "" {
		return fmt.Errorf("storing a credential requires an OpenShift user")
	}

	return s.write(ctx, user, secretData{
		Credential: cred.Secret,
		Type:       cred.Type,
		Owner:      cred.Owner,
		AvatarURL:  cred.AvatarURL,
		User:       user,
		ExpiresAt:  time.Now().Add(credentialTTL),
	})
}

func (s *Store) GetCredential(ctx context.Context, user identity.User) (Credential, error) {
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
		Secret:    data.Credential,
		Type:      data.Type,
	}, nil
}

func (s *Store) DeleteCredential(ctx context.Context, user identity.User) error {
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
	if err := s.DeleteCredential(ctx, user); err != nil {
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
