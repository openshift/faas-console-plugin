package handler_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/openshift/faas-console-plugin/backend/handler"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/ticker"
)

var _ = Describe("BuildWatch", func() {
	startWatchStream := func(stub scm.Client, factory ticker.Factory) *bufio.Reader {
		mux := http.NewServeMux()
		mux.HandleFunc("GET /watch", buildWatchWithStub(stub, handler.WithHeartbeatTickerFactory(factory)))
		ts := httptest.NewServer(mux)
		DeferCleanup(ts.Close)

		req, err := http.NewRequest(http.MethodGet, ts.URL+"/watch", nil)
		Expect(err).NotTo(HaveOccurred())
		req.Header.Set("X-SCM-Token", "pat")
		resp, err := ts.Client().Do(req)
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(func() { resp.Body.Close() })
		Expect(resp.Header.Get("Content-Type")).To(Equal("text/event-stream"))
		return bufio.NewReader(resp.Body)
	}

	Describe("failures before stream starts", func() {
		It("returns 401 without an SCM token", func() {
			req := httptest.NewRequest(http.MethodGet, "/watch", nil)
			w := httptest.NewRecorder()
			buildWatchWithStub(&scm.ClientStub{})(w, req)
			Expect(w.Code).To(Equal(http.StatusUnauthorized))
		})

		It("returns 401 when the SCM token is rejected during discovery", func() {
			stub := &scm.ClientStub{
				OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
					return nil, scm.ErrUnauthorized
				},
			}
			req := httptest.NewRequest(http.MethodGet, "/watch", nil)
			req.Header.Set("X-SCM-Token", "pat")
			w := httptest.NewRecorder()
			buildWatchWithStub(stub)(w, req)
			Expect(w.Code).To(Equal(http.StatusUnauthorized))
		})

		It("returns 502 when discovery fails with a non-auth error", func() {
			stub := &scm.ClientStub{
				OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
					return nil, errors.New("github unreachable")
				},
			}
			req := httptest.NewRequest(http.MethodGet, "/watch", nil)
			req.Header.Set("X-SCM-Token", "pat")
			w := httptest.NewRecorder()
			buildWatchWithStub(stub)(w, req)
			Expect(w.Code).To(Equal(http.StatusBadGateway))
		})
	})

	It("emits a heartbeat comment on demand", func() {
		ch := make(chan scm.WorkflowRunsOrErr)
		stub := &scm.ClientStub{
			OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
				return &testWatch{ch: ch}, nil
			},
		}

		beat, factory := ticker.CreateFakeTickerFactory()
		reader := startWatchStream(stub, factory)

		go beat()
		line, ok := readLineWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected a heartbeat line")
		Expect(line).To(Equal(":"))
	})

	It("emits an SSE frame per snapshot, keyed by owner/repo in build vocabulary", func() {
		ch := make(chan scm.WorkflowRunsOrErr, 4)
		stub := &scm.ClientStub{
			OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
				return &testWatch{ch: ch}, nil
			},
		}

		reader := startWatchStream(stub, ticker.SilentTickerFactory())

		ch <- scm.WorkflowRunsOrErr{Runs: []scm.RepoRun{{
			Repo: scm.Repo{Owner: "alice", Name: "fn"},
			Run:  &scm.WorkflowRun{Status: "in_progress"},
		}}}
		first, ok := readSSEDataWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected a frame for the first snapshot")
		Expect(first).To(ContainSubstring(`"alice/fn":{"buildStatus":"Building"}`))

		ch <- scm.WorkflowRunsOrErr{Runs: []scm.RepoRun{{
			Repo: scm.Repo{Owner: "alice", Name: "fn"},
			Run: &scm.WorkflowRun{
				Status: "completed", Conclusion: "failure",
				HTMLURL: "https://github.com/alice/fn/actions/runs/1",
			},
		}}}
		second, ok := readSSEDataWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected a frame for the second snapshot")
		Expect(second).To(ContainSubstring(`"buildStatus":"Failed"`))
		Expect(second).To(ContainSubstring(`"runURL":"https://github.com/alice/fn/actions/runs/1"`))
	})

	It("omits the optional fields for a repo with no run", func() {
		ch := make(chan scm.WorkflowRunsOrErr, 1)
		stub := &scm.ClientStub{
			OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
				return &testWatch{ch: ch}, nil
			},
		}

		reader := startWatchStream(stub, ticker.SilentTickerFactory())

		ch <- scm.WorkflowRunsOrErr{Runs: []scm.RepoRun{{Repo: scm.Repo{Owner: "alice", Name: "fn"}, Run: nil}}}
		frame, ok := readSSEDataWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected a frame for the snapshot")
		Expect(frame).To(ContainSubstring(`"alice/fn":{"buildStatus":"None"}`))
	})

	It("ends the stream when the watch channel closes", func() {
		ch := make(chan scm.WorkflowRunsOrErr)
		tw := &testWatch{ch: ch}
		stub := &scm.ClientStub{
			OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
				return tw, nil
			},
		}

		reader := startWatchStream(stub, ticker.SilentTickerFactory())

		ch <- scm.WorkflowRunsOrErr{Runs: []scm.RepoRun{{
			Repo: scm.Repo{Owner: "alice", Name: "fn"},
			Run:  &scm.WorkflowRun{Status: "in_progress"},
		}}}
		first, ok := readSSEDataWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an initial frame")
		Expect(first).To(ContainSubstring(`"buildStatus":"Building"`))

		// Closing the channel signals the watch ended (e.g. the token was revoked
		// mid-stream); the handler ends the SSE stream, so the body reaches EOF.
		tw.Stop()
		errCh := make(chan error, 1)
		go func() {
			_, err := io.Copy(io.Discard, reader)
			errCh <- err
		}()
		select {
		case err := <-errCh:
			Expect(err).To(BeNil())
		case <-time.After(2 * time.Second):
			Fail("expected the stream to close after the watch channel closed")
		}
	})

	It("sends an SSE error event and exits the stream when the watch fails", func() {
		ch := make(chan scm.WorkflowRunsOrErr, 1)
		stub := &scm.ClientStub{
			OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
				return &testWatch{ch: ch}, nil
			},
		}

		reader := startWatchStream(stub, ticker.SilentTickerFactory())

		// Emit an error from the watch
		watchErr := errors.New("github API rate limited")
		ch <- scm.WorkflowRunsOrErr{Err: watchErr}

		// Verify the error event is sent
		line, ok := readLineWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected an error event line")
		Expect(line).To(Equal("event: error"))

		dataLine, ok := readLineWithin(reader, 2*time.Second)
		Expect(ok).To(BeTrue(), "expected a data line")
		Expect(dataLine).To(Equal("data: github API rate limited"))

		// Verify the stream closes after the error event
		errCh := make(chan error, 1)
		go func() {
			_, err := io.Copy(io.Discard, reader)
			errCh <- err
		}()
		select {
		case err := <-errCh:
			Expect(err).To(BeNil())
		case <-time.After(2 * time.Second):
			Fail("expected the stream to close after the error event")
		}
	})

	It("calls watch.Stop() when the request context is cancelled to halt polling", func() {
		stopCalled := make(chan bool)
		ch := make(chan scm.WorkflowRunsOrErr, 1)

		mockWatch := &trackingWatch{
			ch:         ch,
			stopCalled: stopCalled,
		}

		stub := &scm.ClientStub{
			OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
				return mockWatch, nil
			},
		}

		beat, factory := ticker.CreateFakeTickerFactory()
		mux := http.NewServeMux()
		mux.HandleFunc("GET /watch", buildWatchWithStub(stub, handler.WithHeartbeatTickerFactory(factory)))
		ts := httptest.NewServer(mux)
		DeferCleanup(ts.Close)

		ctx, cancel := context.WithCancel(context.Background())
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/watch", nil)
		Expect(err).NotTo(HaveOccurred())
		req.Header.Set("X-SCM-Token", "pat")

		resp, err := ts.Client().Do(req)
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(func() { resp.Body.Close() })

		reader := bufio.NewReader(resp.Body)
		go beat()
		_, err = reader.ReadString('\n')
		Expect(err).NotTo(HaveOccurred())

		cancel()

		select {
		case <-stopCalled:
			// Success: Stop was called
		case <-time.After(2 * time.Second):
			Fail("expected watch.Stop() to be called when request context is cancelled")
		}
	})

	Describe("build status vocabulary", func() {
		buildStatusFor := func(run *scm.WorkflowRun) string {
			ch := make(chan scm.WorkflowRunsOrErr, 1)
			stub := &scm.ClientStub{
				OnWatchWorkflowRuns: func(ctx context.Context, workflowFile string) (scm.WorkflowWatch, error) {
					return &testWatch{ch: ch}, nil
				},
			}

			reader := startWatchStream(stub, ticker.SilentTickerFactory())
			ch <- scm.WorkflowRunsOrErr{Runs: []scm.RepoRun{{Repo: scm.Repo{Owner: "alice", Name: "fn"}, Run: run}}}
			data, ok := readSSEDataWithin(reader, 2*time.Second)
			Expect(ok).To(BeTrue(), "expected a frame for the snapshot")

			var frame struct {
				Functions map[string]struct {
					BuildStatus string `json:"buildStatus"`
				} `json:"functions"`
			}
			Expect(json.Unmarshal([]byte(data), &frame)).To(Succeed())
			return frame.Functions["alice/fn"].BuildStatus
		}

		DescribeTable("maps run status and conclusion to a build status",
			func(status, conclusion, expected string) {
				Expect(buildStatusFor(&scm.WorkflowRun{Status: status, Conclusion: conclusion})).To(Equal(expected))
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

		It("maps a repo with no run to None", func() {
			Expect(buildStatusFor(nil)).To(Equal("None"))
		})
	})
})

