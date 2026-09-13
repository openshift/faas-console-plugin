package handler

import (
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
)

// defaultHeartbeat is the SSE heartbeat cadence of a handler built without
// options. It is short enough to keep proxies from closing an idle connection.
const defaultHeartbeat = 15 * time.Second

type buildStatusItem struct {
	BuildStatus string `json:"buildStatus"` // Building | Succeeded | Failed | None
	Conclusion  string `json:"conclusion,omitempty"`
	RunURL      string `json:"runURL,omitempty"`
	HeadSHA     string `json:"headSHA,omitempty"`
}

// buildSnapshot is keyed by "owner/name", the identifier the frontend correlates
// on. encoding/json emits map keys sorted, so an unchanged snapshot always
// serializes to the same bytes.
type buildSnapshot struct {
	Functions map[string]buildStatusItem `json:"functions"`
}

// watchConfig holds the tunables of a BuildWatch handler.
type watchConfig struct {
	newSCMClient scm.ClientFactory
	heartbeat    time.Duration
}

// WatchOption customizes the handler returned by BuildWatch.
type WatchOption func(*watchConfig)

// WithSCMFactory overrides how the handler builds an SCM client from the
// caller's token.
func WithSCMFactory(f scm.ClientFactory) WatchOption {
	return func(c *watchConfig) { c.newSCMClient = f }
}

// WithHeartbeat overrides the SSE heartbeat cadence. It must be positive.
func WithHeartbeat(d time.Duration) WatchOption {
	return func(c *watchConfig) { c.heartbeat = d }
}

// defaultSCMClient builds a client for the platform the registry is wired to.
func defaultSCMClient(pat string) scm.Client {
	return config.SCMRegistry.Client(scm.DefaultPlatform, pat)
}

// BuildWatch returns the build-status SSE handler, which builds an SCM client
// per request from the caller's token. Unlike its siblings it needs no cluster
// configuration, so it is a plain function rather than a method on Handlers,
// and both of its tunables have defaults.
func BuildWatch(opts ...WatchOption) http.HandlerFunc {
	cfg := watchConfig{newSCMClient: defaultSCMClient, heartbeat: defaultHeartbeat}
	for _, opt := range opts {
		opt(&cfg)
	}
	if cfg.heartbeat <= 0 {
		// A wiring mistake, caught once at construction rather than by a
		// panicking time.NewTicker on every request.
		panic(fmt.Sprintf("handler.BuildWatch: heartbeat must be positive, got %s", cfg.heartbeat))
	}
	return func(w http.ResponseWriter, r *http.Request) {
		handleBuildWatch(w, r, cfg.newSCMClient, cfg.heartbeat)
	}
}

func handleBuildWatch(w http.ResponseWriter, r *http.Request, newSCMClient scm.ClientFactory, heartbeat time.Duration) {
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

	// WatchWorkflowRuns discovers repos synchronously, so auth failures surface
	// here, as a normal HTTP status, before the response switches to SSE.
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
	// Flush the head so the client's request completes and it can start reading,
	// rather than blocking until the first snapshot frame.
	flusher.Flush()

	beat := time.NewTicker(heartbeat)
	defer beat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-beat.C:
			if _, err := io.WriteString(w, ":\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event, ok := <-watch.ResultChan():
			if !ok {
				// Watch ended (cancelled, or the token was revoked mid-stream).
				// End the stream so the client reconnects, hits a 401 on its
				// initial request, and takes its re-auth path.
				return
			}
			if event.Err != nil {
				slog.Error("build watch: stream error", "err", event.Err)
				// End the stream so the client reconnects and takes its re-auth path.
				// We could also potentially push error event to the stream.
				return
			}
			data, err := json.Marshal(toSnapshot(event.Runs))
			if err != nil {
				slog.Warn("build watch: marshal snapshot failed", "err", err)
				continue
			}
			if err := writeSnapshotEvent(w, data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// toSnapshot maps repo runs into the wire DTO. The map is always non-nil, so an
// empty snapshot encodes as {} rather than null.
func toSnapshot(runs []scm.RepoRun) buildSnapshot {
	items := make(map[string]buildStatusItem, len(runs))
	for _, rr := range runs {
		items[rr.Repo.FullName()] = toBuildStatusItem(rr.Run)
	}
	return buildSnapshot{Functions: items}
}

func toBuildStatusItem(run *scm.WorkflowRun) buildStatusItem {
	item := buildStatusItem{BuildStatus: deriveBuildStatus(run)}
	if run != nil {
		item.Conclusion = run.Conclusion
		item.RunURL = run.HTMLURL
		item.HeadSHA = run.HeadSHA
	}
	return item
}

func deriveBuildStatus(run *scm.WorkflowRun) string {
	if run == nil {
		return "None"
	}
	switch run.Status {
	// The gated "waiting"/"requested"/"pending" states also mean a run exists
	// but has not finished.
	case "queued", "in_progress", "waiting", "requested", "pending":
		return "Building"
	case "completed":
		switch run.Conclusion {
		case "success":
			return "Succeeded"
		case "failure", "cancelled", "timed_out":
			return "Failed"
		default:
			// "skipped", "neutral", "stale" and "action_required" are not
			// failures; report no signal so the frontend falls back to the
			// cluster-derived status instead of a red "Build failed" badge.
			return "None"
		}
	default:
		return "None"
	}
}

func writeSnapshotEvent(w io.Writer, data []byte) error {
	if _, err := fmt.Fprintf(w, "event: build-status\ndata: %s\n\n", data); err != nil {
		return fmt.Errorf("write build-status event: %w", err)
	}
	return nil
}
