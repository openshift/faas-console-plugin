package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("HandleBuildStatus", func() {
	It("returns 401 without an SCM token", func() {
		withSCMStub(&scm.ClientStub{})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/build/status", nil)
		w := httptest.NewRecorder()

		(&Handlers{}).HandleBuildStatus(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("maps a run to a build-status item keyed by owner/repo", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{{Owner: "alice", Name: "fn", DefaultBranch: "main"}}, nil
			},
			OnLatestWorkflowRun: func(ctx context.Context, owner, repo, branch, workflowFile string) (*scm.WorkflowRun, error) {
				return &scm.WorkflowRun{Status: "in_progress", HeadSHA: "sha1", HTMLURL: "u"}, nil
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/build/status", nil)
		req.Header.Set("X-SCM-Token", "pat")
		w := httptest.NewRecorder()

		(&Handlers{}).HandleBuildStatus(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		var snap buildSnapshot
		Expect(json.Unmarshal(w.Body.Bytes(), &snap)).To(Succeed())
		Expect(snap.Functions).To(HaveLen(1))
		Expect(snap.Functions[0].Key).To(Equal("alice/fn"))
		Expect(snap.Functions[0].BuildStatus).To(Equal("Building"))
	})

	It("reports None when a repo has no runs", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{{Owner: "alice", Name: "fn", DefaultBranch: "main"}}, nil
			},
			OnLatestWorkflowRun: func(ctx context.Context, owner, repo, branch, workflowFile string) (*scm.WorkflowRun, error) {
				return nil, nil
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/build/status", nil)
		req.Header.Set("X-SCM-Token", "pat")
		w := httptest.NewRecorder()

		(&Handlers{}).HandleBuildStatus(w, req)

		var snap buildSnapshot
		Expect(json.Unmarshal(w.Body.Bytes(), &snap)).To(Succeed())
		Expect(snap.Functions[0].BuildStatus).To(Equal("None"))
	})

	It("returns 401 when the SCM token is rejected", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, scm.ErrUnauthorized
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/build/status", nil)
		req.Header.Set("X-SCM-Token", "pat")
		w := httptest.NewRecorder()

		(&Handlers{}).HandleBuildStatus(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("surfaces a per-repo fetch error without affecting other repos", func() {
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{
					{Owner: "alice", Name: "bad", DefaultBranch: "main"},
					{Owner: "alice", Name: "good", DefaultBranch: "main"},
				}, nil
			},
			OnLatestWorkflowRun: func(ctx context.Context, owner, repo, branch, workflowFile string) (*scm.WorkflowRun, error) {
				if repo == "bad" {
					return nil, errors.New("boom")
				}
				return &scm.WorkflowRun{Status: "in_progress"}, nil
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/build/status", nil)
		req.Header.Set("X-SCM-Token", "pat")
		w := httptest.NewRecorder()

		(&Handlers{}).HandleBuildStatus(w, req)

		Expect(w.Code).To(Equal(http.StatusOK))
		var snap buildSnapshot
		Expect(json.Unmarshal(w.Body.Bytes(), &snap)).To(Succeed())
		Expect(snap.Functions).To(HaveLen(2))

		byKey := map[string]buildStatusItem{}
		for _, f := range snap.Functions {
			byKey[f.Key] = f
		}
		Expect(byKey["alice/bad"].BuildStatus).To(Equal("None"))
		Expect(byKey["alice/bad"].Err).To(ContainSubstring("boom"))
		Expect(byKey["alice/good"].BuildStatus).To(Equal("Building"))
		Expect(byKey["alice/good"].Err).To(BeEmpty())
	})
})

var _ = Describe("HandleBuildWatch", func() {
	// pinIntervals makes the SSE timing fully explicit: a fast poll, and
	// rediscover/heartbeat pushed far out so they never fire during a test.
	pinIntervals := func() {
		origPoll := buildPollInterval
		origRediscover := buildRediscoverInterval
		origHeartbeat := buildHeartbeatInterval
		buildPollInterval = 10 * time.Millisecond
		buildRediscoverInterval = time.Hour
		buildHeartbeatInterval = time.Hour
		DeferCleanup(func() {
			buildPollInterval = origPoll
			buildRediscoverInterval = origRediscover
			buildHeartbeatInterval = origHeartbeat
		})
	}

	It("emits an initial snapshot then a new snapshot on change", func() {
		pinIntervals()

		var mu sync.Mutex
		calls := 0
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{{Owner: "alice", Name: "fn", DefaultBranch: "main"}}, nil
			},
			OnLatestWorkflowRun: func(ctx context.Context, owner, repo, branch, workflowFile string) (*scm.WorkflowRun, error) {
				mu.Lock()
				defer mu.Unlock()
				calls++
				if calls == 1 {
					return &scm.WorkflowRun{Status: "in_progress"}, nil
				}
				return &scm.WorkflowRun{Status: "completed", Conclusion: "failure", FailureReason: "build / test"}, nil
			},
		})

		mux := http.NewServeMux()
		mux.HandleFunc("GET /watch", (&Handlers{}).HandleBuildWatch)
		ts := httptest.NewServer(mux)
		DeferCleanup(ts.Close)

		req, err := http.NewRequest(http.MethodGet, ts.URL+"/watch", nil)
		Expect(err).NotTo(HaveOccurred())
		req.Header.Set("X-SCM-Token", "pat")
		resp, err := ts.Client().Do(req)
		Expect(err).NotTo(HaveOccurred())
		defer resp.Body.Close()
		Expect(resp.Header.Get("Content-Type")).To(Equal("text/event-stream"))

		reader := bufio.NewReader(resp.Body)
		first, ok := readSSEDataWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot frame")
		Expect(first).To(ContainSubstring(`"buildStatus":"Building"`))

		second, ok := readSSEDataWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected a second snapshot frame on change")
		Expect(second).To(ContainSubstring(`"buildStatus":"Failed"`))
		Expect(second).To(ContainSubstring(`"failureReason":"build / test"`))
	})

	It("does not emit a second frame when the snapshot is unchanged", func() {
		pinIntervals()

		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{{Owner: "alice", Name: "fn", DefaultBranch: "main"}}, nil
			},
			OnLatestWorkflowRun: func(ctx context.Context, owner, repo, branch, workflowFile string) (*scm.WorkflowRun, error) {
				// Same state on every poll, so the change-detection key never moves.
				return &scm.WorkflowRun{Status: "in_progress"}, nil
			},
		})

		mux := http.NewServeMux()
		mux.HandleFunc("GET /watch", (&Handlers{}).HandleBuildWatch)
		ts := httptest.NewServer(mux)
		DeferCleanup(ts.Close)

		req, err := http.NewRequest(http.MethodGet, ts.URL+"/watch", nil)
		Expect(err).NotTo(HaveOccurred())
		req.Header.Set("X-SCM-Token", "pat")
		resp, err := ts.Client().Do(req)
		Expect(err).NotTo(HaveOccurred())
		defer resp.Body.Close()

		reader := bufio.NewReader(resp.Body)
		first, ok := readSSEDataWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot frame")
		Expect(first).To(ContainSubstring(`"buildStatus":"Building"`))

		// Wait well beyond several poll cycles (poll is 10ms). No new frame should arrive.
		_, ok = readSSEDataWithin(reader, 300*time.Millisecond)
		Expect(ok).To(BeFalse(), "expected no second frame while the snapshot is unchanged")
	})

	It("returns 401 without an SCM token", func() {
		withSCMStub(&scm.ClientStub{})
		req := httptest.NewRequest(http.MethodGet, "/watch", nil)
		w := httptest.NewRecorder()
		(&Handlers{}).HandleBuildWatch(w, req)
		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("carries forward the last-known status when a poll errors transiently", func() {
		pinIntervals()

		var mu sync.Mutex
		calls := 0
		withSCMStub(&scm.ClientStub{
			OnListRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{{Owner: "alice", Name: "fn", DefaultBranch: "main"}}, nil
			},
			OnLatestWorkflowRun: func(ctx context.Context, owner, repo, branch, workflowFile string) (*scm.WorkflowRun, error) {
				mu.Lock()
				defer mu.Unlock()
				calls++
				if calls == 1 {
					return &scm.WorkflowRun{Status: "in_progress"}, nil
				}
				return nil, errors.New("transient boom")
			},
		})

		mux := http.NewServeMux()
		mux.HandleFunc("GET /watch", (&Handlers{}).HandleBuildWatch)
		ts := httptest.NewServer(mux)
		DeferCleanup(ts.Close)

		req, err := http.NewRequest(http.MethodGet, ts.URL+"/watch", nil)
		Expect(err).NotTo(HaveOccurred())
		req.Header.Set("X-SCM-Token", "pat")
		resp, err := ts.Client().Do(req)
		Expect(err).NotTo(HaveOccurred())
		defer resp.Body.Close()

		reader := bufio.NewReader(resp.Body)
		first, ok := readSSEDataWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial snapshot frame")
		Expect(first).To(ContainSubstring(`"buildStatus":"Building"`))

		// Subsequent polls error; the last-known "Building" is carried forward, so
		// the change-detection key does not move and no new frame is emitted (no
		// flicker back to "None", no error-string churn re-sends).
		_, ok = readSSEDataWithin(reader, 300*time.Millisecond)
		Expect(ok).To(BeFalse(), "expected no new frame while transient errors are carried forward")
	})
})