// testWatch wraps a channel for testing; it implements scm.WorkflowWatch.
type testWatch struct {
	ch       chan scm.WorkflowRunsOrErr
	stopOnce sync.Once
}

func (w *testWatch) ResultChan() <-chan scm.WorkflowRunsOrErr { return w.ch }
func (w *testWatch) Stop() {
	w.stopOnce.Do(func() {
		close(w.ch)
	})
}

// trackingWatch is a mock that tracks whether Stop() was called.
type trackingWatch struct {
	ch         chan scm.WorkflowRunsOrErr
	stopCalled chan bool
}

func (w *trackingWatch) ResultChan() <-chan scm.WorkflowRunsOrErr { return w.ch }
func (w *trackingWatch) Stop() {
	close(w.ch)
	select {
	case w.stopCalled <- true:
	default:
	}
}

// buildWatchWithStub returns the handler wired to stub instead of the SCM
// registry it defaults to, ignoring the token the way the stubs ignore
// authentication. Any opts are applied after, so a spec can name its heartbeat.
func buildWatchWithStub(stub scm.Client, opts ...handler.WatchOption) http.HandlerFunc {
	withStub := handler.WithSCMFactory(func(string) scm.Client { return stub })
	return handler.BuildWatch(append([]handler.WatchOption{withStub}, opts...)...)
}

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

// readLineWithin reads a single line (newline trimmed) with a timeout, so a
// handler that never writes fails fast instead of blocking until the spec
// timeout. Returns "" and false if the timeout elapses first.
func readLineWithin(reader *bufio.Reader, timeout time.Duration) (string, bool) {
	ch := make(chan string, 1)
	go func() {
		line, err := reader.ReadString('\n')
		if err != nil {
			ch <- ""
			return
		}
		ch <- strings.TrimRight(line, "\n")
	}()
	select {
	case line := <-ch:
		return line, true
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
