package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
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

// WatchWorkflowRuns polls GitHub for the latest workflow run of the given workflow
// file across the authenticated user's function repos (topic:serverless-function),
// emitting snapshots when the status changes. Polls every 3s; rediscovers repos
// (re-runs ListRepos to pick up new/deleted functions) every 30s. Uses ETag
// conditional requests (304s are rate-limit exempt) to reduce API consumption.
//
// Error handling: per-repo failures set WorkflowRun.Error and carry forward the
// last-known status (anti-flicker). Catastrophic failures (repo rediscovery, token
// revocation) set WorkflowRunsEvent.Err. Unchanged snapshots are suppressed.
//
// Initial repo discovery runs synchronously on the caller's ctx, so auth failures
// are returned immediately rather than lost in the goroutine. The polling loop runs
// independently; call Stop() to terminate.
func (c *ghClient) WatchWorkflowRuns(ctx context.Context, workflowFilename string) (scm.WorkflowWatch, error) {
	repos, err := c.ListRepos(ctx)
	if err != nil {
		return nil, err
	}

	// Create a new context for the polling loop, independent of the caller's ctx.
	// The loop terminates when this context is cancelled via Stop().
	pollCtx, cancel := context.WithCancel(context.Background())

	ch := make(chan scm.WorkflowRunsEvent)
	watch := &workflowWatch{ch: ch, cancel: cancel}

	go func() {
		defer close(ch)

		// Carried forward when a per-repo poll fails transiently: a flaky GitHub
		// error would otherwise reset the run to nil and flicker the status.
		var prevRuns map[string]scm.WorkflowRun
		var prevErr error

		emit := func(runs map[string]scm.WorkflowRun, err error) {
			// Skip emitting if the snapshot hasn't changed and there's no error.
			if reflect.DeepEqual(runs, prevRuns) && errEqual(err, prevErr) {
				return
			}
			select {
			case ch <- scm.WorkflowRunsEvent{Runs: runs, Err: err}:
				prevRuns = runs
				prevErr = err
			case <-pollCtx.Done():
			}
		}

		runs := c.pollRuns(pollCtx, repos, workflowFilename, prevRuns)
		emit(runs, nil)

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
				emit(prevRuns, err)
				if err != nil {
					slog.Warn("watch workflow runs: rediscover failed", "err", err)
				} else {
					repos = latest
				}
			case <-poll.Chan():
				runs = c.pollRuns(pollCtx, repos, workflowFilename, prevRuns)
				emit(runs, nil)
			}
		}
	}()
	return watch, nil
}

// workflowWatch implements scm.WorkflowWatch. The result channel carries both
// snapshots and errors; the caller must handle both.
type workflowWatch struct {
	ch     chan scm.WorkflowRunsEvent
	cancel context.CancelFunc
}

func (w *workflowWatch) ResultChan() <-chan scm.WorkflowRunsEvent { return w.ch }
func (w *workflowWatch) Stop() {
	// Cancel the polling loop's context. The loop will clean up and close the channel.
	w.cancel()
}

// pollRuns fetches the latest workflow run for each repo concurrently. On
// per-repo errors, carries forward the last-known run from prevRuns with Error
// set. Always succeeds, returning partial data when some repos fail.
func (c *ghClient) pollRuns(ctx context.Context, repos []scm.Repo, workflowFilename string, prevRuns map[string]scm.WorkflowRun) map[string]scm.WorkflowRun {
	var snapshot = make(map[string]scm.WorkflowRun, len(repos))
	var mu sync.Mutex
	var put = func(k string, v scm.WorkflowRun) {
		mu.Lock()
		defer mu.Unlock()
		snapshot[k] = v
	}

	g, _ := errgroup.WithContext(ctx)
	g.SetLimit(10)

	for _, repo := range repos {
		g.Go(func() error {
			run := c.latestWorkflowRun(ctx, repo.Owner, repo.Name, repo.DefaultBranch, workflowFilename)
			if run.Error != nil {
				// Carry forward the last-known run (anti-flicker) but mark it as
				// stale by setting Error. This signals degradation to the client.
				stale := prevRuns[repo.FullName()]

				// Reuse the previous error instance if the message matches. Error
				// instances with identical messages are distinct objects, so
				// reflect.DeepEqual(err1, err2) fails even when semantically the same.
				// Reusing the instance lets dedup suppress redundant SSE events when
				// a repo fails repeatedly with the same error (e.g., rate limit).
				if !errEqual(stale.Error, run.Error) {
					stale.Error = run.Error
				}

				put(repo.FullName(), stale)
				slog.Warn("watch workflow runs: get run failed", "repo", repo.FullName(), "err", run.Error)
			} else {
				put(repo.FullName(), run)
			}
			return nil
		})
	}
	_ = g.Wait()
	return snapshot
}

func (c *ghClient) latestWorkflowRun(ctx context.Context, owner, repo, branch, workflowFilename string) scm.WorkflowRun {
	opts := &ghlib.ListWorkflowRunsOptions{
		Branch:      branch,
		ListOptions: ghlib.ListOptions{PerPage: 1},
	}
	runs, _, err := c.client.Actions.ListWorkflowRunsByFileName(ctx, owner, repo, workflowFilename, opts)
	if err != nil {
		if isNotFound(err) {
			// No such workflow here (a non-func repo, or it has not been
			// pushed yet). Treat it as a repo with no runs.
			return scm.WorkflowRun{}
		}
		return scm.WorkflowRun{
			Error: fmt.Errorf("list workflow runs for %s/%s (%s): %w", owner, repo, workflowFilename, mapErr(err)),
		}
	}
	if len(runs.WorkflowRuns) == 0 {
		return scm.WorkflowRun{}
	}

	// GitHub returns runs in created_at descending order by default, so with
	// PerPage 1 the single element WorkflowRuns[0] is the newest run.
	run := runs.WorkflowRuns[0]
	return scm.WorkflowRun{
		BuildStatus: deriveBuildStatus(run),
		HTMLURL:     run.GetHTMLURL(),
	}
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
		case "failure", "cancelled", "timed_out", "startup_failure":
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

func isNotFound(err error) bool {
	var ghErr *ghlib.ErrorResponse
	return errors.As(err, &ghErr) && ghErr.Response != nil && ghErr.Response.StatusCode == http.StatusNotFound
}

// errEqual reports whether two errors describe the same failure, which is what
// decides whether a repeat of it is worth another event. Every poll builds a
// fresh instance, so neither == nor reflect.DeepEqual can answer that.
//
// errors.Is suffices because the go-github error types compare themselves
// field by field and resolve the target with errors.As, so the comparison sees
// past the fmt.Errorf wrapping this package adds on both sides. Majors before
// v90 type-asserted the target instead, and would see only the wrapper.
//
// An error that never passed through the library, a dial failure say, carries
// no Is of its own and will not match itself. That costs a duplicate event,
// not a wrong one.
func errEqual(x, y error) bool {
	return errors.Is(x, y)
}
