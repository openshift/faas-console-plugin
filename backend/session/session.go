// Package session keeps SCM credentials in Kubernetes Secrets instead of the
// browser. A caller trades a session token plus its OpenShift identity for the
// credential; the credential itself never leaves the backend.
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	credentialTTL       = 24 * time.Hour
	sessionTTL          = time.Hour
	tokenLength         = 16
	secretNamePrefix    = "scm-cred-"
	CredentialTypePAT   = "pat"
	CredentialTypeOAuth = "oauth"
)

var ErrNoCredential = errors.New("no stored credential for user")

var ErrInvalidSession = errors.New("invalid or expired session token")

type Credential struct {
	Owner     string // SCM username
	AvatarURL string
	Secret    string // the PAT or OAuth token itself
	Type      string // CredentialTypePAT or CredentialTypeOAuth
}

type Session struct {
	Token     string
	Owner     string
	AvatarURL string
}

type Store struct {
	client    kubernetes.Interface
	namespace string
}

type secretData struct {
	Credential       string        `json:"credential"`
	Type             string        `json:"type"`  // CredentialTypePAT or CredentialTypeOAuth
	Owner            string        `json:"owner"` // GitHub username or other identifier
	AvatarURL        string        `json:"avatarUrl,omitempty"`
	User             identity.User `json:"user"`
	SessionToken     string        `json:"sessionToken"`
	SessionExpiresAt time.Time     `json:"sessionExpiresAt"`
	ExpiresAt        time.Time     `json:"expiresAt"`
}

func NewStore(cfg *rest.Config, namespace string) (*Store, error) {
	if namespace == "" {
		return nil, fmt.Errorf("session namespace is required")
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

func (s *Store) CreateSession(ctx context.Context, user identity.User, cred Credential) (string, error) {
	if user.Username == "" {
		return "", fmt.Errorf("session requires an OpenShift user")
	}

	token, err := generateToken()
	if err != nil {
		return "", err
	}

	now := time.Now()
	err = s.write(ctx, user, secretData{
		Credential:       cred.Secret,
		Type:             cred.Type,
		Owner:            cred.Owner,
		AvatarURL:        cred.AvatarURL,
		User:             user,
		SessionToken:     token,
		SessionExpiresAt: now.Add(sessionTTL),
		ExpiresAt:        now.Add(credentialTTL),
	})
	if err != nil {
		return "", err
	}

	return token, nil
}

func (s *Store) GetCredential(ctx context.Context, token string, user identity.User) (Credential, error) {
	data, err := s.readOwned(ctx, user)
	if err != nil {
		return Credential{}, err
	}
	if subtle.ConstantTimeCompare([]byte(data.SessionToken), []byte(token)) != 1 {
		return Credential{}, fmt.Errorf("%w: token does not match the one issued", ErrInvalidSession)
	}
	if time.Now().After(data.SessionExpiresAt) {
		return Credential{}, fmt.Errorf("%w: past sessionExpiresAt", ErrInvalidSession)
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

func (s *Store) Reissue(ctx context.Context, user identity.User) (Session, error) {
	data, err := s.readOwned(ctx, user)
	if err != nil {
		return Session{}, err
	}
	if err := s.dropIfExpired(ctx, user, data); err != nil {
		return Session{}, err
	}

	if time.Now().After(data.SessionExpiresAt) {
		token, err := generateToken()
		if err != nil {
			return Session{}, err
		}
		data.SessionToken = token
		data.SessionExpiresAt = time.Now().Add(sessionTTL)
		if err := s.write(ctx, user, data); err != nil {
			return Session{}, err
		}
	}

	return Session{Token: data.SessionToken, Owner: data.Owner, AvatarURL: data.AvatarURL}, nil
}

func (s *Store) DeleteSession(ctx context.Context, user identity.User) error {
	err := s.client.CoreV1().Secrets(s.namespace).Delete(ctx, secretName(user), metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete session secret: %w", err)
	}
	return nil
}

// readOwned reads the user's stored credential and re-checks the binding
// written into it. The Secret is named after a hash of the identity, so a
// deleted and recreated account could land on the same name; the binding is
// verified, never inferred from where the Secret was found.
func (s *Store) readOwned(ctx context.Context, user identity.User) (secretData, error) {
	secret, err := s.client.CoreV1().Secrets(s.namespace).Get(ctx, secretName(user), metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return secretData{}, ErrNoCredential
		}
		return secretData{}, fmt.Errorf("get secret: %w", err)
	}

	dataBytes, ok := secret.Data["session"]
	if !ok {
		return secretData{}, fmt.Errorf("session data not found in secret")
	}

	var data secretData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return secretData{}, fmt.Errorf("unmarshal session data: %w", err)
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
	// Best effort cleanup: the caller is rejected either way.
	if err := s.DeleteSession(ctx, user); err != nil {
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
				"type": "session",
			},
		},
		Data: map[string][]byte{
			"session": dataBytes,
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

func generateToken() (string, error) {
	b := make([]byte, tokenLength)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func secretName(user identity.User) string {
	key := "uid:" + user.UID
	if user.UID == "" {
		key = "user:" + user.Username
	}
	sum := sha256.Sum256([]byte(key))
	return secretNamePrefix + hex.EncodeToString(sum[:])
}
