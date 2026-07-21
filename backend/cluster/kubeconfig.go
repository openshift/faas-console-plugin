package cluster

import (
	"fmt"
	"os"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

const inClusterSATokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"

func resolveExternalAPIURL(baseURL string, caCert []byte) (string, error) {
	if baseURL != "" {
		return baseURL, nil
	}
	saToken, err := os.ReadFile(inClusterSATokenPath)
	if err != nil {
		return "", fmt.Errorf("read SA token: %w", err)
	}
	saClient, err := New(string(saToken), "", caCert, 0)
	if err != nil {
		return "", fmt.Errorf("create SA cluster client: %w", err)
	}
	return saClient.GetExternalAPIURL()
}

func GenerateKubeconfig(client Client, namespace, baseURL string, caCert []byte) (string, error) {
	apiServerURL, err := resolveExternalAPIURL(baseURL, caCert)
	if err != nil {
		return "", fmt.Errorf("resolve external API URL: %w", err)
	}

	if err := client.CreateServiceAccount(namespace); err != nil {
		return "", fmt.Errorf("create service account: %w", err)
	}
	if err := client.ApplyRole(namespace); err != nil {
		return "", fmt.Errorf("apply role: %w", err)
	}
	if err := client.CreateRoleBinding(namespace); err != nil {
		return "", fmt.Errorf("create role binding: %w", err)
	}
	if err := client.CreateImageBuilderBinding(namespace); err != nil {
		return "", fmt.Errorf("create image builder binding: %w", err)
	}

	token, err := client.RequestToken(namespace)
	if err != nil {
		return "", fmt.Errorf("request token: %w", err)
	}

	return buildKubeconfig(apiServerURL, token, namespace, caCert)
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
