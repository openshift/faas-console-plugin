package cluster

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/openshift/faas-console-plugin/backend/kube"
	authenticationv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const (
	saName   = "func-scm"
	roleName = "func-scm-deployer"
)

type Client interface {
	CreateServiceAccount(ctx context.Context, namespace string) (bool, error)
	DeleteServiceAccount(ctx context.Context, namespace string) error
	ApplyRole(ctx context.Context, namespace string) (bool, error)
	DeleteRole(ctx context.Context, namespace string) error
	CreateRoleBinding(ctx context.Context, namespace string) (bool, error)
	DeleteRoleBinding(ctx context.Context, namespace string) error
	CreateImageBuilderBinding(ctx context.Context, namespace string) (bool, error)
	DeleteImageBuilderBinding(ctx context.Context, namespace string) error
	RequestToken(ctx context.Context, namespace string) (string, error)
}

// DefaultTokenExpiry is the requested SA token lifetime in seconds when no
// override is configured. Kept short to limit exposure of the token stored in
// an SCM Actions secret if leaked. Override via the SA_TOKEN_EXPIRY env var
// (a duration such as 30d, 10h, or 7d12h); see ParseTokenExpiry.
const DefaultTokenExpiry int64 = 30 * 24 * 60 * 60 // 30 days

// errExpiryFormat describes the accepted SA_TOKEN_EXPIRY notation.
var errExpiryFormat = errors.New("must be a duration such as 30d, 10h, or 7d12h")

// ParseTokenExpiry converts the SA_TOKEN_EXPIRY value into a token lifetime in
// seconds. The value is a duration in common notation, e.g. 30d, 10h, or
// 7d12h. The 'd' (days) unit extends Go's standard duration units (h, m, s).
// An empty value yields DefaultTokenExpiry.
func ParseTokenExpiry(s string) (int64, error) {
	if s == "" {
		return DefaultTokenExpiry, nil
	}
	d, err := parseExpiryDuration(s)
	if err != nil {
		return 0, fmt.Errorf("invalid token expiry %q: %w", s, err)
	}
	secs := int64(d / time.Second)
	if secs <= 0 {
		return 0, fmt.Errorf("invalid token expiry %q: must be at least one second", s)
	}
	return secs, nil
}

// parseExpiryDuration parses a duration that may include a leading days
// component (e.g. 7d or 7d12h). time.ParseDuration handles h/m/s but not d.
func parseExpiryDuration(s string) (time.Duration, error) {
	var total time.Duration
	rest := s
	if i := strings.IndexByte(rest, 'd'); i >= 0 {
		days, err := strconv.Atoi(rest[:i])
		if err != nil {
			return 0, errExpiryFormat
		}
		total += time.Duration(days) * 24 * time.Hour
		rest = rest[i+1:]
	}
	if rest != "" {
		d, err := time.ParseDuration(rest)
		if err != nil {
			return 0, errExpiryFormat
		}
		total += d
	}
	return total, nil
}

// New creates a cluster client authenticated with token. tokenExpiry is the
// requested SA token lifetime in seconds (see ParseTokenExpiry).
// When host is non-empty (dev/test) it is used as the API server URL directly.
// When host is empty the standard in-cluster config is used (pod env vars + SA files).
func New(host, token string, caCert []byte, tokenExpiry int64) (Client, error) {
	cfg, err := kube.RESTConfig(host, token, caCert)
	if err != nil {
		return nil, err
	}

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("create kubernetes client: %w", err)
	}
	return &k8sClient{clientset: clientset, tokenExpiry: tokenExpiry}, nil
}

type k8sClient struct {
	clientset   kubernetes.Interface
	tokenExpiry int64 // requested SA token lifetime in seconds
}

func (c *k8sClient) CreateServiceAccount(ctx context.Context, namespace string) (bool, error) {
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: saName, Namespace: namespace},
	}
	_, err := c.clientset.CoreV1().ServiceAccounts(namespace).Create(ctx, sa, metav1.CreateOptions{})
	if k8serrors.IsAlreadyExists(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("create service account: %w", err)
	}
	return true, nil
}

func (c *k8sClient) DeleteServiceAccount(ctx context.Context, namespace string) error {
	err := c.clientset.CoreV1().ServiceAccounts(namespace).Delete(ctx, saName, metav1.DeleteOptions{})
	if k8serrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("delete service account: %w", err)
	}
	return nil
}

func (c *k8sClient) ApplyRole(ctx context.Context, namespace string) (bool, error) {
	body := roleBody(namespace)
	_, err := c.clientset.RbacV1().Roles(namespace).Create(ctx, body, metav1.CreateOptions{})
	if err == nil {
		return true, nil
	}
	if !k8serrors.IsAlreadyExists(err) {
		return false, fmt.Errorf("create role: %w", err)
	}

	existing, err := c.clientset.RbacV1().Roles(namespace).Get(ctx, roleName, metav1.GetOptions{})
	if err != nil {
		return false, fmt.Errorf("get existing role: %w", err)
	}
	if existing.ResourceVersion == "" {
		return false, fmt.Errorf("role metadata missing resourceVersion")
	}
	body.ResourceVersion = existing.ResourceVersion
	if _, err = c.clientset.RbacV1().Roles(namespace).Update(ctx, body, metav1.UpdateOptions{}); err != nil {
		return false, fmt.Errorf("update role: %w", err)
	}
	return false, nil
}

func (c *k8sClient) DeleteRole(ctx context.Context, namespace string) error {
	err := c.clientset.RbacV1().Roles(namespace).Delete(ctx, roleName, metav1.DeleteOptions{})
	if k8serrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("delete role: %w", err)
	}
	return nil
}

