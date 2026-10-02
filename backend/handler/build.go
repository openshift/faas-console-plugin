package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/ticker"
)

const defaultHeartbeat = 15 * time.Second

func BuildWatch(opts ...WatchOption) http.HandlerFunc {
	cfg := watchConfig{
		newSCMClient: func(pat string) scm.Client {
			return config.SCMRegistry.Client(scm.DefaultPlatform, pat)
		},
		heartbeatFactory: func() ticker.Ticker {
			return ticker.New(defaultHeartbeat)
		},
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		handleBuildWatch(w, r, cfg.newSCMClient, cfg.heartbeatFactory)
	}
}

func handleBuildWatch(w http.ResponseWriter, r *http.Request, newSCMClient scm.ClientFactory, heartbeatFactory ticker.Factory) {
	pat, ok := extractSCMToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-SCM-Token header is required")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	client := newSCMClient(pat)
	ctx := r.Context()

	watch, err := client.WatchWorkflowRuns(ctx, functions.WorkflowFilename)
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("build watch: watch workflow runs failed", "err", err)
		writeError(w, http.StatusBadGateway, "failed to list repositories")
		return
	}
	defer watch.Stop()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	beat := heartbeatFactory()
	defer beat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-beat.Chan():
			if _, err := io.WriteString(w, ":\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event, ok := <-watch.ResultChan():
			if !ok {
				return
			}
			if event.Err != nil {
				slog.Error("build watch: stream error", "err", event.Err)
				if err := writeErrorEvent(w, event.Err); err != nil {
					slog.Error("build watch: failed to write error event", "err", err)
					return
				}
				flusher.Flush()
				continue
			}
			if err := writeEvent(w, "build-status", event.Runs); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

type watchConfig struct {
	newSCMClient     scm.ClientFactory
	heartbeatFactory ticker.Factory
}

type WatchOption func(*watchConfig)

func WithSCMFactory(f scm.ClientFactory) WatchOption {
	return func(c *watchConfig) { c.newSCMClient = f }
}

func WithHeartbeatTickerFactory(f ticker.Factory) WatchOption {
	if f == nil {
		panic("heartbeat factory must not be nil")
	}
	return func(c *watchConfig) { c.heartbeatFactory = f }
}

func writeErrorEvent(w io.Writer, err error) error {
	var errorDTO = struct {
		Message     string `json:"message"`
		IsAuthError bool   `json:"isAuthError"`
	}{
		Message:     err.Error(), // TODO send better user facing error
		IsAuthError: errors.Is(err, scm.ErrUnauthorized),
	}
	return writeEvent(w, "app-error", &errorDTO)
}

func writeEvent(w io.Writer, name string, data any) error {
	var buff bytes.Buffer

	// Write to buffer never returns error
	_, _ = fmt.Fprintf(&buff, "event: %s\ndata: ", name)
	_ = json.NewEncoder(&buff).Encode(data)
	_, _ = fmt.Fprintf(&buff, "\n\n")

	_, writeErr := w.Write(buff.Bytes())
	if writeErr != nil {
		return fmt.Errorf("write error event: %w", writeErr)
	}

	return nil
}
