package tlsreload

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
)

const defaultReloadInterval = 30 * time.Second
const watchRestartDelay = 3 * time.Second

var newWatcher = fsnotify.NewWatcher

// Reloader serves a TLS certificate that is reloaded from disk when the backing
// files change, detected with fsnotify and, as a fallback, by polling.
type Reloader struct {
	certFile string
	keyFile  string
	current  atomic.Pointer[tls.Certificate]
	lastHash [sha256.Size]byte
}

// New creates a Reloader and performs the initial load. It returns an error if
// the certificate or key cannot be read or parsed.
func New(certFile, keyFile string) (*Reloader, error) {
	reloader := &Reloader{
		certFile: certFile,
		keyFile:  keyFile,
	}
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
		return fmt.Errorf("parse TLS key pair: %w", err)
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

// Run watches the certificate files and reloads them on change until ctx is
// cancelled, recreating the watcher if it fails.
func (r *Reloader) Run(ctx context.Context) {
	ticker := time.NewTicker(defaultReloadInterval)
	defer ticker.Stop()

	for {
		if err := r.watch(ctx, ticker.C); err != nil {
			slog.Warn("TLS certificate watch failed, polling while restarting", "err", err)
		}
		restart := time.NewTimer(watchRestartDelay)
	retry:
		for {
			select {
			case <-ctx.Done():
				restart.Stop()
				return
			case <-restart.C:
				break retry
			case <-ticker.C:
				if err := r.reload(); err != nil {
					slog.Error("failed to reload TLS certificate (poll)", "err", err)
				}
			}
		}
	}
}

func (r *Reloader) watch(ctx context.Context, ticks <-chan time.Time) error {
	watcher, err := newWatcher()
	if err != nil {
		return fmt.Errorf("create fsnotify watcher: %w", err)
	}
	defer watcher.Close()

	for _, file := range []string{r.certFile, r.keyFile} {
		if err := watcher.Add(file); err != nil {
			return fmt.Errorf("watch %s: %w", file, err)
		}
	}

	for {
		select {
		case <-ctx.Done():
			return nil

		case event, ok := <-watcher.Events:
			if !ok {
				return errors.New("fsnotify events channel closed")
			}
			r.handleEvent(watcher, event)

		case err, ok := <-watcher.Errors:
			if !ok {
				return errors.New("fsnotify errors channel closed")
			}
			return fmt.Errorf("fsnotify error: %w", err)

		case <-ticks:
			if err := r.reload(); err != nil {
				slog.Error("failed to reload TLS certificate (poll)", "err", err)
			}
		}
	}
}

func (r *Reloader) handleEvent(watcher *fsnotify.Watcher, event fsnotify.Event) {
	// A removed or renamed file (as on a Kubernetes Secret rotation) needs the
	// watch re-added to the replacement.
	if event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename) {
		if err := watcher.Add(event.Name); err != nil {
			slog.Error("failed to re-watch TLS certificate file", "file", event.Name, "err", err)
		}
	}
	if err := r.reload(); err != nil {
		slog.Error("failed to reload TLS certificate", "err", err)
	}
}

// GetCertificate returns the current certificate for tls.Config.GetCertificate,
// or an error if none has been loaded.
func (r *Reloader) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	cert := r.current.Load()
	if cert == nil {
		return nil, errors.New("no TLS certificate loaded")
	}
	return cert, nil
}
