package kube

import (
	"fmt"
	"time"

	"k8s.io/client-go/rest"
)

const requestTimeout = 30 * time.Second

func RESTConfig(host, token string, caCert []byte) (*rest.Config, error) {
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