func (c *k8sClient) CreateRoleBinding(ctx context.Context, namespace string) (bool, error) {
	rb := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: namespace},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: saName, Namespace: namespace}},
		RoleRef: rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "Role",
			Name:     roleName,
		},
	}
	_, err := c.clientset.RbacV1().RoleBindings(namespace).Create(ctx, rb, metav1.CreateOptions{})
	if k8serrors.IsAlreadyExists(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("create role binding: %w", err)
	}
	return true, nil
}

func (c *k8sClient) DeleteRoleBinding(ctx context.Context, namespace string) error {
	err := c.clientset.RbacV1().RoleBindings(namespace).Delete(ctx, roleName, metav1.DeleteOptions{})
	if k8serrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("delete role binding: %w", err)
	}
	return nil
}

func (c *k8sClient) CreateImageBuilderBinding(ctx context.Context, namespace string) (bool, error) {
	name := saName + "-image-builder"
	rb := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: saName, Namespace: namespace}},
		RoleRef: rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "ClusterRole",
			Name:     "system:image-builder",
		},
	}
	_, err := c.clientset.RbacV1().RoleBindings(namespace).Create(ctx, rb, metav1.CreateOptions{})
	if k8serrors.IsAlreadyExists(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("create image builder binding: %w", err)
	}
	return true, nil
}

func (c *k8sClient) DeleteImageBuilderBinding(ctx context.Context, namespace string) error {
	name := saName + "-image-builder"
	err := c.clientset.RbacV1().RoleBindings(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if k8serrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("delete image builder binding: %w", err)
	}
	return nil
}

func (c *k8sClient) RequestToken(ctx context.Context, namespace string) (string, error) {
	expiry := c.tokenExpiry
	result, err := c.clientset.CoreV1().ServiceAccounts(namespace).CreateToken(ctx, saName, &authenticationv1.TokenRequest{
		Spec: authenticationv1.TokenRequestSpec{
			ExpirationSeconds: &expiry,
		},
	}, metav1.CreateOptions{})
	if err != nil {
		return "", fmt.Errorf("request token: %w", err)
	}
	slog.Info("service account token issued", "namespace", namespace, "expires", result.Status.ExpirationTimestamp)
	return result.Status.Token, nil
}

type ClientStub struct {
	OnCreateServiceAccount      func(ctx context.Context, namespace string) (bool, error)
	OnApplyRole                 func(ctx context.Context, namespace string) (bool, error)
	OnCreateRoleBinding         func(ctx context.Context, namespace string) (bool, error)
	OnCreateImageBuilderBinding func(ctx context.Context, namespace string) (bool, error)
	OnRequestToken              func(ctx context.Context, namespace string) (string, error)
	OnDeleteServiceAccount      func(ctx context.Context, namespace string) error
	OnDeleteRole                func(ctx context.Context, namespace string) error
	OnDeleteRoleBinding         func(ctx context.Context, namespace string) error
	OnDeleteImageBuilderBinding func(ctx context.Context, namespace string) error
}

func (s *ClientStub) CreateServiceAccount(ctx context.Context, namespace string) (bool, error) {
	if s.OnCreateServiceAccount != nil {
		return s.OnCreateServiceAccount(ctx, namespace)
	}
	return true, nil
}

func (s *ClientStub) ApplyRole(ctx context.Context, namespace string) (bool, error) {
	if s.OnApplyRole != nil {
		return s.OnApplyRole(ctx, namespace)
	}
	return true, nil
}

func (s *ClientStub) CreateRoleBinding(ctx context.Context, namespace string) (bool, error) {
	if s.OnCreateRoleBinding != nil {
		return s.OnCreateRoleBinding(ctx, namespace)
	}
	return true, nil
}

func (s *ClientStub) CreateImageBuilderBinding(ctx context.Context, namespace string) (bool, error) {
	if s.OnCreateImageBuilderBinding != nil {
		return s.OnCreateImageBuilderBinding(ctx, namespace)
	}
	return true, nil
}

func (s *ClientStub) RequestToken(ctx context.Context, namespace string) (string, error) {
	if s.OnRequestToken != nil {
		return s.OnRequestToken(ctx, namespace)
	}
	return "stub-token", nil
}

func (s *ClientStub) DeleteServiceAccount(ctx context.Context, namespace string) error {
	if s.OnDeleteServiceAccount != nil {
		return s.OnDeleteServiceAccount(ctx, namespace)
	}
	return nil
}

func (s *ClientStub) DeleteRole(ctx context.Context, namespace string) error {
	if s.OnDeleteRole != nil {
		return s.OnDeleteRole(ctx, namespace)
	}
	return nil
}

func (s *ClientStub) DeleteRoleBinding(ctx context.Context, namespace string) error {
	if s.OnDeleteRoleBinding != nil {
		return s.OnDeleteRoleBinding(ctx, namespace)
	}
	return nil
}

func (s *ClientStub) DeleteImageBuilderBinding(ctx context.Context, namespace string) error {
	if s.OnDeleteImageBuilderBinding != nil {
		return s.OnDeleteImageBuilderBinding(ctx, namespace)
	}
	return nil
}

func roleBody(namespace string) *rbacv1.Role {
	allVerbs := []string{"get", "list", "watch", "create", "update", "patch", "delete"}
	return &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: namespace},
		Rules: []rbacv1.PolicyRule{
			{
				APIGroups: []string{""},
				Resources: []string{"pods", "pods/exec", "services", "configmaps"},
				Verbs:     allVerbs,
			},
			{
				APIGroups: []string{""},
				Resources: []string{"secrets", "serviceaccounts"},
				Verbs:     []string{"get", "list", "watch"},
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
