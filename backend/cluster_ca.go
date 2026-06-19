package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"
)

const defaultCAPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

// clusterCAHandler probes the API server's TLS certificate to decide whether
// to return the service account CA bundle for embedding in a kubeconfig.
type clusterCAHandler struct {
	// CAPath is the path to the service account CA certificate file.
	CAPath string
	// SystemTLS returns the TLS config used for the system roots probe.
	// When nil, an empty tls.Config (system trust store) is used.
	SystemTLS func() *tls.Config

	caOnce sync.Once
	caPEM  []byte
	caPool *x509.CertPool
	caErr  string
}

func (h *clusterCAHandler) systemTLSConfig() *tls.Config {
	if h.SystemTLS != nil {
		return h.SystemTLS()
	}
	return &tls.Config{}
}

// loadCA reads and parses the CA file, storing results on the struct.
func (h *clusterCAHandler) loadCA() {
	data, err := os.ReadFile(h.CAPath)
	if err != nil {
		h.caErr = "failed to read CA file: " + err.Error()
		return
	}

	pool := x509.NewCertPool()
	rest := data
	var found bool
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}

		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			h.caErr = "failed to parse CA certificate: " + err.Error()
			return
		}
		pool.AddCert(cert)
		found = true
	}
	if !found {
		h.caErr = "no valid certificates found in CA file"
		return
	}

	h.caPEM = data
	h.caPool = pool
}

func (h *clusterCAHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	serverParam := r.URL.Query().Get("server")
	if serverParam == "" {
		jsonError(w, "missing required query parameter: server", http.StatusBadRequest)
		return
	}

	parsed, err := url.Parse(serverParam)
	if err != nil || parsed.Scheme != "https" {
		jsonError(w, "server must be an HTTPS URL", http.StatusBadRequest)
		return
	}

	host := parsed.Host
	if parsed.Port() == "" {
		host = host + ":443"
	}

	// Probe 1: try system trust store. If the server's cert is publicly
	// trusted, there is no need to embed a CA in the kubeconfig.
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	if conn, err := tls.DialWithDialer(dialer, "tcp", host, h.systemTLSConfig()); err == nil {
		conn.Close()
		jsonOK(w, map[string]interface{}{"ca": nil})
		return
	}

	// Probe 2: try the service account CA bundle. If it verifies the
	// server, the cert is privately signed and the runner will need it.
	h.caOnce.Do(h.loadCA)
	if h.caErr != "" {
		jsonError(w, h.caErr, http.StatusInternalServerError)
		return
	}

	conn, err := tls.DialWithDialer(dialer, "tcp", host, &tls.Config{
		RootCAs: h.caPool,
	})
	if err != nil {
		// Neither system roots nor the SA bundle can verify the server.
		jsonOK(w, map[string]interface{}{"ca": nil})
		return
	}
	conn.Close()

	encoded := base64.StdEncoding.EncodeToString(h.caPEM)
	jsonOK(w, map[string]string{"ca": encoded})
}
