package github

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"sync"
	"time"

	ghlib "github.com/google/go-github/v90/github"
	"golang.org/x/sync/errgroup"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

// Defaults for the WatchWorkflowRuns cadence, applied by NewWithBaseURL.
// WithWatchIntervals overrides them per client.
const (
	defaultWatchPollInterval       = 3 * time.Second
	defaultWatchRediscoverInterval = 30 * time.Second
)

// WatchWorkflowRuns implements scm.Client. Repo discovery runs synchronously so
// auth failures are returned to the caller rather than lost in the goroutine.
// The returned watch's lifetime is independent of ctx; call Stop() to terminate.
func (c *ghClient) WatchWorkflowRuns(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
	repos, err := c.ListRepos(ctx)
	if err != nil {
		return nil, err
	}

	// Create a new context for the polling loop, independent of the caller's ctx.
	// The loop terminates when this context is cancelled via Stop().
	pollCtx, cancel := context.WithCancel(context.Background())

	ch := make(chan scm.WorkflowRunsOrErr)
	watch := &workflowWatch{ch: ch, cancel: cancel}

	go func() {
		defer close(ch)

		// Carried forward when a per-repo poll fails transiently: a flaky GitHub
		// error would otherwise reset the run to nil and flicker the status.
		var prevRuns map[string]scm.WorkflowRun

		emitWithErr := func(runs map[string]scm.WorkflowRun, err error) bool {
			// Skip emitting if the snapshot hasn't changed and there's no error.
			if reflect.DeepEqual(runs, prevRuns) && err == nil {
				return true
			}
			select {
			case ch <- scm.WorkflowRunsOrErr{Runs: runs, Err: err}:
				prevRuns = runs
				return true
			case <-pollCtx.Done():
				return false
			}
		}

		pollAndEmit := func() bool {
			snapshot, pollErr := c.pollRuns(pollCtx, repos, workflowFile, prevRuns)
			return emitWithErr(snapshot, pollErr)
		}

		if !pollAndEmit() {
			return
		}

		poll := c.pollTickerFactory()
		defer poll.Stop()
		rediscover := c.rediscoverTickerFactory()
		defer rediscover.Stop()

		for {
			select {
			case <-pollCtx.Done():
				return
			case <-rediscover.Chan():
				latest, err := c.ListRepos(pollCtx)
				if err != nil {
					if !emitWithErr(prevRuns, fmt.Errorf("repository rediscovery failed: %w", err)) {
						return
					}
					slog.Warn("watch workflow runs: rediscover failed", "err", err)
					continue
				}
				repos = latest
			case <-poll.Chan():
				pollAndEmit()
			}
		}
	}()
	return watch, nil
}

// workflowWatch implements scm.WorkflowWatch. The result channel carries both
// snapshots and errors; the caller must handle both.
type workflowWatch struct {
	ch     chan scm.WorkflowRunsOrErr
	cancel context.CancelFunc
}

func (w *workflowWatch) ResultChan() <-chan scm.WorkflowRunsOrErr { return w.ch }
func (w *workflowWatch) Stop() {
	// Cancel the polling loop's context. The loop will clean up and close the channel.
	w.cancel()
}

// pollRuns fetches the latest run for each repo concurrently. A per-repo error
// carries that repo's last-known run forward from prevRuns instead of breaking
// the snapshot. The returned error is non-nil if any repo failed; the snapshot
// is still valid (using carried-forward runs where needed). prevRuns is only
// read here (the caller updates it), so the concurrent reads are safe.
func (c *ghClient) pollRuns(ctx context.Context, repos []scm.Repo, workflowFile string, prevRuns map[string]scm.WorkflowRun) (map[string]scm.WorkflowRun, error) {
	var snapshot = make(map[string]scm.WorkflowRun, len(repos))
	var mu sync.Mutex
	var put = func(k string, v scm.WorkflowRun) {
		mu.Lock()
		defer mu.Unlock()
		snapshot[k] = v
	}

	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)

	for _, repo := range repos {
		g.Go(func() error {
			run, err := c.latestWorkflowRun(ctx, repo.Owner, repo.Name, repo.DefaultBranch, workflowFile)
			if err != nil {
				put(repo.FullName(), prevRuns[repo.FullName()])
				slog.Warn("watch workflow runs: get run failed", "repo", repo.FullName(), "err", err)
			} else {
				put(repo.FullName(), run)
			}
			return err
		})
	}
	err := g.Wait()
	if err != nil {
		return snapshot, fmt.Errorf("poll workflow runs: %w", err)
	}
	return snapshot, nil
}

func (c *ghClient) latestWorkflowRun(ctx context.Context, owner, repo, branch, workflowFile string) (scm.WorkflowRun, error) {
	opts := &ghlib.ListWorkflowRunsOptions{
		Branch:      branch,
		ListOptions: ghlib.ListOptions{PerPage: 1},
	}
	runs, _, err := c.client.Actions.ListWorkflowRunsByFileName(ctx, owner, repo, workflowFile, opts)
	if err != nil {
		if isNotFound(err) {
			// No such workflow here (a non-func repo, or it has not been
			// pushed yet). Treat it as a repo with no runs.
			return scm.WorkflowRun{}, nil
		}
		return scm.WorkflowRun{}, fmt.Errorf("list workflow runs for %s/%s (%s): %w", owner, repo, workflowFile, mapErr(err))
	}
	if len(runs.WorkflowRuns) == 0 {
		return scm.WorkflowRun{}, nil
	}

	// GitHub returns runs in created_at descending order by default, so with
	// PerPage 1 the single element WorkflowRuns[0] is the newest run.
	run := runs.WorkflowRuns[0]
	result := scm.WorkflowRun{
		BuildStatus: deriveBuildStatus(run),
		HTMLURL:     run.GetHTMLURL(),
	}
	return result, nil
}

func deriveBuildStatus(run *ghlib.WorkflowRun) scm.BuildStatus {
	if run == nil {
		return scm.None
	}
	switch run.GetStatus() {
	// "waiting", "requested", "pending" mean a run exists but has not finished.
	case "queued", "in_progress", "waiting", "requested", "pending":
		return scm.Building
	case "completed":
		switch run.GetConclusion() {
		case "success":
			return scm.Succeeded
		case "failure", "cancelled", "timed_out":
			return scm.Failed
		default:
			// GitHub conclusions "skipped", "neutral", "stale", "action_required"
			// do not indicate success or failure, so report no build status change.
			return scm.None
		}
	default:
		return scm.None
	}
}
