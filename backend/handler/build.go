package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/openshift/faas-console-plugin/backend/config"
	"github.com/openshift/faas-console-plugin/backend/scm"
)

// Tunable so tests can drive the SSE loop quickly.
var (
	buildPollInterval       = 3 * time.Second
	buildRediscoverInterval = 30 * time.Second
	buildHeartbeatInterval  = 15 * time.Second
)

type buildStatusItem struct {
	Key           string `json:"key"`
	BuildStatus   string `json:"buildStatus"` // Building | Succeeded | Failed | None
	Conclusion    string `json:"conclusion,omitempty"`
	RunURL        string `json:"runURL,omitempty"`
	FailureReason string `json:"failureReason,omitempty"`
	HeadSHA       string `json:"headSHA,omitempty"`
	Err           string `json:"err,omitempty"`
}

type buildSnapshot struct {
	Functions []buildStatusItem `json:"functions"`
}

func deriveBuildStatus(run *scm.WorkflowRun) string {
	if run == nil {
		return "None"
	}
	switch run.Status {
	// Every pre-completion status (including the gated "waiting"/"requested"/
	// "pending" states) means a run exists but has not finished, so the build is
	// still in flight.
	case "queued", "in_progress", "waiting", "requested", "pending":
		return "Building"
	case "completed":
		switch run.Conclusion {
		case "success":
			return "Succeeded"
		case "failure", "cancelled", "timed_out":
			return "Failed"
		default:
			// Non-failure outcomes like "skipped", "neutral", "stale", or
			// "action_required" are not build failures; report no build signal
			// so the frontend falls back to the cluster-derived status rather
			// than showing a red "Build failed" badge.
			return "None"
		}
	default:
		return "None"
	}
}

func toBuildStatusItem(key string, run *scm.WorkflowRun) buildStatusItem {
	item := buildStatusItem{Key: key, BuildStatus: deriveBuildStatus(run)}
	if run != nil {
		item.Conclusion = run.Conclusion
		item.RunURL = run.HTMLURL
		item.FailureReason = run.FailureReason
		item.HeadSHA = run.HeadSHA
	}
	return item
}

// buildStatusSnapshot fetches the latest run for each repo and builds a sorted
// snapshot. When a per-repo fetch fails and prev holds a last-known item for
// that repo, the previous item is carried forward instead of resetting to
// "None": a transient GitHub error would otherwise flicker the badge back to
// the cluster status and, via a varying error string, defeat the watch loop's
// change-detection and force a re-send every poll. prev may be nil (the
// one-shot snapshot endpoint has no prior state), in which case a fresh error
// item is emitted.
func buildStatusSnapshot(ctx context.Context, client scm.Client, repos []scm.Repo, prev map[string]buildStatusItem) buildSnapshot {
	items := make([]buildStatusItem, len(repos))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, repo := range repos {
		g.Go(func() error {
			key := repo.Owner + "/" + repo.Name
			run, err := client.LatestWorkflowRun(ctx, repo.Owner, repo.Name, repo.DefaultBranch)
			if err != nil {
				slog.Warn("failed to get workflow run", "repo", key, "err", err)
				if last, ok := prev[key]; ok {
					items[i] = last
				} else {
					items[i] = buildStatusItem{Key: key, BuildStatus: "None", Err: err.Error()}
				}
				return nil
			}
			items[i] = toBuildStatusItem(key, run)
			return nil
		})
	}
	_ = g.Wait()
	sort.Slice(items, func(i, j int) bool { return items[i].Key < items[j].Key })
	return buildSnapshot{Functions: items}
}

// snapshotIndex keys a snapshot's items by their repo key for carry-forward
// lookups on the next poll.
func snapshotIndex(snap buildSnapshot) map[string]buildStatusItem {
	index := make(map[string]buildStatusItem, len(snap.Functions))
	for _, item := range snap.Functions {
		index[item.Key] = item
	}
	return index
}

func (h *Handlers) HandleBuildStatus(w http.ResponseWriter, r *http.Request) {
	pat, ok := extractSCMToken(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "X-SCM-Token header is required")
		return
	}
	client := config.SCMRegistry.Client(scm.DefaultPlatform, pat)

	repos, err := client.ListRepos(r.Context())
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("build status: list repos failed", "err", err)
		writeError(w, http.StatusBadGateway, "failed to list repositories")
		return
	}

	snap := buildStatusSnapshot(r.Context(), client, repos, nil)
	writeJSON(w, http.StatusOK, snap)
}

func (h *Handlers) HandleBuildWatch(w http.ResponseWriter, r *http.Request) {
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
	client := config.SCMRegistry.Client(scm.DefaultPlatform, pat)
	ctx := r.Context()

	// Discover repos before switching to SSE so auth failures return a normal status.
	repos, err := client.ListRepos(ctx)
	if err != nil {
		if errors.Is(err, scm.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid SCM token")
			return
		}
		slog.Error("build watch: list repos failed", "err", err)
		writeError(w, http.StatusBadGateway, "failed to list repositories")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	snap := buildStatusSnapshot(ctx, client, repos, nil)
	data, err := json.Marshal(snap)
	if err != nil {
		slog.Error("build watch: marshal snapshot failed", "err", err)
		return
	}
	if err := writeSnapshotEvent(w, data); err != nil {
		return
	}
	flusher.Flush()
	// The marshaled bytes double as the change-detection key.
	prev := string(data)
	// Last-known items, carried forward when a per-repo poll fails transiently.
	prevItems := snapshotIndex(snap)

	poll := time.NewTicker(buildPollInterval)
	defer poll.Stop()
	rediscover := time.NewTicker(buildRediscoverInterval)
	defer rediscover.Stop()
	heartbeat := time.NewTicker(buildHeartbeatInterval)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ":\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-rediscover.C:
			if latest, err := client.ListRepos(ctx); err != nil {
				slog.Warn("build watch: rediscover failed", "err", err)
			} else {
				repos = latest
			}
		case <-poll.C:
			next := buildStatusSnapshot(ctx, client, repos, prevItems)
			data, err := json.Marshal(next)
			if err != nil {
				slog.Warn("build watch: marshal snapshot failed", "err", err)
				continue
			}
			prevItems = snapshotIndex(next)
			key := string(data)
			if key == prev {
				continue
			}
			prev = key
			if err := writeSnapshotEvent(w, data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// writeSnapshotEvent writes the already-marshaled snapshot bytes as an SSE frame.
func writeSnapshotEvent(w io.Writer, data []byte) error {
	if _, err := fmt.Fprintf(w, "event: build-status\ndata: %s\n\n", data); err != nil {
		return fmt.Errorf("write build-status event: %w", err)
	}
	return nil
}
