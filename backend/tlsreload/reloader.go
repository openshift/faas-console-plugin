package tlsreload

import (
	"crypto/sha256"
	"crypto/tls"
	"fmt"
	"log/slog"
	"os"
	"sync/atomic"
	"time"
)

const certificateReloadInterval = 5 * time.Minute

type Reloader struct {
	certFile string
	keyFile  string
	current  atomic.Pointer[tls.Certificate]
	lastHash [sha256.Size]byte
}

func New(certFile, keyFile string) (*Reloader, error) {
	reloader := &Reloader{certFile: certFile, keyFile: keyFile}
	if err := reloader.reload(); err != nil {
		return nil, err
	}
	return reloader, nil
}

func (r *Reloader) reload() error {
	certPEM, err := os.ReadFile(r.certFile)
	if err != nil {
		return fmt.Errorf("read TLS certificate: %w", err)
	}
	keyPEM, err := os.ReadFile(r.keyFile)
	if err != nil {
		return fmt.Errorf("read TLS key: %w", err)
	}

	// Skip the parse and swap when the on-disk pair is unchanged.
	digest := sha256.New()
	digest.Write(certPEM)
	digest.Write(keyPEM)
	var hash [sha256.Size]byte
	digest.Sum(hash[:0])
	if r.current.Load() != nil && hash == r.lastHash {
		return nil
	}

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("load TLS certificate: %w", err)
	}
	r.current.Store(&cert)
	r.lastHash = hash

	attrs := []any{"certFile", r.certFile}
	if cert.Leaf != nil {
		attrs = append(attrs, "notAfter", cert.Leaf.NotAfter)
	}
	slog.Info("loaded TLS certificate", attrs...)
	return nil
}

func (r *Reloader) Run() {
	ticker := time.NewTicker(certificateReloadInterval)
	defer ticker.Stop()

	for range ticker.C {
		if err := r.reload(); err != nil {
			slog.Error("failed to reload TLS certificate", "err", err)
		}
	}
}

func (r *Reloader) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	return r.current.Load(), nil
}
