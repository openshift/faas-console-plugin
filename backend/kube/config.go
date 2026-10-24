package kube

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

const requestTimeout = 30 * time.Second

// namespaceFile is projected into every pod by the ServiceAccount admission
// controller, so a pod can always read which namespace it is in.
const namespaceFile = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"

// Namespace reports the namespace the backend runs in, falling back to
// fallback when there is no pod to ask. Reading the projected file rather than
// an env var means nothing has to be wired into the Deployment, so the Helm
// chart and the operator cannot drift apart on it.
func Namespace(fallback string) string {
	data, err := os.ReadFile(namespaceFile)
	if err != nil {
		return fallback
	}
	if ns := strings.TrimSpace(string(data)); ns != "" {
		return ns
	}
	return fallback
}

// UserConfig talks to the cluster as the caller, using the bearer token the
// console proxy forwarded.
func UserConfig(host, token string, caCert []byte) (*rest.Config, error) {
	var cfg *rest.Config
	var err error

	if host != "" {
		cfg = &rest.Config{Host: host, BearerToken: token}
		if len(caCert) > 0 {
			cfg.TLSClientConfig = rest.TLSClientConfig{CAData: caCert}
		}
	} else {
		cfg, err = rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("in-cluster config: %w", err)
		}
		cfg.BearerToken = token
		cfg.BearerTokenFile = ""
	}
	cfg.ContentConfig = rest.ContentConfig{
		ContentType:        "application/json",
		AcceptContentTypes: "application/json",
	}
	cfg.Timeout = requestTimeout
	return cfg, nil
}

// ComponentConfig talks to the cluster as the backend itself, for work that is
// not done on a caller's behalf. Whether that means a mounted ServiceAccount
// token or a kubeconfig is detected rather than configured: a flag saying
// which to use is one more thing that can disagree with reality.
func ComponentConfig() (*rest.Config, error) {
	cfg, err := rest.InClusterConfig()
	if errors.Is(err, rest.ErrNotInCluster) {
		rules := clientcmd.NewDefaultClientConfigLoadingRules()
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{}).ClientConfig()
		if err != nil {
			return nil, fmt.Errorf("load kubeconfig: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("in-cluster config: %w", err)
	}

	cfg.ContentConfig = rest.ContentConfig{ContentType: "application/json"}
	cfg.Timeout = requestTimeout
	return cfg, nil
}
