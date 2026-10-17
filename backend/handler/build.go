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

type WorkflowRunDTO struct {
	Status string    `json:"status"`
	URL    string    `json:"url,omitempty"`
	Error  *ErrorDTO `json:"error,omitempty"`
}

type ErrorDTO struct {
	Message string `json:"message"`
	Code    *int   `json:"code,omitempty"`
}

// BuildWatch returns an HTTP handler that streams build status updates via SSE.
//
// Request:
//   - Method: GET
//   - Header X-SCM-Token: GitHub Personal Access Token
//
// Response:
//   - Content-Type: text/event-stream
//   - Status: 200 (stream started)
//
// Events:
//
//	build-status: {[owner/repo]: {status, url?, error?}}
//	  status: "Building" | "Succeeded" | "Failed" | "None"
//	  url?: string (workflow run URL, omitted when None)
//	  error?: {message, code?} (omitted when no error)
//	app-error: {message, code?}
//	  message: user-facing error description
//	  code?: HTTP status code (401 for auth errors)
//	heartbeat: SSE comment line (keepalive, no data)
//
// Per-repo errors (rate limits, individual repo failures) appear in the error
// field of the build-status event. Catastrophic errors (token revocation, repo
// discovery failure) emit app-error events. The stream continues until the
// client disconnects or the context is cancelled.
//
// HTTP status codes:
//   - 200: stream started (all requests that pass Flusher check)
//   - 500: streaming unsupported (no http.Flusher)
//
// Error event codes (in app-error JSON payload):
//   - 401: missing or invalid X-SCM-Token
//   - 502: failed to discover repositories
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
	// SSE requires explicit flushing to stream events in real-time. Go's net/http
	// server always implements http.Flusher, but middleware that wraps ResponseWriter
	// without forwarding the interface can break this. If flushing is unavailable,
	// fail fast rather than buffering events (which breaks heartbeats and delays updates).
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	pat, ok := extractSCMToken(r)
	if !ok {
		writeErrorEventHTTPLike(w, http.StatusUnauthorized, "X-SCM-Token header is required")
		return
	}
	client := newSCMClient(pat)
	ctx := r.Context()

	watch, err := client.WatchWorkflowRuns(ctx, functions.WorkflowFilename)
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeErrorEventHTTPLike(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("build watch: watch workflow runs failed", "err", err)
		writeErrorEventHTTPLike(w, http.StatusBadGateway, "failed to list repositories")
		return
	}
	defer watch.Stop()

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
			if err := writeBuildStatus(w, event.Runs); err != nil {
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

func writeBuildStatus(w http.ResponseWriter, runs map[string]scm.WorkflowRun) error {
	var runsDTO = make(map[string]WorkflowRunDTO, len(runs))
	for k, v := range runs {
		runsDTO[k] = WorkflowRunDTO{
			Status: v.BuildStatus.String(),
			URL:    v.HTMLURL,
			Error:  errorToErrorDTO(v.Error),
		}
	}
	return writeEvent(w, "build-status", runsDTO)
}

func writeErrorEventHTTPLike(w io.Writer, code int, msg string) {
	err := writeEvent(w, "app-error", &ErrorDTO{
		Message: msg,
		Code:    new(code),
	})
	if err != nil {
		slog.Error("failed to encode response", "err", err)
	}
}

func writeErrorEvent(w io.Writer, err error) error {
	return writeEvent(w, "app-error", errorToErrorDTO(err))
}

func errorToErrorDTO(err error) *ErrorDTO {
	if err == nil {
		return nil
	}
	return &ErrorDTO{
		Message: errorToMessage(err),
		Code:    errorToCode(err),
	}
}

// errorToMessage converts internal errors to user-facing messages.
func errorToMessage(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, scm.ErrUnauthorized) {
		return "Authentication failed. Please check your access token."
	}
	// All other errors (rediscovery failures, rate limits, network issues)
	// map to a generic message. The specific error is in server logs.
	return "Unable to fetch build status. Please try again later."
}

func errorToCode(err error) *int {
	if errors.Is(err, scm.ErrUnauthorized) {
		return new(401)
	}
	return nil
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
