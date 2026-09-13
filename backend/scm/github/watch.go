package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"sort"
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
		prevRuns := make(map[string]*scm.WorkflowRun)
		var prevSnapshot []scm.RepoRun

		emitWithErr := func(snapshot []scm.RepoRun, err error) bool {
			// Skip emitting if the snapshot hasn't changed and there's no error.
			if reflect.DeepEqual(snapshot, prevSnapshot) && err == nil {
				return true
			}
			select {
			case ch <- scm.WorkflowRunsOrErr{Runs: snapshot, Err: err}:
				prevSnapshot = snapshot
				return true
			case <-pollCtx.Done():
				return false
			}
		}

		pollAndEmit := func() bool {
			snapshot, pollErr := c.pollRuns(pollCtx, repos, workflowFile, prevRuns)
			// Rebuilding the index rather than updating it prunes repos that
			// dropped out of discovery, so it cannot grow unbounded.
			next := make(map[string]*scm.WorkflowRun, len(snapshot))
			for _, rr := range snapshot {
				next[rr.Repo.FullName()] = rr.Run
			}
			prevRuns = next
			return emitWithErr(snapshot, pollErr)
		}

		if !pollAndEmit() {
			return
		}

		poll := time.NewTicker(c.pollInterval)
		defer poll.Stop()
		rediscover := time.NewTicker(c.rediscoverInterval)
		defer rediscover.Stop()

		for {
			select {
			case <-pollCtx.Done():
				return
			case <-rediscover.C:
				latest, err := c.ListRepos(pollCtx)
				if err != nil {
					// Unlike a per-repo poll error, which is only carried
					// forward, this one is unambiguous: end the stream rather
					// than leave the client on stale status indefinitely.
					if errors.Is(err, scm.ErrUnauthorized) {
						slog.Info("watch workflow runs: token no longer authorized, ending stream")
						return
					}
					slog.Warn("watch workflow runs: rediscover failed", "err", err)
					continue
				}
				repos = latest
			case <-poll.C:
				if !pollAndEmit() {
					return
				}
			}
		}
	}()
	return watch, nil
}

// pollRuns fetches the latest run for each repo concurrently. A per-repo error
// carries that repo's last-known run forward from prevRuns instead of breaking
// the snapshot. The returned error is non-nil if any repo failed; the snapshot
// is still valid (using carried-forward runs where needed). prevRuns is only
// read here (the caller updates it), so the concurrent reads are safe.
func (c *ghClient) pollRuns(ctx context.Context, repos []scm.Repo, workflowFile string, prevRuns map[string]*scm.WorkflowRun) ([]scm.RepoRun, error) {
	snapshot := make([]scm.RepoRun, len(repos))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, repo := range repos {
		g.Go(func() error {
			run, err := c.latestWorkflowRun(ctx, repo.Owner, repo.Name, repo.DefaultBranch, workflowFile)
			if err != nil {
				slog.Warn("watch workflow runs: get run failed", "repo", repo.FullName(), "err", err)
				run = prevRuns[repo.FullName()]
			}
			snapshot[i] = scm.RepoRun{Repo: repo, Run: run}
			return err
		})
	}
	err := g.Wait()
	sort.Slice(snapshot, func(i, j int) bool { return snapshot[i].Repo.FullName() < snapshot[j].Repo.FullName() })
	if err != nil {
		return snapshot, fmt.Errorf("poll workflow runs: %w", err)
	}
	return snapshot, nil
}

func (c *ghClient) latestWorkflowRun(ctx context.Context, owner, repo, branch, workflowFile string) (*scm.WorkflowRun, error) {
	opts := &ghlib.ListWorkflowRunsOptions{
		Branch:      branch,
		ListOptions: ghlib.ListOptions{PerPage: 1},
	}
	runs, _, err := c.client.Actions.ListWorkflowRunsByFileName(ctx, owner, repo, workflowFile, opts)
	if err != nil {
		if isNotFound(err) {
			// No such workflow here (a non-func repo, or it has not been
			// pushed yet). Treat it as a repo with no runs.
			return nil, nil
		}
		return nil, fmt.Errorf("list workflow runs for %s/%s (%s): %w", owner, repo, workflowFile, mapErr(err))
	}
	if len(runs.WorkflowRuns) == 0 {
		return nil, nil
	}

	// GitHub returns runs in created_at descending order by default, so with
	// PerPage 1 the single element WorkflowRuns[0] is the newest run.
	run := runs.WorkflowRuns[0]
	result := &scm.WorkflowRun{
		ID:         run.GetID(),
		Status:     run.GetStatus(),
		Conclusion: run.GetConclusion(),
		HeadSHA:    run.GetHeadSHA(),
		HTMLURL:    run.GetHTMLURL(),
	}
	return result, nil
}
