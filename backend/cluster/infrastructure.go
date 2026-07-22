package cluster

import (
	"context"
	"fmt"
	"os"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

var inClusterSATokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"

func resolveExternalAPIURL(ctx context.Context, baseURL string, caCert []byte) (string, error) {
	if baseURL != "" {
		return baseURL, nil
	}
	saToken, err := os.ReadFile(inClusterSATokenPath)
	if err != nil {
		return "", fmt.Errorf("read SA token: %w", err)
	}
	return getExternalAPIURL(ctx, string(saToken), caCert)
}

var infrastructureGVR = schema.GroupVersionResource{
	Group:    "config.openshift.io",
	Version:  "v1",
	Resource: "infrastructures",
}

// getExternalAPIURL fetches the cluster's public API server URL from the
// Infrastructure CR using the provided SA token and CA cert.
// It is a standalone function (not on Client) because it is only called once,
// on demand, from resolveExternalAPIURL in kubeconfig.go.
func getExternalAPIURL(ctx context.Context, saToken string, caCert []byte) (string, error) {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return "", fmt.Errorf("KUBERNETES_SERVICE_HOST or KUBERNETES_SERVICE_PORT not set")
	}
	cfg := &rest.Config{
		Host:        fmt.Sprintf("https://%s:%s", host, port),
		BearerToken: saToken,
		ContentConfig: rest.ContentConfig{
			ContentType:        "application/json",
			AcceptContentTypes: "application/json",
		},
	}
	if len(caCert) > 0 {
		cfg.TLSClientConfig = rest.TLSClientConfig{CAData: caCert}
	}
	dynClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return "", fmt.Errorf("create dynamic client: %w", err)
	}
	return fetchExternalAPIURL(ctx, dynClient)
}

func fetchExternalAPIURL(ctx context.Context, dynClient dynamic.Interface) (string, error) {
	obj, err := dynClient.Resource(infrastructureGVR).Get(ctx, "cluster", metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("get infrastructure: %w", err)
	}
	status, _ := obj.Object["status"].(map[string]interface{})
	apiServerURL, _ := status["apiServerURL"].(string)
	if apiServerURL == "" {
		return "", fmt.Errorf("infrastructure API returned empty apiServerURL")
	}
	return apiServerURL, nil
}
