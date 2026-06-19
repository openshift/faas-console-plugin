package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestCA generates a self-signed CA certificate and returns the PEM bytes,
// the parsed certificate, and the private key.
func newTestCA(t *testing.T) ([]byte, *x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	return pemBytes, cert, key
}

// newTestLeafCert creates a leaf certificate signed by the given CA.
func newTestLeafCert(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey) tls.Certificate {
	t.Helper()
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  leafKey,
	}
}

// writeCAFile writes PEM data to a temp file and returns its path.
func writeCAFile(t *testing.T, pemData []byte) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(path, pemData, 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestClusterCAHandler_MissingServerParam(t *testing.T) {
	h := &clusterCAHandler{CAPath: "/nonexistent"}
	req := httptest.NewRequest("GET", "/api/cluster/ca", nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["message"] == "" {
		t.Error("expected error message in response")
	}
}

func TestClusterCAHandler_NonHTTPS(t *testing.T) {
	h := &clusterCAHandler{CAPath: "/nonexistent"}
	req := httptest.NewRequest("GET", "/api/cluster/ca?server=http://example.com", nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestClusterCAHandler_MissingCAFile(t *testing.T) {
	// Use a self-signed TLS server so probe 1 (system roots) always fails,
	// ensuring the handler reaches the CA file read path.
	_, caCert, caKey := newTestCA(t)
	leafCert := newTestLeafCert(t, caCert, caKey)

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	ts.TLS = &tls.Config{Certificates: []tls.Certificate{leafCert}}
	ts.StartTLS()
	defer ts.Close()

	h := &clusterCAHandler{CAPath: "/nonexistent/path/ca.crt"}
	req := httptest.NewRequest("GET", "/api/cluster/ca?server="+ts.URL, nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if !strings.Contains(body["message"], "failed to read CA file") {
		t.Errorf("expected 'failed to read CA file' in message, got %q", body["message"])
	}
}

// TestClusterCAHandler_PublicCA verifies that when the server's cert is trusted
// by system roots (probe 1), null is returned even if a CA file is present.
func TestClusterCAHandler_PublicCA(t *testing.T) {
	caPEM, caCert, caKey := newTestCA(t)
	leafCert := newTestLeafCert(t, caCert, caKey)

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	ts.TLS = &tls.Config{Certificates: []tls.Certificate{leafCert}}
	ts.StartTLS()
	defer ts.Close()

	// Inject the CA into "system roots" so probe 1 succeeds.
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPEM)

	h := &clusterCAHandler{
		CAPath: writeCAFile(t, caPEM),
		SystemTLS: func() *tls.Config {
			return &tls.Config{RootCAs: pool}
		},
	}

	req := httptest.NewRequest("GET", "/api/cluster/ca?server="+ts.URL, nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body)
	if body["ca"] != nil {
		t.Errorf("expected ca to be null for publicly trusted cert, got %v", body["ca"])
	}
}

// TestClusterCAHandler_PrivateCA verifies the two-probe logic for a private CA:
// probe 1 (system roots) fails because the test CA is self-signed, then
// probe 2 (SA bundle) succeeds because the CA matches the server cert.
func TestClusterCAHandler_PrivateCA(t *testing.T) {
	caPEM, caCert, caKey := newTestCA(t)
	leafCert := newTestLeafCert(t, caCert, caKey)

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	ts.TLS = &tls.Config{Certificates: []tls.Certificate{leafCert}}
	ts.StartTLS()
	defer ts.Close()

	h := &clusterCAHandler{CAPath: writeCAFile(t, caPEM)}

	req := httptest.NewRequest("GET", "/api/cluster/ca?server="+ts.URL, nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body)
	if body["ca"] == nil {
		t.Fatal("expected ca to be a base64 string, got null")
	}
	caVal, ok := body["ca"].(string)
	if !ok || caVal == "" {
		t.Fatalf("expected non-empty ca string, got %v", body["ca"])
	}
}

// TestClusterCAHandler_EmptyCAFile verifies that an empty CA file returns 500.
func TestClusterCAHandler_EmptyCAFile(t *testing.T) {
	_, caCert, caKey := newTestCA(t)
	leafCert := newTestLeafCert(t, caCert, caKey)

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	ts.TLS = &tls.Config{Certificates: []tls.Certificate{leafCert}}
	ts.StartTLS()
	defer ts.Close()

	h := &clusterCAHandler{CAPath: writeCAFile(t, []byte{})}
	req := httptest.NewRequest("GET", "/api/cluster/ca?server="+ts.URL, nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if !strings.Contains(body["message"], "no valid certificates found") {
		t.Errorf("expected 'no valid certificates found' in message, got %q", body["message"])
	}
}

// TestClusterCAHandler_MalformedCAFile verifies that a CA file with corrupt
// certificate data returns 500.
func TestClusterCAHandler_MalformedCAFile(t *testing.T) {
	_, caCert, caKey := newTestCA(t)
	leafCert := newTestLeafCert(t, caCert, caKey)

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	ts.TLS = &tls.Config{Certificates: []tls.Certificate{leafCert}}
	ts.StartTLS()
	defer ts.Close()

	// PEM block with type CERTIFICATE but garbage DER content.
	badPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte("not valid DER")})

	h := &clusterCAHandler{CAPath: writeCAFile(t, badPEM)}
	req := httptest.NewRequest("GET", "/api/cluster/ca?server="+ts.URL, nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if !strings.Contains(body["message"], "failed to parse CA certificate") {
		t.Errorf("expected 'failed to parse CA certificate' in message, got %q", body["message"])
	}
}

// TestClusterCAHandler_BundleMismatch verifies that when neither system roots
// nor the SA bundle can verify the server, null is returned.
func TestClusterCAHandler_BundleMismatch(t *testing.T) {
	// Create one CA for the server cert.
	_, serverCACert, serverCAKey := newTestCA(t)
	leafCert := newTestLeafCert(t, serverCACert, serverCAKey)

	// Create a different CA that we'll give to the handler.
	differentCAPEM, _, _ := newTestCA(t)

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	ts.TLS = &tls.Config{Certificates: []tls.Certificate{leafCert}}
	ts.StartTLS()
	defer ts.Close()

	h := &clusterCAHandler{CAPath: writeCAFile(t, differentCAPEM)}

	req := httptest.NewRequest("GET", "/api/cluster/ca?server="+ts.URL, nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body)
	if body["ca"] != nil {
		t.Errorf("expected ca to be null when CA doesn't match, got %v", body["ca"])
	}
}
