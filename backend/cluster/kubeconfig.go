package cluster

import (
	"context"
	"fmt"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func GenerateKubeconfig(ctx context.Context, client Client, namespace, externalAPIServerURL string, caCert []byte) (string, error) {
	if externalAPIServerURL == "" {
		return "", fmt.Errorf("API server URL is required")
	}

	if err := client.CreateServiceAccount(ctx, namespace); err != nil {
		return "", fmt.Errorf("create service account: %w", err)
	}
	if err := client.ApplyRole(ctx, namespace); err != nil {
		return "", fmt.Errorf("apply role: %w", err)
	}
	if err := client.CreateRoleBinding(ctx, namespace); err != nil {
		return "", fmt.Errorf("create role binding: %w", err)
	}
	if err := client.CreateImageBuilderBinding(ctx, namespace); err != nil {
		return "", fmt.Errorf("create image builder binding: %w", err)
	}

	token, err := client.RequestToken(ctx, namespace)
	if err != nil {
		return "", fmt.Errorf("request token: %w", err)
	}

	return buildKubeconfig(externalAPIServerURL, token, namespace, caCert)
}

func buildKubeconfig(server, token, namespace string, caCert []byte) (string, error) {
	cluster := &clientcmdapi.Cluster{Server: server}
	if len(caCert) > 0 {
		cluster.CertificateAuthorityData = caCert
	}

	cfg := clientcmdapi.NewConfig()
	cfg.Clusters["cluster"] = cluster
	cfg.AuthInfos[saName] = &clientcmdapi.AuthInfo{Token: token}
	cfg.Contexts[saName] = &clientcmdapi.Context{
		Cluster:   "cluster",
		AuthInfo:  saName,
		Namespace: namespace,
	}
	cfg.CurrentContext = saName

	data, err := clientcmd.Write(*cfg)
	if err != nil {
		return "", fmt.Errorf("marshal kubeconfig: %w", err)
	}
	return string(data), nil
}
