package cluster

import (
	"context"
	"fmt"
	"log/slog"

	authenticationv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/openshift/faas-console-plugin/backend/kube"
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

// DefaultTokenExpiry is the requested SA token lifetime in seconds. Matches the
// previous frontend behaviour. Security concern: a long-lived token in an SCM
// Actions secret increases exposure if leaked; shorter expiry is a follow-up.
const DefaultTokenExpiry int64 = 365 * 24 * 60 * 60 // 1 year

// New creates a cluster client authenticated with token.
// When host is non-empty (dev/test) it is used as the API server URL directly.
// When host is empty the standard in-cluster config is used (pod env vars + SA files).
func New(host, token string, caCert []byte) (Client, error) {
	cfg, err := kube.RESTConfig(host, token, caCert)
	if err != nil {
		return nil, err
	}

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("create kubernetes client: %w", err)
	}
	return &k8sClient{clientset: clientset}, nil
}

type k8sClient struct {
	clientset kubernetes.Interface
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
	expiry := DefaultTokenExpiry
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
