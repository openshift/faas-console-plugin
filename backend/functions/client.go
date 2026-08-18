package functions

import (
	"context"
	"fmt"

	"k8s.io/client-go/rest"
	fn "knative.dev/func/pkg/functions"
	"knative.dev/func/pkg/k8s"
	"knative.dev/func/pkg/knative"

	"github.com/openshift/faas-console-plugin/backend/kube"
)

// Client queries and manages functions deployed to the cluster.
type Client interface {
	List(ctx context.Context, namespace string) ([]fn.ListItem, error)
}

var newKnativeLister = func(cfg *rest.Config) fn.Lister {
	return knative.NewLister(k8s.NewClientFromConfig(cfg), false)
}

type client struct {
	cfg *rest.Config
}

func NewClient(host, token string, caCert []byte) (Client, error) {
	cfg, err := kube.RESTConfig(host, token, caCert)
	if err != nil {
		return nil, err
	}
	return &client{cfg: cfg}, nil
}

func (c *client) List(ctx context.Context, namespace string) ([]fn.ListItem, error) {
	items, err := newKnativeLister(c.cfg).List(ctx, namespace)
	if err != nil {
		return nil, fmt.Errorf("list cluster functions: %w", err)
	}
	return items, nil
}
