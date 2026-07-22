package cluster

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	authenticationv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	saName   = "func-scm"
	roleName = "func-scm-deployer"
)

type Client interface {
	GetExternalAPIURL(ctx context.Context) (string, error)
	CreateServiceAccount(ctx context.Context, namespace string) error
	ApplyRole(ctx context.Context, namespace string) error
	CreateRoleBinding(ctx context.Context, namespace string) error
	CreateImageBuilderBinding(ctx context.Context, namespace string) error
	RequestToken(ctx context.Context, namespace string) (string, error)
}

// DefaultTokenExpiry is the requested SA token lifetime in seconds. Matches the
// previous frontend behaviour. Security concern: a long-lived token in an SCM
// Actions secret increases exposure if leaked; shorter expiry is a follow-up.
const DefaultTokenExpiry int64 = 365 * 24 * 60 * 60 // 1 year

func New(token, baseURL string, caCert []byte, tokenExpiry int64) (Client, error) {
	if baseURL == "" {
		host := os.Getenv("KUBERNETES_SERVICE_HOST")
		port := os.Getenv("KUBERNETES_SERVICE_PORT")
		if host == "" || port == "" {
			return nil, fmt.Errorf("KUBERNETES_SERVICE_HOST or KUBERNETES_SERVICE_PORT not set")
		}
		baseURL = fmt.Sprintf("https://%s:%s", host, port)
	}

	transport := &http.Transport{}
	if len(caCert) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caCert) {
			return nil, fmt.Errorf("failed to parse CA certificate")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool}
	}

	if tokenExpiry == 0 {
		tokenExpiry = DefaultTokenExpiry
	}
	return &httpClient{
		token:       token,
		baseURL:     baseURL,
		client:      &http.Client{Transport: transport, Timeout: 30 * time.Second},
		tokenExpiry: tokenExpiry,
	}, nil
}

type httpClient struct {
	token       string
	baseURL     string
	client      *http.Client
	tokenExpiry int64
}

func (c *httpClient) do(ctx context.Context, method, path string, body, result any) error {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var status metav1.Status
		_ = json.NewDecoder(resp.Body).Decode(&status)
		if status.Code == 0 {
			status.Code = int32(resp.StatusCode)
		}
		return &k8serrors.StatusError{ErrStatus: status}
	}

	if result != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

func (c *httpClient) GetExternalAPIURL(ctx context.Context) (string, error) {
	var result struct {
		Status struct {
			APIServerURL string `json:"apiServerURL"`
		} `json:"status"`
	}
	if err := c.do(ctx, "GET", "/apis/config.openshift.io/v1/infrastructures/cluster", nil, &result); err != nil {
		return "", fmt.Errorf("get infrastructure: %w", err)
	}
	if result.Status.APIServerURL == "" {
		return "", fmt.Errorf("infrastructure API returned empty apiServerURL")
	}
	return result.Status.APIServerURL, nil
}

func (c *httpClient) CreateServiceAccount(ctx context.Context, namespace string) error {
	body := &corev1.ServiceAccount{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "ServiceAccount"},
		ObjectMeta: metav1.ObjectMeta{Name: saName, Namespace: namespace},
	}
	err := c.do(ctx, "POST", fmt.Sprintf("/api/v1/namespaces/%s/serviceaccounts", namespace), body, nil)
	if k8serrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (c *httpClient) ApplyRole(ctx context.Context, namespace string) error {
	url := fmt.Sprintf("/apis/rbac.authorization.k8s.io/v1/namespaces/%s/roles", namespace)
	body := roleBody(namespace)

	err := c.do(ctx, "POST", url, body, nil)
	if err == nil {
		return nil
	}
	if !k8serrors.IsAlreadyExists(err) {
		return err
	}

	var existing rbacv1.Role
	if err := c.do(ctx, "GET", url+"/"+roleName, nil, &existing); err != nil {
		return fmt.Errorf("get existing role: %w", err)
	}
	if existing.ResourceVersion == "" {
		return fmt.Errorf("role metadata missing resourceVersion")
	}
	body.ResourceVersion = existing.ResourceVersion
	return c.do(ctx, "PUT", url+"/"+roleName, body, nil)
}

func (c *httpClient) CreateRoleBinding(ctx context.Context, namespace string) error {
	body := &rbacv1.RoleBinding{
		TypeMeta:   metav1.TypeMeta{APIVersion: "rbac.authorization.k8s.io/v1", Kind: "RoleBinding"},
		ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: namespace},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: saName, Namespace: namespace}},
		RoleRef: rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "Role",
			Name:     roleName,
		},
	}
	err := c.do(ctx, "POST", fmt.Sprintf("/apis/rbac.authorization.k8s.io/v1/namespaces/%s/rolebindings", namespace), body, nil)
	if k8serrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (c *httpClient) CreateImageBuilderBinding(ctx context.Context, namespace string) error {
	name := saName + "-image-builder"
	body := &rbacv1.RoleBinding{
		TypeMeta:   metav1.TypeMeta{APIVersion: "rbac.authorization.k8s.io/v1", Kind: "RoleBinding"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: saName, Namespace: namespace}},
		RoleRef: rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "ClusterRole",
			Name:     "system:image-builder",
		},
	}
	err := c.do(ctx, "POST", fmt.Sprintf("/apis/rbac.authorization.k8s.io/v1/namespaces/%s/rolebindings", namespace), body, nil)
	if k8serrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (c *httpClient) RequestToken(ctx context.Context, namespace string) (string, error) {
	expiry := c.tokenExpiry
	body := &authenticationv1.TokenRequest{
		Spec: authenticationv1.TokenRequestSpec{
			ExpirationSeconds: &expiry,
		},
	}
	var result authenticationv1.TokenRequest
	path := fmt.Sprintf("/api/v1/namespaces/%s/serviceaccounts/%s/token", namespace, saName)
	if err := c.do(ctx, "POST", path, body, &result); err != nil {
		return "", err
	}
	slog.Info("service account token issued", "namespace", namespace, "expires", result.Status.ExpirationTimestamp)
	return result.Status.Token, nil
}

func roleBody(namespace string) *rbacv1.Role {
	allVerbs := []string{"get", "list", "watch", "create", "update", "patch", "delete"}
	return &rbacv1.Role{
		TypeMeta:   metav1.TypeMeta{APIVersion: "rbac.authorization.k8s.io/v1", Kind: "Role"},
		ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: namespace},
		Rules: []rbacv1.PolicyRule{
			{
				APIGroups: []string{""},
				Resources: []string{"pods", "pods/exec", "services", "configmaps"},
				Verbs:     allVerbs,
			},
			{
				APIGroups: []string{"apps"},
				Resources: []string{"deployments"},
				Verbs:     allVerbs,
			},
			{
				APIGroups: []string{"image.openshift.io"},
				Resources: []string{"imagestreams", "imagestreamtags"},
				Verbs:     allVerbs,
			},
			{
				APIGroups: []string{"serving.knative.dev"},
				Resources: []string{"services", "routes", "revisions"},
				Verbs:     allVerbs,
			},
		},
	}
}
