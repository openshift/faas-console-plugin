package github_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
	"github.com/openshift/faas-console-plugin/backend/ticker"
)

// Beware ye who enter here!
//
// Normally polling is triggered via Go's runtime timers. In these tests,
// we emulate polling ticks via explicit fake tickers (we "tick at will").
// This enables better determinism, reliability, and speed. However, it
// introduces risks: potential deadlocks and race conditions if used poorly.
// Proceed with caution.
//
// Pitfall 1: Deadlock when calling tickPoll() twice on the same goroutine
// that consumes the watcher channel. The first tickPoll() triggers the watch
// loop to make a request to the GitHub test double and send the result via
// the channel. The second tickPoll() blocks because the watch loop is stuck
// waiting for the consumer to accept the first result (unless results are
// unchanged, since we suppress duplicates).
//
// Mitigation: Call `go tickPoll()` instead, on a separate goroutine.
//
// Pitfall 2: Async timing when changing GitHub test double behavior between
// ticks. Example: `tickPoll(); prop = x; tickPoll()`. Both requests to the
// test double may see `prop == x`, not just the second, because the first
// request is still in flight.
//
// Mitigation: Script the handler to return different responses based on
// request count (e.g., via atomic counter indexing into a states array),
// or use sync.WaitGroup to ensure the first request completes before the
// second tick fires.
//
// You have been warned.

