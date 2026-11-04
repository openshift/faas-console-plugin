package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/functions"
	"github.com/openshift/faas-console-plugin/backend/identity"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/credentials"
	"github.com/openshift/faas-console-plugin/backend/ticker"
)

const defaultHeartbeat = 15 * time.Second

const (
	appErrorEvent          = "app-error"
	workflowRunStatusEvent = "workflow-run-status"
)

type WorkflowRunDTO struct {
	Status string    `json:"status"`
	URL    string    `json:"url,omitempty"`
	Error  *ErrorDTO `json:"error,omitempty"`
}

type ErrorDTO struct {
	Message string `json:"message"`
	Code    *int   `json:"code,omitempty"`
}

// WorkflowRunWatch returns an HTTP handler that streams workflow run status over SSE.
//
// Request: GET with the OpenShift bearer token forwarded by the console proxy.
// Credential lookup failures are sent as app-error events. WithCredentialsProvider
// wires credential lookup; WithSCMFactory and WithHeartbeatTickerFactory are test seams.
//
// Requests that can be flushed get 200 and text/event-stream. A
// ResponseWriter that is not an http.Flusher gets 500 and a JSON error,
// because buffering would stall both updates and heartbeats. Once the stream
// is open no further HTTP status is available, so failures travel as frames.
//
// Two event types are sent:
//
//	workflow-run-status: {"owner/repo": {status, url?, error?}}
//	  status: "InProgress" | "Succeeded" | "Failed" | "None"
//	  url?:   workflow run URL, absent when there is no run
//	  error?: {message, code?}, absent when that repo polled cleanly
//	app-error: {message, code?}
//	  message: user-facing text
//	  code?:   the HTTP status the response would have carried, 401, 403, 502 or 503
//
// Between frames the handler sends an SSE comment as a keepalive, every 15
// seconds by default. It is a comment, not an event, and no listener fires
// for it.
//
// A failure confined to one repo, such as a rate limit, rides in that repo's
// error field and the stream goes on. A failure affecting the whole watch
// emits app-error, and whether the stream survives depends on when it
// happens: a missing or rejected caller credential (401), a credential store
// failure (503), a rejected SCM credential (403) or failed repo discovery (502)
// ends the stream, while anything raised once the loop is running leaves it
// open and lets the client decide whether to reconnect. Otherwise the stream
// runs until the client disconnects or the request context is cancelled.
func WorkflowRunWatch(opts ...WatchOption) http.HandlerFunc {
	cfg := watchConfig{
		newSCMClient: func(pat string) scm.Client {
			return config.SCMRegistry.Client(scm.DefaultPlatform, pat)
		},
		heartbeatFactory: func() ticker.Ticker {
			return ticker.New(defaultHeartbeat)
		},
		credProvider: emptyCredProv{},
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		handleWorkflowRunWatch(w, r, cfg)
	}
}

func handleWorkflowRunWatch(w http.ResponseWriter, r *http.Request, wc watchConfig) {
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

	ew := eventWriter{out: w}

	ocpToken, ok := extractOCPToken(r)
	if !ok {
		ew.writeHTTPError(http.StatusUnauthorized, "authentication required")
		return
	}
	credential, err := wc.credProvider.Get(r.Context(), ocpToken)
	if err != nil {
		if errors.Is(err, identity.ErrUnauthenticated) || errors.Is(err, credentials.ErrNoCredential) {
			ew.writeHTTPError(http.StatusUnauthorized, "authentication required")
			return
		}
		slog.Error("workflow run watch: credential lookup failed", "err", err)
		ew.writeHTTPError(http.StatusServiceUnavailable, "credential store unavailable")
		return
	}

	client := wc.newSCMClient(credential.Token)
	ctx := r.Context()

	watch, err := client.WatchWorkflowRuns(ctx, functions.WorkflowFilename)
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			ew.writeHTTPError(http.StatusForbidden, "invalid SCM token")
			return
		}
		slog.Error("workflow run watch: watch workflow runs failed", "err", err)
		ew.writeHTTPError(http.StatusBadGateway, "failed to list repositories")
		return
	}
	defer watch.Stop()

	beat := wc.heartbeatFactory()
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
				slog.Error("workflow run watch: stream error", "err", event.Err)
				if err := ew.writeError(event.Err); err != nil {
					slog.Error("workflow run watch: failed to write error event", "err", err)
					return
				}
				flusher.Flush()
				continue
			}
			if err := ew.writeWorkflowRunStatus(event.Runs); err != nil {
				slog.Error("workflow run watch: failed to write workflow run event", "err", err)
				return
			}
			flusher.Flush()
		}
	}
}

