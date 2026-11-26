package cluster

import (
	"context"
	"fmt"
	"slices"

	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// KeyedResource is a Secret or ConfigMap reduced to its name and key names.
// Values are never included.
type KeyedResource struct {
	Name string   `json:"name"`
	Keys []string `json:"keys"`
}

// ListSecrets returns the Secrets in namespace with their key names only.
// Listing in a namespace that does not exist returns an empty list.
func (c *k8sClient) ListSecrets(ctx context.Context, namespace string) ([]KeyedResource, error) {
	list, err := c.clientset.CoreV1().Secrets(namespace).List(ctx, metav1.ListOptions{})
	if k8serrors.IsForbidden(err) {
		return nil, ErrNamespaceForbidden
	}
	if err != nil {
		return nil, fmt.Errorf("list secrets in %s: %w", namespace, err)
	}
	result := make([]KeyedResource, 0, len(list.Items))
	for _, s := range list.Items {
		result = append(result, KeyedResource{Name: s.Name, Keys: keyNames(s.Data)})
	}
	return result, nil
}

// ListConfigMaps returns the ConfigMaps in namespace with their key names only.
// Listing in a namespace that does not exist returns an empty list. Only data keys
// are returned: the kubelet resolves a configMapKeyRef env var from data, never
// from binaryData, so a binaryData key would fail the pod at start.
func (c *k8sClient) ListConfigMaps(ctx context.Context, namespace string) ([]KeyedResource, error) {
	list, err := c.clientset.CoreV1().ConfigMaps(namespace).List(ctx, metav1.ListOptions{})
	if k8serrors.IsForbidden(err) {
		return nil, ErrNamespaceForbidden
	}
	if err != nil {
		return nil, fmt.Errorf("list config maps in %s: %w", namespace, err)
	}
	result := make([]KeyedResource, 0, len(list.Items))
	for _, cm := range list.Items {
		result = append(result, KeyedResource{Name: cm.Name, Keys: keyNames(cm.Data)})
	}
	return result, nil
}

// keyNames returns the sorted keys of m, as an empty (not nil) slice when m is
// empty so they serialize as [] rather than null.
func keyNames[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
