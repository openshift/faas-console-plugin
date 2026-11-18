package monitoring

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/prometheus/client_golang/api"
	v1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
	"k8s.io/client-go/rest"
)

// Client is a Thanos/Prometheus query client that authenticates with a rotating token.
// It queries the cluster Thanos port on behalf of the backend's own identity.
type Client struct {
	api v1.API
}

// bearerRT wraps an http.RoundTripper, injecting a fresh bearer token on each request.
// This supports in-cluster SA token rotation: the token file is re-read per request.
type bearerRT struct {
	base        http.RoundTripper
	tokenSource func() (string, error)
}

func (rt *bearerRT) RoundTrip(req *http.Request) (*http.Response, error) {
	token, err := rt.tokenSource()
	if err != nil {
		return nil, fmt.Errorf("get bearer token: %w", err)
	}
	// Clone the request to avoid mutating the original.
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+token)
	resp, err := rt.base.RoundTrip(clone)
	if err != nil {
		return nil, fmt.Errorf("thanos round trip: %w", err)
	}
	return resp, nil
}

// TokenSourceFromConfig returns a function that reads the bearer token from cfg.
// When cfg.BearerTokenFile is set (in-cluster SA projection), the file is read
// fresh on every call to pick up rotated tokens. Otherwise, cfg.BearerToken is returned.
func TokenSourceFromConfig(cfg *rest.Config) func() (string, error) {
	if cfg.BearerTokenFile != "" {
		path := cfg.BearerTokenFile
		return func() (string, error) {
			data, err := os.ReadFile(path)
			if err != nil {
				return "", fmt.Errorf("read bearer token file %s: %w", path, err)
			}
			return strings.TrimSpace(string(data)), nil
		}
	}
	token := cfg.BearerToken
	return func() (string, error) { return token, nil }
}

// NewClient builds a Thanos query client.
// thanosURL is the base URL of the Thanos querier (e.g. https://thanos-querier.openshift-monitoring.svc:9091).
// caCertPath is the path to a CA bundle for TLS verification (service-ca in-cluster,
// ingress CA off-cluster); it is required - verification cannot be skipped.
// tokenSource is called on every request to supply a fresh bearer token.
func NewClient(thanosURL string, caCertPath string, tokenSource func() (string, error)) (*Client, error) {
	if caCertPath == "" {
		return nil, fmt.Errorf("Thanos CA cert path is required (TLS verification cannot be skipped)")
	}
	pem, err := os.ReadFile(caCertPath)
	if err != nil {
		return nil, fmt.Errorf("read Thanos CA cert %s: %w", caCertPath, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("no valid certificates found in %s", caCertPath)
	}
	tlsCfg := &tls.Config{RootCAs: pool}

	transport := &bearerRT{
		base: &http.Transport{
			TLSClientConfig: tlsCfg,
		},
		tokenSource: tokenSource,
	}

	c, err := api.NewClient(api.Config{
		Address:      thanosURL,
		RoundTripper: transport,
	})
	if err != nil {
		return nil, fmt.Errorf("create Thanos API client: %w", err)
	}

	return &Client{api: v1.NewAPI(c)}, nil
}

// QueryRange executes a range query against Thanos and returns the result matrix.
// Warnings and informational annotations from v1.25.0 are discarded.
func (c *Client) QueryRange(ctx context.Context, query string, start, end time.Time, step time.Duration) (model.Matrix, error) {
	r := v1.Range{Start: start, End: end, Step: step}
	val, _, _, err := c.api.QueryRange(ctx, query, r)
	if err != nil {
		return nil, fmt.Errorf("thanos QueryRange: %w", err)
	}
	matrix, ok := val.(model.Matrix)
	if !ok {
		return nil, fmt.Errorf("unexpected Thanos result type: %T", val)
	}
	return matrix, nil
}
