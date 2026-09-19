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

const defaultHeartbeat = 15 * time.Second

type buildStatusItem struct {
	BuildStatus string `json:"buildStatus"` // Building | Succeeded | Failed | None
	Conclusion  string `json:"conclusion,omitempty"`
	RunURL      string `json:"runURL,omitempty"`
	HeadSHA     string `json:"headSHA,omitempty"`
}

type buildSnapshot struct {
	Functions map[string]buildStatusItem `json:"functions"`
}

func BuildWatch(opts ...WatchOption) http.HandlerFunc {
	cfg := watchConfig{
		newSCMClient: func(pat string) scm.Client {
			return config.SCMRegistry.Client(scm.DefaultPlatform, pat)
		},
		heartbeat: defaultHeartbeat,
	}
	for _, opt := range opts {
		opt(&cfg)
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
				return
			}
			if event.Err != nil {
				slog.Error("build watch: stream error", "err", event.Err)
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

type watchConfig struct {
	newSCMClient scm.ClientFactory
	heartbeat    time.Duration
}

type WatchOption func(*watchConfig)

func WithSCMFactory(f scm.ClientFactory) WatchOption {
	return func(c *watchConfig) { c.newSCMClient = f }
}

func WithHeartbeat(d time.Duration) WatchOption {
	if d <= 0 {
		panic(fmt.Sprintf("heartbeat must be positive, got %v", d))
	}
	return func(c *watchConfig) { c.heartbeat = d }
}

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
	// "waiting", "requested", "pending" mean a run exists but has not finished.
	case "queued", "in_progress", "waiting", "requested", "pending":
		return "Building"
	case "completed":
		switch run.Conclusion {
		case "success":
			return "Succeeded"
		case "failure", "cancelled", "timed_out":
			return "Failed"
		default:
			// "skipped", "neutral", "stale" and "action_required" are not failures, report no signal.
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