type watchConfig struct {
	newSCMClient     scm.ClientFactory
	heartbeatFactory ticker.Factory
	credProvider     CredentialProvider
}

type CredentialProvider interface {
	// Get returns the SCM credential for the given OpenShift token.
	Get(ctx context.Context, ocpToken string) (credentials.Credential, error)
}

type emptyCredProv struct{}

func (e emptyCredProv) Get(ctx context.Context, ocpToken string) (credentials.Credential, error) {
	return credentials.Credential{}, credentials.ErrNoCredential
}

type WatchOption func(*watchConfig)

func WithSCMFactory(f scm.ClientFactory) WatchOption {
	return func(c *watchConfig) { c.newSCMClient = f }
}

func WithCredentialsProvider(credProvider CredentialProvider) WatchOption {
	return func(w *watchConfig) {
		w.credProvider = credProvider
	}
}

func WithHeartbeatTickerFactory(f ticker.Factory) WatchOption {
	if f == nil {
		panic("heartbeat factory must not be nil")
	}
	return func(c *watchConfig) { c.heartbeatFactory = f }
}

type eventWriter struct {
	buff bytes.Buffer
	out  io.Writer
}

func (e *eventWriter) writeWorkflowRunStatus(runs map[string]scm.WorkflowRun) error {
	var runsDTO = make(map[string]WorkflowRunDTO, len(runs))
	for k, v := range runs {
		runsDTO[k] = WorkflowRunDTO{
			Status: v.Status.String(),
			URL:    v.HTMLURL,
			Error:  errorToErrorDTO(v.Error),
		}
	}
	return e.writeEvent(workflowRunStatusEvent, runsDTO)
}

// writeHTTPError reports a failure the handler would have answered with an
// HTTP status, had the stream not already committed 200 OK on the first
// flush. The code travels in the frame instead, and the client branches on it
// the way it would on a status.
func (e *eventWriter) writeHTTPError(code int, msg string) {
	err := e.writeEvent(appErrorEvent, &ErrorDTO{
		Message: msg,
		Code:    new(code),
	})
	if err != nil {
		slog.Error("failed to encode response", "err", err)
	}
}

func (e *eventWriter) writeError(err error) error {
	return e.writeEvent(appErrorEvent, errorToErrorDTO(err))
}

func (e *eventWriter) writeEvent(name string, data any) error {
	e.buff.Reset()
	// Write to buffer never returns error
	_, _ = fmt.Fprintf(&e.buff, "event: %s\ndata: ", name)

	if serErr := json.NewEncoder(&e.buff).Encode(data); serErr != nil {
		// This really should not happen unless some weird data (e.g. channel) is passed
		return fmt.Errorf("could not serialize the data: %w", serErr)
	}
	_, _ = e.buff.WriteString("\n") // JSON encoder already adds single newline

	_, writeErr := e.out.Write(e.buff.Bytes())
	if writeErr != nil {
		return fmt.Errorf("write error event: %w", writeErr)
	}

	return nil
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
	return "Unable to fetch workflow run status. Please try again later."
}

func errorToCode(err error) *int {
	if errors.Is(err, scm.ErrUnauthorized) {
		return new(403)
	}
	return nil
}
