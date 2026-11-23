package cluster

import (
	"context"
	"fmt"
	"slices"
	"strings"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var projectsGVR = schema.GroupVersionResource{Group: "project.openshift.io", Version: "v1", Resource: "projects"}

var (
	systemNamespaces        = []string{"openshift", "default"}
	systemNamespacePrefixes = []string{"openshift-", "kube-", "knative-"}
)

// ListProjects returns the names of the projects the caller can see. OpenShift
// scopes the project list to the caller, so this is the set of namespaces the
// user has access to, without needing cluster-wide list on namespaces.
func (c *k8sClient) ListProjects(ctx context.Context) ([]string, error) {
	list, err := c.dynamic.Resource(projectsGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	names := make([]string, 0, len(list.Items))
	for _, p := range list.Items {
		names = append(names, p.GetName())
	}
	return names, nil
}

// CanCreateNamespaces reports whether the caller may create namespaces.
func (c *k8sClient) CanCreateNamespaces(ctx context.Context) (bool, error) {
	review := &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{
			ResourceAttributes: &authorizationv1.ResourceAttributes{Verb: "create", Resource: "namespaces"},
		},
	}
	result, err := c.clientset.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, review, metav1.CreateOptions{})
	if err != nil {
		return false, fmt.Errorf("review namespace create access: %w", err)
	}
	return result.Status.Allowed, nil
}

// IsSystemNamespace reports whether name is a namespace that belongs to the
// platform rather than to user workloads.
func IsSystemNamespace(name string) bool {
	if slices.Contains(systemNamespaces, name) {
		return true
	}
	return slices.ContainsFunc(systemNamespacePrefixes, func(prefix string) bool {
		return strings.HasPrefix(name, prefix)
	})
}
