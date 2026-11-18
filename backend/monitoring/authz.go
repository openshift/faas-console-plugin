package monitoring

// TODO this can eventually be moved to identity package and reuse the constructs from there. Some things may have to be renamed... (authn, authz, reviewer, resolver, etc.)

import (
	"context"
	"fmt"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/openshift/faas-console-plugin/backend/kube"
)

// CanReadNamespace reports whether the caller (identified by callerToken) has
// permission to read pods in the given namespace. This is the per-request
// authorization gate that must pass before a namespace-scoped metric query runs.
//
// A SelfSubjectAccessReview is used: the API server evaluates the check as the
// caller's own identity, so no elevated backend privilege is required.
func CanReadNamespace(ctx context.Context, host string, caCert []byte, callerToken, namespace string) (bool, error) {
	cs, err := callerClientset(host, callerToken, caCert)
	if err != nil {
		return false, err
	}
	return selfSubjectCheck(ctx, cs, namespace)
}

// CanReadClusterWide reports whether the caller has permission to read pods
// cluster-wide (no namespace restriction). Used for the all-namespaces overview.
func CanReadClusterWide(ctx context.Context, host string, caCert []byte, callerToken string) (bool, error) {
	cs, err := callerClientset(host, callerToken, caCert)
	if err != nil {
		return false, err
	}
	return selfSubjectCheck(ctx, cs, "")
}

// ReadableNamespaces returns the names of namespaces where the caller can "get" pods.
// It lists all namespaces visible to the caller's token and returns their names. Because
// Kubernetes only returns namespaces the caller may see, the result is naturally filtered.
func ReadableNamespaces(ctx context.Context, host string, caCert []byte, callerToken string) ([]string, error) {
	cs, err := callerClientset(host, callerToken, caCert)
	if err != nil {
		return nil, err
	}
	list, err := cs.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}
	names := make([]string, 0, len(list.Items))
	for _, ns := range list.Items {
		names = append(names, ns.Name)
	}
	return names, nil
}

// callerClientset builds a Kubernetes clientset using the caller's token.
// This mirrors the pattern used in the existing identity and cluster packages.
func callerClientset(host string, callerToken string, caCert []byte) (kubernetes.Interface, error) {
	cfg, err := kube.UserConfig(host, callerToken, caCert)
	if err != nil {
		return nil, fmt.Errorf("build caller config: %w", err)
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("build caller clientset: %w", err)
	}
	return cs, nil
}

// selfSubjectCheck creates a SelfSubjectAccessReview asking whether the caller
// may "get" pods in the given namespace. An empty namespace means cluster-scoped.
// Returns the API server's Allowed field directly.
func selfSubjectCheck(ctx context.Context, cs kubernetes.Interface, namespace string) (bool, error) {
	review := &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{
			ResourceAttributes: &authorizationv1.ResourceAttributes{
				Namespace: namespace,
				Verb:      "get",
				Resource:  "pods",
			},
		},
	}
	result, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, review, metav1.CreateOptions{})
	if err != nil {
		return false, fmt.Errorf("SelfSubjectAccessReview: %w", err)
	}
	return result.Status.Allowed, nil
}
