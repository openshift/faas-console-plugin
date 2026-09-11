package github_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

var _ = Describe("WatchWorkflowRuns", func() {
	// Caching must not depend on how big the payload happens to be. It is easy
	// for it to: the cache only stores a response whose body is read to EOF, and
	// a JSON decoder stops as soon as the top-level value is complete, so
	// whether it reads that far comes down to where its buffer boundaries fall.
	// A live workflow_runs entry embeds whole repository objects and runs
	// 10-20 KB, and grows whenever GitHub adds a field, so a cache that works
	// only at the size of a tiny fixture would break silently in production.
	// These sizes were measured to straddle the boundary.
	for _, payload := range []int{0, 14_000, 100_000} {
		It(fmt.Sprintf("revalidates each poll with If-None-Match so unchanged runs cost a free 304 (%d bytes of padding)", payload), func() {
			var mu sync.Mutex
			var conditional []string
			cl := newWatchClient(fastPoll, noRediscover, watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
				func(w http.ResponseWriter, r *http.Request) {
					mu.Lock()
					defer mu.Unlock()
					inm := r.Header.Get("If-None-Match")
					conditional = append(conditional, inm)

					w.Header().Set("ETag", `"run-etag-v1"`)
					// A "fresh" response (like GitHub's max-age=60). The client must
					// still revalidate on every poll, otherwise a new build would be
					// hidden behind this window. This guards the forceRevalidate wrap.
					w.Header().Set("Cache-Control", "max-age=60")
					if inm == `"run-etag-v1"` {
						w.WriteHeader(http.StatusNotModified)
						return
					}
					writeRuns(w, padRun(map[string]any{"id": 42, "status": "in_progress"}, payload))
				}))

			ctx, cancel := context.WithCancel(context.Background())
			DeferCleanup(cancel)
			ch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())

			first, ok := recvWithin(ch, 2*time.Second)
			Expect(ok).To(BeTrue(), "expected an initial snapshot")
			Expect(first[0].Run.Status).To(Equal("in_progress"))

			// Let several poll cycles run.
			Eventually(func() int {
				mu.Lock()
				defer mu.Unlock()
				return len(conditional)
			}, 2*time.Second, 10*time.Millisecond).Should(BeNumerically(">=", 3))

			// The run never changes, so a working cache serves each 304 as the same
			// run and the snapshot never re-emits. A broken cache would yield an
			// empty 304 body (nil run) and a spurious re-emit.
			_, ok = recvWithin(ch, 300*time.Millisecond)
			Expect(ok).To(BeFalse(), "expected no re-emit while the 304s serve cached data")

			mu.Lock()
			defer mu.Unlock()
			// The first poll was unconditional; every later poll sent If-None-Match
			// and got a 304.
			Expect(conditional[0]).To(BeEmpty())
			for _, inm := range conditional[1:] {
				Expect(inm).To(Equal(`"run-etag-v1"`))
			}
		})
	}

	It("returns an unauthorized error from the initial discovery", func() {
		// Discovery fails before the watch loop starts, so the cadence is moot.
		cl := newWatchClient(fastPoll, noRediscover, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
		})

		_, err := cl.WatchWorkflowRuns(context.Background(), "func-deploy.yaml")
		Expect(err).To(MatchError(scm.ErrUnauthorized))
	})

	It("streams an initial snapshot keyed by repo, then re-emits only on change", func() {
		var mu sync.Mutex
		runCalls := 0
		cl := newWatchClient(fastPoll, noRediscover, watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
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
		ch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())

		first, ok := recvWithin(ch, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot")
		Expect(first).To(HaveLen(1))
		Expect(first[0].Repo.FullName()).To(Equal("alice/fn"))
		Expect(first[0].Run).NotTo(BeNil())
		Expect(first[0].Run.Status).To(Equal("in_progress"))

		second, ok := recvWithin(ch, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected a second snapshot once the run changed")
		Expect(second[0].Run.Status).To(Equal("completed"))
		Expect(second[0].Run.Conclusion).To(Equal("success"))
	})

	It("does not re-emit while the run is unchanged", func() {
		cl := newWatchClient(fastPoll, noRediscover, watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
			func(w http.ResponseWriter, r *http.Request) {
				writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		ch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())

		_, ok := recvWithin(ch, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot")
		// Many poll cycles pass (poll is 10ms) with identical runs; the watch
		// suppresses the redundant snapshots.
		_, ok = recvWithin(ch, 300*time.Millisecond)
		Expect(ok).To(BeFalse(), "expected no re-emit while the run is unchanged")
	})

	It("carries a repo's last-known run forward across a transient poll error", func() {
		var mu sync.Mutex
		runCalls := 0
		cl := newWatchClient(fastPoll, noRediscover, watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
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
		ch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())

		first, ok := recvWithin(ch, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot")
		Expect(first[0].Run.Status).To(Equal("in_progress"))
		// The last-known run is carried forward, so the snapshot is unchanged
		// and nothing new is emitted (no flicker to a nil run).
		_, ok = recvWithin(ch, 300*time.Millisecond)
		Expect(ok).To(BeFalse(), "expected no re-emit while the error is carried forward")
	})

	It("closes the channel when the token is revoked at rediscover", func() {
		var mu sync.Mutex
		userCalls := 0
		cl := newWatchClient(fastPoll, fastPoll, func(w http.ResponseWriter, r *http.Request) {
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
		ch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())

		_, ok := recvWithin(ch, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot")

		// The rediscover tick sees the revoked token and ends the watch, which
		// closes the channel.
		Eventually(func() bool {
			select {
			case _, open := <-ch:
				return !open
			case <-time.After(50 * time.Millisecond):
				return false
			}
		}, 2*time.Second, 10*time.Millisecond).Should(BeTrue(), "expected the channel to close")
	})

	It("picks up a newly discovered repo on the next rediscover", func() {
		var mu sync.Mutex
		repos := []map[string]any{repoItem("alice", "fn1", "main")}
		cl := newWatchClient(fastPoll, fastPoll, func(w http.ResponseWriter, r *http.Request) {
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
		ch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())

		first, ok := recvWithin(ch, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot")
		Expect(first).To(HaveLen(1))

		// A second func repo appears; the periodic rediscover must pick it up and
		// the next snapshot must include it.
		mu.Lock()
		repos = append(repos, repoItem("alice", "fn2", "main"))
		mu.Unlock()

		Eventually(func() int {
			snap, ok := recvWithin(ch, 200*time.Millisecond)
			if !ok {
				return -1
			}
			return len(snap)
		}, 2*time.Second, 10*time.Millisecond).Should(Equal(2), "expected the rediscovered repo in the snapshot")
	})

	It("treats a missing workflow file as a repo with no run", func() {
		cl := newWatchClient(fastPoll, noRediscover, watchFake("alice", []map[string]any{repoItem("alice", "fn", "main")},
			func(w http.ResponseWriter, r *http.Request) {
				// The func workflow file does not exist in this repo, so GitHub's
				// by-file-name runs endpoint 404s. That is not a func repo error;
				// it must surface as a nil run, not end the stream.
				w.WriteHeader(http.StatusNotFound)
				json.NewEncoder(w).Encode(map[string]string{"message": "Not Found"})
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		ch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())

		first, ok := recvWithin(ch, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot")
		Expect(first).To(HaveLen(1))
		Expect(first[0].Repo.FullName()).To(Equal("alice/fn"))
		Expect(first[0].Run).To(BeNil())
	})

	It("returns a multi-repo snapshot sorted by repo full name", func() {
		cl := newWatchClient(fastPoll, noRediscover, watchFake("alice",
			[]map[string]any{
				repoItem("alice", "zeta", "main"),
				repoItem("alice", "alpha", "main"),
			},
			func(w http.ResponseWriter, r *http.Request) {
				writeRuns(w, map[string]any{"id": 1, "status": "in_progress"})
			}))

		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)
		ch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
		Expect(err).NotTo(HaveOccurred())

		first, ok := recvWithin(ch, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot")
		Expect(first).To(HaveLen(2))
		// Discovery returned the repos out of order; the snapshot is sorted so the
		// stream and its change-detection are deterministic across polls.
		Expect(first[0].Repo.FullName()).To(Equal("alice/alpha"))
		Expect(first[1].Repo.FullName()).To(Equal("alice/zeta"))
	})
})

const (
	// Drive the poll loop fast, and push rediscover out unless a test needs it.
	fastPoll     = 10 * time.Millisecond
	noRediscover = time.Hour
)

// newWatchClient serves handler as GitHub and returns a client whose watch loop
// ticks fast enough for a test to observe several polls. The cadence belongs to
// this client alone, so specs can run the loop at different speeds without
// affecting each other.
func newWatchClient(poll, rediscover time.Duration, handler http.HandlerFunc) scm.Client {
	srv := httptest.NewServer(handler)
	DeferCleanup(srv.Close)
	return github.NewWithBaseURL("test-pat", srv.URL, github.WithWatchIntervals(poll, rediscover))
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

// recvWithin receives one snapshot from ch or times out.
func recvWithin(ch <-chan []scm.RepoRun, timeout time.Duration) ([]scm.RepoRun, bool) {
	select {
	case snap := <-ch:
		return snap, true
	case <-time.After(timeout):
		return nil, false
	}
}