var _ = Describe("WatchWorkflowRuns", func() {
	// This test verifies that the ETag cache works correctly through the polling
	// loop, regardless of response payload size. Payload size is varied because
	// a cache that stores a body only once the caller reads it to EOF ends up
	// caching some sizes and not others, depending on how the response is
	// framed. See etagcache.go.
	//
	// Three requests are scripted via the states array:
	//
	// Request 1 (initial poll):
	//   No If-None-Match (nothing cached yet).
	//   Server responds 200 with ETag "a" and status "in_progress".
	//   Cache stores the response body + ETag.
	//
	// Request 2 (first tickPoll):
	//   Cache sends If-None-Match: "a".
	//   Server sees matching ETag, responds 304.
	//   Cache replays the stored "in_progress" body.
	//   Snapshot unchanged, watch suppresses the emit.
	//   If the cache failed to store the body, there would be no
	//   If-None-Match header, and the request would hit the forceCache
	//   branch, returning a 429 rate limit error. The test would fail.
	//
	// Request 3 (second tickPoll):
	//   Cache sends If-None-Match: "a".
	//   Server has new ETag "b", responds 200 with status "completed".
	//   Snapshot changed, watch emits.
	DescribeTable("revalidates each poll with If-None-Match so unchanged runs cost a free 304",
		func(payload int) {

			var counter atomic.Int32
			var states = []struct {
				etag       string
				forceCache bool
				run        map[string]any
			}{
				{
					etag: "a",
					run:  map[string]any{"id": 42, "status": "in_progress"},
				},
				{
					etag:       "a",
					forceCache: true,
					run:        map[string]any{"id": 42, "status": "in_progress"},
				},
				{
					etag: "b",
					run:  map[string]any{"id": 43, "status": "completed", "conclusion": "success"},
				},
			}
			cl, tickPoll, _ := newClient(watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
				func(w http.ResponseWriter, r *http.Request) {
					s := states[counter.Add(1)-1]
					inm := r.Header.Get("If-None-Match")
					w.Header().Set("ETag", s.etag)
					w.Header().Set("Cache-Control", "max-age=60")
					if inm == s.etag {
						// Request had If-None-Match, data unchanged, return 304
						w.WriteHeader(http.StatusNotModified)
						return
					}
					if s.forceCache {
						w.WriteHeader(http.StatusTooManyRequests)
						json.NewEncoder(w).Encode(map[string]string{"message": "API rate limit exceeded"})
						return
					}
					writeRuns(w, padRun(s.run, payload))
				}))

			ctx, cancel := context.WithCancel(context.Background())
			DeferCleanup(cancel)
			w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())
			DeferCleanup(w.Stop)

			first := receiveWTO(w.ResultChan())
			Expect(first["alice/fn"].Status).To(Equal(scm.InProgress))

			go func() {
				tickPoll() // this should result in 429 if proper caching is not in place
				tickPoll()
			}()

			second := receiveWTO(w.ResultChan())
			Expect(second["alice/fn"].Status).To(Equal(scm.Succeeded))
		},
		Entry("0 bytes of padding", 0),
		Entry("14_000 bytes of padding", 14_000),
		Entry("100_000 bytes of padding", 100_000),
	)

	It("returns an unauthorized error from the initial discovery", func() {
		// Discovery fails before the watch loop starts, so the cadence is moot.
		cl, _, _ := newClient(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
		})

		_, err := cl.WatchWorkflowRuns(context.Background(), "func-deploy.yaml")
		Expect(err).To(MatchError(scm.ErrUnauthorized))
	})

	It("streams an initial snapshot keyed by repo, then re-emits only on change", func() {
		var mu sync.Mutex
		runCalls := 0
		cl, tickPoll, _ := newClient(watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
			func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				runCalls++
				if runCalls == 1 {
					writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
					return
				}
				writeRuns(w, map[string]any{"id": 2, "status": "completed", "conclusion": "success"})
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		first := receiveWTO(w.ResultChan())
		Expect(first).To(HaveLen(1))

		Expect(first["alice/fn"].Status).To(Equal(scm.InProgress))

		// Trigger poll to get the second snapshot with changed status
		go tickPoll()
		second := receiveWTO(w.ResultChan())
		Expect(second["alice/fn"].Status).To(Equal(scm.Succeeded))
	})

	It("does not re-emit while the run is unchanged", func() {
		var calls atomic.Int32
		cl, tickPoll, _ := newClient(watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
			func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) <= 2 {
					writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
				} else {
					writeRuns(w, map[string]any{"id": 1, "status": "completed", "conclusion": "success"})
				}
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		first := receiveWTO(w.ResultChan()) // call 1: in_progress
		Expect(first["alice/fn"].Status).To(Equal(scm.InProgress))

		go func() {
			tickPoll() // call 2: in_progress again, suppressed (no emit, no block)
			tickPoll() // call 3: completed, emitted
		}()

		second := receiveWTO(w.ResultChan())
		Expect(second["alice/fn"].Status).To(Equal(scm.Succeeded))
	})

	It("carries a repo's last-known run forward across a transient poll error", func() {
		var mu sync.Mutex
		runCalls := 0
		cl, tickPoll, _ := newClient(watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
			func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				runCalls++
				if runCalls == 1 {
					writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
					return
				}
				// Transient server error on every later poll.
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"message": "boom"})
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		first := receiveWTO(w.ResultChan())
		Expect(first["alice/fn"].Status).To(Equal(scm.InProgress))

		// Trigger poll to hit the transient error
		go tickPoll()
		// The last-known run is carried forward with Error set. Partial failure is
		// success at the poll level (no channel-level error), but the per-repo Error
		// field changes the snapshot so dedup doesn't suppress it.
		select {
		case event := <-w.ResultChan():
			Expect(event.Err).To(BeNil(), "poll-level error should be nil")
			run := event.Runs["alice/fn"]
			Expect(run.Status).To(Equal(scm.InProgress), "should carry forward last-known status")
			Expect(run.Error.Error()).To(ContainSubstring("500"), "should mark as stale with error")
		case <-time.After(300 * time.Millisecond):
			Fail("expected event with per-repo Error set")
		}
	})

	It("suppresses repeated identical transient failures from fresh upstream errors", func() {
		var phase atomic.Int32
		cl, tickPoll, _ := newClient(watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
			func(w http.ResponseWriter, r *http.Request) {
				switch phase.Add(1) {
				case 1:
					writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
				case 2, 3:
					w.WriteHeader(http.StatusInternalServerError)
					json.NewEncoder(w).Encode(map[string]string{"message": "upstream unavailable"})
				case 4:
					writeRuns(w, map[string]any{"id": 1, "status": "completed", "conclusion": "success"})
				}
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		initial := receiveWTO(w.ResultChan())
		Expect(initial["alice/fn"].Error).To(BeNil())

		go func() {
			tickPoll() // first 500
			tickPoll() // second 500 -- should not emit
			tickPoll() // emit successful workflow run
		}()
		failed := receiveWTO(w.ResultChan())
		Expect(failed["alice/fn"].Status).To(Equal(scm.InProgress))
		Expect(failed["alice/fn"].Error).To(HaveOccurred())

		recovered := receiveWTO(w.ResultChan())
		Expect(recovered["alice/fn"].Error).To(BeNil())
		Expect(recovered["alice/fn"].Status).To(Equal(scm.Succeeded))
	})

	It("propagate error when token is revoked at rediscover", func() {
		var mu sync.Mutex
		userCalls := 0
		cl, _, tickRediscover := newClient(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/user":
				mu.Lock()
				userCalls++
				n := userCalls
				mu.Unlock()
				// Initial discovery succeeds; the token is then revoked, so
				// every later discovery is unauthorized.
				if n > 1 {
					w.WriteHeader(http.StatusUnauthorized)
					json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
					return
				}
				json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
			case r.URL.Path == "/search/repositories":
				json.NewEncoder(w).Encode(map[string]any{
					"total_count": 1,
					"items":       []map[string]any{repoItem("alice", "fn", "main")},
				})
			case strings.Contains(r.URL.Path, "/actions/workflows/"):
				writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		receiveWTO(w.ResultChan()) // receive an initial snapshot

		// Trigger rediscover to see the revoked token
		go tickRediscover()

		// The rediscover sees the revoked token and propagates the error.
		select {
		case res := <-w.ResultChan():
			Expect(res.Err).To(MatchError(scm.ErrUnauthorized))
		case <-time.After(300 * time.Millisecond):
			Fail("expected the channel to close with error")
		}
	})

	It("picks up a newly discovered repo on the next rediscover", func() {
		var mu sync.Mutex
		repos := []map[string]any{repoItem("alice", "fn1", "main")}
		cl, tickPoll, tickRediscover := newClient(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/user":
				json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
			case r.URL.Path == "/search/repositories":
				mu.Lock()
				items := append([]map[string]any(nil), repos...)
				mu.Unlock()
				json.NewEncoder(w).Encode(map[string]any{"total_count": len(items), "items": items})
			case strings.Contains(r.URL.Path, "/actions/workflows/"):
				writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		first := receiveWTO(w.ResultChan())
		Expect(first).To(HaveLen(1))

		// A second func repo appears; trigger rediscover to pick it up and poll for its status
		mu.Lock()
		repos = append(repos, repoItem("alice", "fn2", "main"))
		mu.Unlock()

		go func() {
			tickRediscover()
			tickPoll()
		}()

		snap := receiveWTO(w.ResultChan())
		Expect(snap).To(HaveLen(2))
	})

	It("treats a missing workflow file as a repo with no run", func() {
		cl, _, _ := newClient(watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
			func(w http.ResponseWriter, r *http.Request) {
				// The func workflow file does not exist in this repo, so GitHub's
				// by-file-name runs endpoint 404s. That is not a func repo error;
				// it must surface as a nil run, not end the stream.
				w.WriteHeader(http.StatusNotFound)
				json.NewEncoder(w).Encode(map[string]string{"message": "Not Found"})
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		first := receiveWTO(w.ResultChan())
		Expect(first).To(HaveLen(1))
		Expect(first["alice/fn"].Status).To(Equal(scm.None))
	})

	It("stops polling when Stop() is called", func() {
		cl, _, _ := newClient(watchFake("alice",
			[]map[string]any{repoItem("alice", "fn", "main")},
			func(w http.ResponseWriter, r *http.Request) {
				writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		// Get initial snapshot
		first := receiveWTO(w.ResultChan())
		Expect(first["alice/fn"].Status).To(Equal(scm.InProgress))

		// Call Stop()
		w.Stop()

		// Channel should close (recv returns with ok=false)
		select {
		case _, ok := <-w.ResultChan():
			Expect(ok).To(BeFalse(), "expected channel to close after Stop()")
		case <-time.After(2 * time.Second):
			Fail("expected channel to close after Stop()")
		}
	})

	It("carries forward last-known run when workflow runs endpoint returns service unavailable", func() {
		var mu sync.Mutex
		callCount := 0
		cl, tickPoll, _ := newClient(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/user":
				json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
			case r.URL.Path == "/search/repositories":
				json.NewEncoder(w).Encode(map[string]any{
					"total_count": 1,
					"items":       []map[string]any{repoItem("alice", "fn", "main")},
				})
			case strings.Contains(r.URL.Path, "/actions/workflows/"):
				mu.Lock()
				defer mu.Unlock()
				callCount++
				if callCount == 1 {
					// First call succeeds with a run
					writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
					return
				}
				// Subsequent calls return 429 Too Many Requests
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]string{"message": "API rate limit exceeded"})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		// Get initial snapshot with the run
		first := receiveWTO(w.ResultChan())
		Expect(first["alice/fn"].Status).To(Equal(scm.InProgress))

		// Trigger poll to hit the rate-limited endpoint
		go tickPoll()

		// The last-known run is carried forward with Error set. Partial failure is
		// success at the poll level (no channel-level error), but the per-repo Error
		// field changes the snapshot so dedup doesn't suppress it.
		select {
		case event := <-w.ResultChan():
			Expect(event.Err).To(BeNil(), "poll-level error should be nil")
			run := event.Runs["alice/fn"]
			Expect(run.Status).To(Equal(scm.InProgress), "should carry forward last-known status")
			Expect(run.Error.Error()).To(ContainSubstring("API rate limit exceeded"), "should mark as stale with error")
		case <-time.After(2 * time.Second):
			Fail("expected event with per-repo Error set")
		}
	})

	It("one status check failure does not break other", func() {
		repos := make([]map[string]any, 0, 100)
		for i := range 100 {
			repoName := fmt.Sprintf("fn-%03d-testing", i)
			repos = append(repos, repoItem("alice", repoName, "main"))
		}

		broken := map[int]bool{13: true, 41: true, 73: true, 97: true}

		handleRuns := http.NewServeMux()
		handleRuns.HandleFunc("/repos/{owner}/{repo}/actions/workflows/{workflow}/runs",
			func(w http.ResponseWriter, r *http.Request) {
				var n int
				repo := r.PathValue("repo")
				_, e := fmt.Sscanf(repo, "fn-%03d-testing", &n)
				if e != nil {
					panic(e)
				}
				if broken[n] {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				w.WriteHeader(200)
				writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
			},
		)

		cl, _, _ := newClient(watchFake(
			"alice",
			repos,
			handleRuns.ServeHTTP,
		))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		select {
		case runs := <-w.ResultChan():
			// Partial failure is success: poll-level Err should be nil, but per-repo
			// Error field signals degradation for broken repos.
			Expect(runs.Err).To(BeNil(), "poll-level error should be nil")
			var inProgress, withError int
			for _, run := range runs.Runs {
				if run.Status == scm.InProgress {
					inProgress++
				}
				if run.Error != nil {
					withError++
				}
			}
			Expect(inProgress).To(Equal(len(repos)-len(broken)), "healthy repos should show InProgress")
			Expect(withError).To(Equal(len(broken)), "broken repos should have Error set")
		case <-time.After(time.Second * 2):
			Fail("timeout")
		}
	})

	It("rediscovery error is cleared", func() {
		var listCallCount atomic.Int32
		cl, _, tickRediscovery := newClient(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/user":
				_ = json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
			case r.URL.Path == "/search/repositories":
				if listCallCount.Add(1) == 3 {
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = w.Write([]byte(`{"message": "temporary unavailable"}`))
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"total_count": 1,
					"items":       []map[string]any{repoItem("alice", "fn", "main")},
				})
			case strings.Contains(r.URL.Path, "/actions/workflows/"):
				writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		go func() {
			tickRediscovery()
			tickRediscovery()
			tickRediscovery()
		}()

		for range 2 {
			select {
			case runs := <-w.ResultChan():
				_, _ = fmt.Fprintf(GinkgoWriter, "runs: %+v\n", runs)
			case <-time.After(time.Second * 1):
				Fail("timeout")
			}
		}

		select {
		case runs := <-w.ResultChan():
			Expect(runs.Err).To(BeNil(), "the rediscovery error should have been cleared")
		case <-time.After(time.Second * 1):
			Fail("timeout")
		}
	})

	It("polls at the interval set by WithWatchPollInterval and keeps the rediscover interval", func() {
		// Scripted by request count: the first poll sees the run in progress and
		// later polls see it completed. Discovery finds "fn" first; any later
		// search (a rediscovery) would also return "fn2".
		var fnPolls, searches atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/user":
				json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
			case r.URL.Path == "/search/repositories":
				repos := []map[string]any{repoItem("alice", "fn", "main")}
				if searches.Add(1) > 1 {
					repos = append(repos, repoItem("alice", "fn2", "main"))
				}
				json.NewEncoder(w).Encode(map[string]any{"total_count": len(repos), "items": repos})
			case strings.Contains(r.URL.Path, "/repos/alice/fn/actions/workflows/"):
				if fnPolls.Add(1) == 1 {
					writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
					return
				}
				writeRuns(w, map[string]any{"id": 1, "status": "completed", "conclusion": "success"})
			case strings.Contains(r.URL.Path, "/repos/alice/fn2/actions/workflows/"):
				writeRuns(w, map[string]any{"id": 2, "status": "completed", "conclusion": "success"})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		DeferCleanup(srv.Close)
		cl := github.NewWithBaseURL("test-pat", srv.URL, github.WithWatchPollInterval(10*time.Millisecond))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(w.Stop)

		first := receiveWTO(w.ResultChan())
		Expect(first["alice/fn"].Status).To(Equal(scm.InProgress))

		// receiveWTO waits 1s, so the change is only seen if the next poll runs
		// at the configured interval rather than the 3s default.
		second := receiveWTO(w.ResultChan())
		Expect(second["alice/fn"].Status).To(Equal(scm.Succeeded))

		// A rediscovery would add "fn2" to the next snapshot. None arrives, so
		// rediscovery keeps its own 30s interval.
		Consistently(w.ResultChan()).WithTimeout(300 * time.Millisecond).ShouldNot(Receive())
	})

	It("rejects a non-positive poll interval", func() {
		Expect(func() { github.WithWatchPollInterval(0) }).To(PanicWith(ContainSubstring("must be positive")))
		Expect(func() { github.WithWatchPollInterval(-time.Second) }).To(PanicWith(ContainSubstring("must be positive")))
	})

	DescribeTable("maps run status and conclusion to a workflow run status",
		func(status, conclusion string, expected scm.WorkflowRunStatus) {
			cl, _, _ := newClient(
				watchFake(
					"alice",
					[]map[string]any{
						repoItem("alice", "alpha", "main"),
					},
					func(w http.ResponseWriter, r *http.Request) {
						writeRuns(w, map[string]any{"id": 1, "status": status, "conclusion": conclusion})
					}),
			)

			ctx, cancel := context.WithCancel(context.Background())
			DeferCleanup(cancel)
			w, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())
			DeferCleanup(w.Stop)

			first := receiveWTO(w.ResultChan())

			Expect(first["alice/alpha"].Status).To(Equal(expected))
		},
		Entry("queued -> InProgress", "queued", "", scm.InProgress),
		Entry("in_progress -> InProgress", "in_progress", "", scm.InProgress),
		Entry("waiting -> InProgress", "waiting", "", scm.InProgress),
		Entry("requested -> InProgress", "requested", "", scm.InProgress),
		Entry("pending -> InProgress", "pending", "", scm.InProgress),
		Entry("completed+success -> Succeeded", "completed", "success", scm.Succeeded),
		Entry("completed+failure -> Failed", "completed", "failure", scm.Failed),
		Entry("completed+cancelled -> Failed", "completed", "cancelled", scm.Failed),
		Entry("completed+timed_out -> Failed", "completed", "timed_out", scm.Failed),
		Entry("completed+startup_failure -> Failed", "completed", "startup_failure", scm.Failed),
		Entry("completed+skipped -> None", "completed", "skipped", scm.None),
		Entry("completed+neutral -> None", "completed", "neutral", scm.None),
		Entry("completed+stale -> None", "completed", "stale", scm.None),
		Entry("completed+action_required -> None", "completed", "action_required", scm.None),
		Entry("unknown status -> None", "bogus", "", scm.None),
	)

})

// newClient returns SCM GH Client that runs against GH API served by the handler parameter.
// The returned client does not do periodic workflow polling/rediscover based on an actual monotonic or wall clock.
// The function also returns two functions that can trigger workflow poll/rediscover on demand.
// This makes tests more efficient and deterministic.
func newClient(handler http.HandlerFunc) (scm.Client, func(), func()) {
	const (
		pollInterval       = 1
		rediscoverInterval = 2
	)

	tickPoll, newPollTicker := ticker.CreateFakeTickerFactory()
	tickRediscover, newRediscoverTicker := ticker.CreateFakeTickerFactory()

	opts := []github.Option{
		github.WithWatchPollInterval(pollInterval),
		github.WithWatchRediscoverInterval(rediscoverInterval),
		github.WithWatchTickerFactory(func(d time.Duration) ticker.Ticker {
			switch d {
			case pollInterval:
				return newPollTicker(0)
			case rediscoverInterval:
				return newRediscoverTicker(0)
			}
			Fail("unreachable")
			return nil
		}),
	}

	srv := httptest.NewServer(handler)
	DeferCleanup(srv.Close)

	return github.NewWithBaseURL("test-pat", srv.URL, opts...), tickPoll, tickRediscover
}

// watchFake routes the minimal endpoints WatchWorkflowRuns needs: the
// authenticated user, the repo search (items), and per-repo workflow runs.
func watchFake(login string, repos []map[string]any, onRuns http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/user":
			json.NewEncoder(w).Encode(map[string]string{"login": login})
		case r.URL.Path == "/search/repositories":
			json.NewEncoder(w).Encode(map[string]any{"total_count": len(repos), "items": repos})
		case strings.Contains(r.URL.Path, "/actions/workflows/"):
			onRuns(w, r)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

// repoItem builds a single repo entry as returned by the GitHub search API.
func repoItem(owner, name, branch string) map[string]any {
	return map[string]any{
		"name":           name,
		"html_url":       "https://example.com/" + owner + "/" + name,
		"default_branch": branch,
		"owner":          map[string]any{"login": owner},
	}
}

// writeRuns encodes a workflow-runs list response.
func writeRuns(w http.ResponseWriter, runs ...map[string]any) {
	json.NewEncoder(w).Encode(map[string]any{"total_count": len(runs), "workflow_runs": runs})
}

// padRun adds n bytes of padding to a run so a spec can vary response size. The
// padding is an unknown field, which go-github ignores, so it adds bulk without
// pretending to model any particular part of the real payload.
func padRun(run map[string]any, n int) map[string]any {
	if n == 0 {
		return run
	}
	padded := make(map[string]any, len(run)+1)
	for k, v := range run {
		padded[k] = v
	}
	padded["_padding"] = strings.Repeat("x", n)
	return padded
}

// receiveWTO receives one event from ch or times out.
// It also asserts that the scm.WorkflowRunsEvent.Err is nil.
func receiveWTO(ch <-chan scm.WorkflowRunsEvent) map[string]scm.WorkflowRun {
	select {
	case event := <-ch:
		if event.Err != nil {
			Fail(fmt.Sprintf("unexpected error from watch: %v", event.Err), 1)
		}
		return event.Runs
	case <-time.After(time.Second * 1):
		Fail("receive timeout", 1)
		return nil
	}
}
