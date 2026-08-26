package tlsreload

import (
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"
)

const certificateReloadInterval = 30 * time.Second

type Reloader struct {
	certFile string
	keyFile  string
	current  atomic.Pointer[tls.Certificate]
}

func New(certFile, keyFile string) (*Reloader, error) {
	reloader := &Reloader{certFile: certFile, keyFile: keyFile}
	if err := reloader.reload(); err != nil {
		return nil, err
	}
	return reloader, nil
}

func (r *Reloader) reload() error {
	cert, err := tls.LoadX509KeyPair(r.certFile, r.keyFile)
	if err != nil {
		return fmt.Errorf("load TLS certificate: %w", err)
	}
	r.current.Store(&cert)
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
	cert := r.current.Load()
	if cert == nil {
		return nil, errors.New("TLS certificate is not loaded")
	}
	return cert, nil
}