var _ = Describe("deriveBuildStatus", func() {
	DescribeTable("maps run status and conclusion to a build status",
		func(status, conclusion, expected string) {
			Expect(deriveBuildStatus(&scm.WorkflowRun{Status: status, Conclusion: conclusion})).To(Equal(expected))
		},
		Entry("queued -> Building", "queued", "", "Building"),
		Entry("in_progress -> Building", "in_progress", "", "Building"),
		Entry("waiting -> Building", "waiting", "", "Building"),
		Entry("requested -> Building", "requested", "", "Building"),
		Entry("pending -> Building", "pending", "", "Building"),
		Entry("completed+success -> Succeeded", "completed", "success", "Succeeded"),
		Entry("completed+failure -> Failed", "completed", "failure", "Failed"),
		Entry("completed+cancelled -> Failed", "completed", "cancelled", "Failed"),
		Entry("completed+timed_out -> Failed", "completed", "timed_out", "Failed"),
		Entry("completed+skipped -> None", "completed", "skipped", "None"),
		Entry("completed+neutral -> None", "completed", "neutral", "None"),
		Entry("completed+stale -> None", "completed", "stale", "None"),
		Entry("completed+action_required -> None", "completed", "action_required", "None"),
		Entry("unknown status -> None", "bogus", "", "None"),
	)

	It("maps a nil run to None", func() {
		Expect(deriveBuildStatus(nil)).To(Equal("None"))
	})
})

// readSSEDataWithin runs readSSEData with a timeout so a handler that never
// emits fails fast instead of blocking until the spec timeout. It returns the
// payload and true on success, or "" and false if the timeout elapses first.
func readSSEDataWithin(reader *bufio.Reader, timeout time.Duration) (string, bool) {
	ch := make(chan string, 1)
	go func() { ch <- readSSEData(reader) }()
	select {
	case data := <-ch:
		return data, true
	case <-time.After(timeout):
		return "", false
	}
}

// readSSEData reads frames until it finds one with a data: line and returns that payload.
func readSSEData(reader *bufio.Reader) string {
	var data []string
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return strings.Join(data, "\n")
		}
		line = strings.TrimRight(line, "\n")
		if line == "" {
			if len(data) > 0 {
				return strings.Join(data, "\n")
			}
			continue // heartbeat or blank separator, keep reading
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
}
