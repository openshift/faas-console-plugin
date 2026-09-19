package cluster

import (
	"fmt"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func GenerateKubeconfig(namespace, externalAPIServerURL, token string, caCert []byte) (string, error) {
	if externalAPIServerURL == "" {
		return "", fmt.Errorf("API server URL is required")
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
