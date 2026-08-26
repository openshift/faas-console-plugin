# SRVOCF-1038: Build Status and Pipeline Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface GitHub Actions build status (Building / Succeeded / Failed, with failure reasons) in the functions list, live-updated over SSE.

**Architecture:** A new `LatestWorkflowRun` method on `scm.Client` (implemented for GitHub, faked in `fakegithub`) feeds two stateless, user-scoped backend endpoints: a JSON snapshot (`GET /api/v1/func/build/status`) and an SSE stream (`GET /api/v1/func/build/watch`) that re-emits the snapshot on change. The frontend `useBuildStatus()` hook reads the SSE stream via `consoleFetch` and the list page merges the build status onto the existing cluster status.

**Tech Stack:** Go stdlib `net/http` + go-github v72 + Ginkgo/Gomega (backend); React + TypeScript + PatternFly 6 + Vitest/RTL (frontend); Playwright (e2e).

**Design spec:** `docs/design/2026-08-26-SRVOCF-1038-build-status-design.md`

---

## File Structure

**Backend (create/modify):**
- `backend/fakegithub/server.go` (modify): add `runs` state, Actions endpoints, `POST /_admin/actions/runs`.
- `backend/fakegithub/server_test.go` (modify): tests for the Actions endpoints via the github client.
- `backend/scm/client.go` (modify): add `WorkflowRun` type and `LatestWorkflowRun` to the `Client` interface.
- `backend/scm/github/client.go` (modify): implement `LatestWorkflowRun` + failure-reason composition.
- `backend/handler/build.go` (create): snapshot + SSE handlers and shared helpers.
- `backend/handler/build_test.go` (create): handler tests.
- `backend/handler/handler_test.go` (modify): add `latestWorkflowRun` field to `scmStub`.
- `backend/main.go` (modify): wire the two new routes.

**Frontend (create/modify):**
- `src/common/types.ts` (modify): extend `FunctionStatus`, add `BuildStatus`.
- `src/common/clients/useBuildStatus.ts` (create): the SSE client hook.
- `src/common/clients/useBuildStatus.test.tsx` (create): hook test.
- `src/common/testing/consoleFetchStreamStub.ts` (create): SSE stream stub.
- `src/pages/function-list/FunctionsListPage.tsx` (modify): call `useBuildStatus()` and merge.
- `src/pages/function-list/FunctionsListPage.test.tsx` (modify): wire the stream stub.
- `src/pages/function-list/components/FunctionTable.tsx` (modify): `Building`/`BuildFailed` rendering.

**E2e (create/modify):**
- `e2e/helpers/fakegithub.ts` (modify): add `setWorkflowRun` helper.
- `e2e/use-cases/build-status/build-status.test.ts` (create): end-to-end test.

---

## Phase 1: Fake GitHub Actions API

### Task 1: Fake GitHub run state + admin control

**Files:**
- Modify: `backend/fakegithub/server.go`
- Test: `backend/fakegithub/server_test.go`

- [ ] **Step 1: Write the failing test**

Add to `backend/fakegithub/server_test.go`, inside `Describe("Admin API", ...)` (after the existing `It`):

```go
	It("stores a scripted workflow run via /_admin/actions/runs", func() {
		ts, cl := startServer()
		seedRepo(ts)

		setWorkflowRun(ts, `{
			"owner": "testuser", "repo": "test-func", "branch": "main",
			"headSha": "abc123", "status": "in_progress", "conclusion": ""
		}`)

		run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main")
		Expect(err).NotTo(HaveOccurred())
		Expect(run).NotTo(BeNil())
		Expect(run.Status).To(Equal("in_progress"))
		Expect(run.HeadSHA).To(Equal("abc123"))
	})

	It("clears workflow runs on reset", func() {
		ts, cl := startServer()
		seedRepo(ts)
		setWorkflowRun(ts, `{"owner":"testuser","repo":"test-func","branch":"main","status":"completed","conclusion":"success"}`)

		resetFakeGitHub(ts)
		seedRepo(ts)

		run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main")
		Expect(err).NotTo(HaveOccurred())
		Expect(run).To(BeNil())
	})
```

Add this helper next to `seedRepo` in the same file:

```go
func setWorkflowRun(ts *httptest.Server, body string) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, ts.URL+"/_admin/actions/runs", strings.NewReader(body))
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	ExpectWithOffset(1, resp.StatusCode).To(Equal(200))
	resp.Body.Close()
}
```

> Note: this test also depends on `LatestWorkflowRun` (Task 4/5). It will not compile until those exist. If executing strictly one task at a time, temporarily assert via a raw HTTP GET to `/repos/testuser/test-func/actions/runs` instead, then switch to `cl.LatestWorkflowRun` after Task 5. The recommended path is to implement Tasks 1-5 as a group, running the fakegithub suite once `LatestWorkflowRun` lands.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./fakegithub/ -run TestFakeGitHub`
Expected: FAIL (compile error: `LatestWorkflowRun` undefined and/or 404 on `/_admin/actions/runs`).

- [ ] **Step 3: Add run state to the `repo` struct and Server**

In `backend/fakegithub/server.go`, add fields to `repo`:

```go
type repo struct {
	Owner         string
	Name          string
	DefaultBranch string
	Topics        []string
	Files         map[string]string // path -> content (source of truth)
	Blobs         map[string]string // sha -> content
	Trees         map[string][]treeEntry
	Commits       map[string]*commit
	Refs          map[string]string // "refs/heads/main" -> commit sha
	Secrets       map[string]string // name -> encrypted value
	Runs          []workflowRun     // scripted GitHub Actions runs, most recent last
}
```

Add the run/job/step types (near the `commit` type):

```go
type workflowRun struct {
	ID         int64         `json:"id"`
	HeadBranch string        `json:"head_branch"`
	HeadSHA    string        `json:"head_sha"`
	Status     string        `json:"status"`     // queued | in_progress | completed
	Conclusion string        `json:"conclusion"` // success | failure | cancelled | timed_out | ""
	HTMLURL    string        `json:"html_url"`
	Jobs       []workflowJob `json:"-"` // returned by the jobs endpoint, not the runs listing
}

type workflowJob struct {
	ID         int64          `json:"id"`
	Name       string         `json:"name"`
	Status     string         `json:"status"`
	Conclusion string         `json:"conclusion"`
	Steps      []workflowStep `json:"steps"`
}

type workflowStep struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	Number     int    `json:"number"`
}
```

Add a monotonic run-ID counter to `Server`:

```go
type Server struct {
	mu    sync.Mutex
	user  User
	pat   string           // required PAT for API routes (empty = no auth check)
	repos map[string]*repo // "owner/name" -> repo

	pubKey    [32]byte
	privKey   [32]byte
	pubKeyB64 string
	keyID     string

	runIDSeq int64 // monotonic id source for scripted workflow runs

	mux *http.ServeMux
}
```

- [ ] **Step 4: Register routes and add the admin handler**

In `routes()`, add under the Actions secrets section:

```go
	// Actions runs (build status)
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/actions/runs", s.handleListWorkflowRuns)
	s.mux.HandleFunc("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", s.handleListWorkflowJobs)
```

And under the Admin API section:

```go
	s.mux.HandleFunc("POST /_admin/actions/runs", s.handleAdminSetRun)
```

Add the admin handler (near `handleAdminSeed`):

```go
type adminRunRequest struct {
	Owner      string        `json:"owner"`
	Repo       string        `json:"repo"`
	Branch     string        `json:"branch"`
	HeadSHA    string        `json:"headSha"`
	Status     string        `json:"status"`
	Conclusion string        `json:"conclusion"`
	Jobs       []workflowJob `json:"jobs"`
}

func (s *Server) handleAdminSetRun(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var req adminRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid run request: "+err.Error())
		return
	}
	if req.Branch == "" {
		req.Branch = "main"
	}

	key := req.Owner + "/" + req.Repo
	rp, ok := s.repos[key]
	if !ok {
		writeError(w, http.StatusNotFound, "repo not seeded: "+key)
		return
	}

	s.runIDSeq++
	run := workflowRun{
		ID:         s.runIDSeq,
		HeadBranch: req.Branch,
		HeadSHA:    req.HeadSHA,
		Status:     req.Status,
		Conclusion: req.Conclusion,
		HTMLURL:    fmt.Sprintf("https://github.com/%s/actions/runs/%d", key, s.runIDSeq),
		Jobs:       req.Jobs,
	}
	// Replace the latest run for this branch, keep others.
	kept := rp.Runs[:0:0]
	for _, existing := range rp.Runs {
		if existing.HeadBranch != req.Branch {
			kept = append(kept, existing)
		}
	}
	rp.Runs = append(kept, run)

	writeJSON(w, http.StatusOK, map[string]any{"status": "run set", "id": run.ID})
}
```

Also clear runs in `handleAdminReset` (it already resets the whole `s.repos` map, so runs are cleared automatically; no change needed there since runs live on `repo`).

- [ ] **Step 5: Run test to verify admin storage passes**

Run: `cd backend && go test ./fakegithub/ -run TestFakeGitHub`
Expected: the two new admin specs still fail to compile until Tasks 4-5 land `LatestWorkflowRun`; the Actions GET endpoints (Task 2/3) are exercised by Task 5's client. Proceed to Task 2.

- [ ] **Step 6: Commit** (after Tasks 1-3 in this phase compile together)

```bash
git add backend/fakegithub/server.go backend/fakegithub/server_test.go
git commit -m "feat(fakegithub): add scripted workflow run state and admin control"
```

### Task 2: Fake GitHub `GET .../actions/runs`

**Files:**
- Modify: `backend/fakegithub/server.go`

- [ ] **Step 1: Add the runs listing handler**

```go
func (s *Server) handleListWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	branch := r.URL.Query().Get("branch")
	// GitHub returns most-recent first; our slice keeps most-recent last, so reverse.
	var runs []workflowRun
	for i := len(rp.Runs) - 1; i >= 0; i-- {
		run := rp.Runs[i]
		if branch == "" || run.HeadBranch == branch {
			runs = append(runs, run)
		}
	}
	if runs == nil {
		runs = []workflowRun{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total_count":   len(runs),
		"workflow_runs": runs,
	})
}
```

- [ ] **Step 2: Verify build** — `cd backend && go build ./...` → PASS.

### Task 3: Fake GitHub `GET .../actions/runs/{run_id}/jobs`

**Files:**
- Modify: `backend/fakegithub/server.go` (add `strconv` import)

- [ ] **Step 1: Add the jobs listing handler**

```go
func (s *Server) handleListWorkflowJobs(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rp := s.getRepo(r)
	if rp == nil {
		writeError(w, http.StatusNotFound, "Not Found")
		return
	}

	runID, err := strconv.ParseInt(r.PathValue("run_id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid run id")
		return
	}

	for _, run := range rp.Runs {
		if run.ID == runID {
			jobs := run.Jobs
			if jobs == nil {
				jobs = []workflowJob{}
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"total_count": len(jobs),
				"jobs":        jobs,
			})
			return
		}
	}
	writeError(w, http.StatusNotFound, "Not Found")
}
```

Add `"strconv"` to the import block.

- [ ] **Step 2: Verify build** — `cd backend && go build ./...` → PASS.

---

## Phase 2: SCM `LatestWorkflowRun`

### Task 4: Extend the `scm.Client` interface

**Files:**
- Modify: `backend/scm/client.go`
- Modify: `backend/handler/handler_test.go` (keep `scmStub` implementing the interface)

- [ ] **Step 1: Add the type and interface method**

In `backend/scm/client.go`, add to the `Client` interface (after `DeleteRepo`):

```go
	LatestWorkflowRun(ctx context.Context, owner, repo, branch string) (*WorkflowRun, error)
```

And add the type (after the `FileEntry` type):

```go
// WorkflowRun is the latest GitHub Actions run for a repo branch.
// A nil *WorkflowRun means the branch has no runs.
type WorkflowRun struct {
	ID            int64
	Status        string // queued | in_progress | completed
	Conclusion    string // success | failure | cancelled | timed_out | ""
	HeadSHA       string
	HTMLURL       string
	FailureReason string // set for failures: "<job> / <step>" summary
}
```

- [ ] **Step 2: Add the stub field so tests still compile**

In `backend/handler/handler_test.go`, add to `scmStub`:

```go
	latestWorkflowRun func(ctx context.Context, owner, repo, branch string) (*scm.WorkflowRun, error)
```

And add the method (after `DeleteRepo`):

```go
func (s *scmStub) LatestWorkflowRun(ctx context.Context, owner, repo, branch string) (*scm.WorkflowRun, error) {
	if s.latestWorkflowRun != nil {
		return s.latestWorkflowRun(ctx, owner, repo, branch)
	}
	return nil, nil
}
```

- [ ] **Step 3: Verify it fails to build** — `cd backend && go build ./...`
Expected: FAIL — `*ghClient` does not implement `scm.Client` (missing `LatestWorkflowRun`). Fixed in Task 5.

### Task 5: GitHub `LatestWorkflowRun` (happy path)

**Files:**
- Modify: `backend/scm/github/client.go` (add `log/slog` import)
- Test: `backend/fakegithub/server_test.go`

- [ ] **Step 1: Write the failing test**

Add to `backend/fakegithub/server_test.go` a new top-level `Describe` (before the closing of the outer `Describe`):

```go
	Describe("LatestWorkflowRun", func() {
		It("returns nil when the repo has no runs", func() {
			ts, cl := startServer()
			seedRepo(ts)

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).To(BeNil())
		})

		It("returns the latest in-progress run", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{"owner":"testuser","repo":"test-func","branch":"main","headSha":"sha1","status":"in_progress","conclusion":""}`)

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).NotTo(BeNil())
			Expect(run.Status).To(Equal("in_progress"))
			Expect(run.Conclusion).To(BeEmpty())
			Expect(run.HeadSHA).To(Equal("sha1"))
			Expect(run.HTMLURL).To(ContainSubstring("/actions/runs/"))
			Expect(run.FailureReason).To(BeEmpty())
		})

		It("filters by branch", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{"owner":"testuser","repo":"test-func","branch":"other","status":"completed","conclusion":"success"}`)

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).To(BeNil())
		})
	})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./fakegithub/ -run TestFakeGitHub`
Expected: FAIL (compile error until the method exists).

- [ ] **Step 3: Implement `LatestWorkflowRun`**

In `backend/scm/github/client.go`, add `"log/slog"` to the imports, then add:

```go
func (c *ghClient) LatestWorkflowRun(ctx context.Context, owner, repo, branch string) (*scm.WorkflowRun, error) {
	opts := &ghlib.ListWorkflowRunsOptions{
		Branch:      branch,
		ListOptions: ghlib.ListOptions{PerPage: 1},
	}
	runs, _, err := c.client.Actions.ListRepositoryWorkflowRuns(ctx, owner, repo, opts)
	if err != nil {
		return nil, fmt.Errorf("list workflow runs for %s/%s: %w", owner, repo, mapErr(err))
	}
	if len(runs.WorkflowRuns) == 0 {
		return nil, nil
	}

	run := runs.WorkflowRuns[0]
	result := &scm.WorkflowRun{
		ID:         run.GetID(),
		Status:     run.GetStatus(),
		Conclusion: run.GetConclusion(),
		HeadSHA:    run.GetHeadSHA(),
		HTMLURL:    run.GetHTMLURL(),
	}
	if result.Conclusion == "failure" {
		result.FailureReason = c.failureReason(ctx, owner, repo, result.ID)
	}
	return result, nil
}

// failureReason returns a "<job> / <step>" summary of the first failed step,
// or the failing job name, or "" if it cannot be determined. Best-effort: never
// fails the caller.
func (c *ghClient) failureReason(ctx context.Context, owner, repo string, runID int64) string {
	jobs, _, err := c.client.Actions.ListWorkflowJobs(ctx, owner, repo, runID, nil)
	if err != nil {
		slog.Warn("failed to list workflow jobs", "repo", owner+"/"+repo, "run", runID, "err", err)
		return ""
	}
	for _, job := range jobs.Jobs {
		if job.GetConclusion() != "failure" {
			continue
		}
		for _, step := range job.Steps {
			if step.GetConclusion() == "failure" {
				return job.GetName() + " / " + step.GetName()
			}
		}
		return job.GetName()
	}
	return ""
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./fakegithub/ -run TestFakeGitHub`
Expected: PASS (all `LatestWorkflowRun` and admin specs green).

- [ ] **Step 5: Commit**

```bash
git add backend/scm/client.go backend/scm/github/client.go backend/handler/handler_test.go backend/fakegithub/server_test.go
git commit -m "feat(scm): add LatestWorkflowRun with GitHub Actions implementation"
```

### Task 6: GitHub `LatestWorkflowRun` failure reason

**Files:**
- Test: `backend/fakegithub/server_test.go`

- [ ] **Step 1: Write the failing test**

Add inside the `Describe("LatestWorkflowRun", ...)` block:

```go
		It("composes a failure reason from the first failed step", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{
				"owner":"testuser","repo":"test-func","branch":"main","headSha":"badsha",
				"status":"completed","conclusion":"failure",
				"jobs":[{
					"id":1,"name":"build","status":"completed","conclusion":"failure",
					"steps":[
						{"name":"checkout","status":"completed","conclusion":"success","number":1},
						{"name":"go test","status":"completed","conclusion":"failure","number":2}
					]
				}]
			}`)

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).NotTo(BeNil())
			Expect(run.Conclusion).To(Equal("failure"))
			Expect(run.FailureReason).To(Equal("build / go test"))
		})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd backend && go test ./fakegithub/ -run TestFakeGitHub`
Expected: PASS (implementation from Task 5 already composes the reason).

- [ ] **Step 3: Commit**

```bash
git add backend/fakegithub/server_test.go
git commit -m "test(scm): cover workflow-run failure reason composition"
```

> Manual cross-check (not automated): with the token in `gh-token.txt`, point a scratch program or a temporary test at real GitHub repo `matejvasek/fn-testing-a` and confirm `LatestWorkflowRun` returns sane values against the live Actions API. Do not commit the token or a live test.

---

## Phase 3: Backend build endpoints

### Task 7: Snapshot endpoint `GET /api/v1/func/build/status`

**Files:**
- Create: `backend/handler/build.go`
- Test: `backend/handler/build_test.go`

- [ ] **Step 1: Write the failing test**

Create `backend/handler/build_test.go`:

```go
package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("HandleBuildStatus", func() {
	It("returns 401 without an SCM token", func() {
		withSCMStub(&scmStub{})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/build/status", nil)
		w := httptest.NewRecorder()

		(&Handlers{}).HandleBuildStatus(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})

	It("maps a run to a build-status item keyed by owner/repo", func() {
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{{Owner: "alice", Name: "fn", DefaultBranch: "main"}}, nil
			},
			latestWorkflowRun: func(ctx context.Context, owner, repo, branch string) (*scm.WorkflowRun, error) {
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
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{{Owner: "alice", Name: "fn", DefaultBranch: "main"}}, nil
			},
			latestWorkflowRun: func(ctx context.Context, owner, repo, branch string) (*scm.WorkflowRun, error) {
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
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return nil, scm.ErrUnauthorized
			},
		})
		req := httptest.NewRequest(http.MethodGet, "/api/v1/func/build/status", nil)
		req.Header.Set("X-SCM-Token", "pat")
		w := httptest.NewRecorder()

		(&Handlers{}).HandleBuildStatus(w, req)

		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./handler/ -run TestHandler`
Expected: FAIL (compile error: `HandleBuildStatus`, `buildSnapshot` undefined).

> The handler suite entrypoint already exists (Ginkgo `RunSpecs`). If the run name differs, run `cd backend && go test ./handler/`.

- [ ] **Step 3: Create `backend/handler/build.go`**

```go
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
}

type buildSnapshot struct {
	Functions []buildStatusItem `json:"functions"`
}

func deriveBuildStatus(run *scm.WorkflowRun) string {
	if run == nil {
		return "None"
	}
	switch run.Status {
	case "queued", "in_progress":
		return "Building"
	case "completed":
		if run.Conclusion == "success" {
			return "Succeeded"
		}
		return "Failed"
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

// buildStatusSnapshot fetches the latest run for each repo and builds a sorted snapshot.
func buildStatusSnapshot(ctx context.Context, client scm.Client, repos []scm.Repo) buildSnapshot {
	items := make([]buildStatusItem, len(repos))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, repo := range repos {
		g.Go(func() error {
			key := repo.Owner + "/" + repo.Name
			run, err := client.LatestWorkflowRun(ctx, repo.Owner, repo.Name, repo.DefaultBranch)
			if err != nil {
				slog.Warn("failed to get workflow run", "repo", key, "err", err)
				items[i] = buildStatusItem{Key: key, BuildStatus: "None"}
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

	snap := buildStatusSnapshot(r.Context(), client, repos)
	writeJSON(w, http.StatusOK, snap)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./handler/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/handler/build.go backend/handler/build_test.go
git commit -m "feat(handler): add build status snapshot endpoint"
```

### Task 8: SSE endpoint `GET /api/v1/func/build/watch`

**Files:**
- Modify: `backend/handler/build.go`
- Test: `backend/handler/build_test.go`

- [ ] **Step 1: Write the failing test**

Add to `backend/handler/build_test.go` (add imports `"bufio"`, `"strings"`, `"sync"`, `"time"`):

```go
var _ = Describe("HandleBuildWatch", func() {
	It("emits an initial snapshot then a new snapshot on change", func() {
		origPoll := buildPollInterval
		origHeartbeat := buildHeartbeatInterval
		buildPollInterval = 10 * time.Millisecond
		buildHeartbeatInterval = time.Hour
		DeferCleanup(func() {
			buildPollInterval = origPoll
			buildHeartbeatInterval = origHeartbeat
		})

		var mu sync.Mutex
		calls := 0
		withSCMStub(&scmStub{
			listRepos: func(ctx context.Context) ([]scm.Repo, error) {
				return []scm.Repo{{Owner: "alice", Name: "fn", DefaultBranch: "main"}}, nil
			},
			latestWorkflowRun: func(ctx context.Context, owner, repo, branch string) (*scm.WorkflowRun, error) {
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
		first := readSSEData(reader)
		Expect(first).To(ContainSubstring(`"buildStatus":"Building"`))

		second := readSSEData(reader)
		Expect(second).To(ContainSubstring(`"buildStatus":"Failed"`))
		Expect(second).To(ContainSubstring(`"failureReason":"build / test"`))
	})

	It("returns 401 without an SCM token", func() {
		withSCMStub(&scmStub{})
		req := httptest.NewRequest(http.MethodGet, "/watch", nil)
		w := httptest.NewRecorder()
		(&Handlers{}).HandleBuildWatch(w, req)
		Expect(w.Code).To(Equal(http.StatusUnauthorized))
	})
})

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./handler/`
Expected: FAIL (compile error: `HandleBuildWatch` undefined).

- [ ] **Step 3: Implement `HandleBuildWatch`**

Append to `backend/handler/build.go`:

```go
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

	snap := buildStatusSnapshot(ctx, client, repos)
	if err := writeSnapshotEvent(w, snap); err != nil {
		return
	}
	flusher.Flush()
	prev := snapshotKey(snap)

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
			next := buildStatusSnapshot(ctx, client, repos)
			key := snapshotKey(next)
			if key == prev {
				continue
			}
			prev = key
			if err := writeSnapshotEvent(w, next); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSnapshotEvent(w io.Writer, snap buildSnapshot) error {
	data, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: build-status\ndata: %s\n\n", data)
	return err
}

func snapshotKey(snap buildSnapshot) string {
	data, _ := json.Marshal(snap)
	return string(data)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./handler/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/handler/build.go backend/handler/build_test.go
git commit -m "feat(handler): add build status SSE watch endpoint"
```

### Task 9: Wire routes in `main.go`

**Files:**
- Modify: `backend/main.go`

- [ ] **Step 1: Add the routes**

After the `mux.HandleFunc("POST /api/v1/func/create", ...)` line, add:

```go
	mux.HandleFunc("GET /api/v1/func/build/status", h.HandleBuildStatus)
	mux.HandleFunc("GET /api/v1/func/build/watch", h.HandleBuildWatch)
```

- [ ] **Step 2: Verify build** — `cd backend && go build ./...` → PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/main.go
git commit -m "feat(backend): wire build status routes"
```

> Ask the user to restart the dev environment (`hack/dev.sh`) before manual verification; you cannot restart it yourself.

---

## Phase 4: Frontend

### Task 10: Types

**Files:**
- Modify: `src/common/types.ts`

- [ ] **Step 1: Extend `FunctionStatus`**

Replace the `FunctionStatus` union with:

```ts
export type FunctionStatus =
  | 'CreatingRepo'
  | 'Pushing'
  | 'PushedToGitHub'
  | 'Building'
  | 'Deploying'
  | 'Running'
  | 'ScaledToZero'
  | 'Error'
  | 'BuildFailed'
  | 'Unknown'
  | 'NotDeployed';
```

- [ ] **Step 2: Add the `BuildStatus` type**

Append to `src/common/types.ts`:

```ts
export interface BuildStatus {
  buildStatus: 'Building' | 'Succeeded' | 'Failed' | 'None';
  conclusion?: string;
  runURL?: string;
  failureReason?: string;
}
```

- [ ] **Step 3: Verify typecheck** — `npm run type-check` (or `npx tsc --noEmit`) → PASS.

### Task 11: `consoleFetchStreamStub` testing helper

**Files:**
- Create: `src/common/testing/consoleFetchStreamStub.ts`

- [ ] **Step 1: Create the stub**

```ts
// Test double for the SSE stream consumed by useBuildStatus.
// Mirrors the setFixtures pattern in useK8sWatchResourceStub.ts:
// a module-level fixture that tests set, and a stub function wired into
// the mocked consoleFetch.

let frames: string[] = [];
let keepOpen = false;

export function setStreamFrames(newFrames: string[], opts?: { keepOpen?: boolean }) {
  frames = newFrames;
  keepOpen = opts?.keepOpen ?? false;
}

export function resetStreamFrames() {
  frames = [];
  keepOpen = false;
}

// buildStatusFrame formats a single SSE build-status event.
export function buildStatusFrame(functions: unknown[]): string {
  return `event: build-status\ndata: ${JSON.stringify({ functions })}\n\n`;
}

// consoleFetchStub matches the consoleFetch signature used by useBuildStatus:
// consoleFetch(url, options) -> Promise<Response>.
export const consoleFetchStub = (_url: string, options?: RequestInit): Promise<Response> => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      if (!keepOpen) {
        controller.close();
        return;
      }
      const signal = options?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      }
    },
  });
  return Promise.resolve(new Response(stream, { status: 200 }));
};
```

- [ ] **Step 2: Verify typecheck** — `npx tsc --noEmit` → PASS.

### Task 12: `useBuildStatus` hook

**Files:**
- Create: `src/common/clients/useBuildStatus.ts`
- Test: `src/common/clients/useBuildStatus.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/common/clients/useBuildStatus.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { PAT_KEY } from '../types';

const streamStub = await vi.hoisted(
  async () => import('../testing/consoleFetchStreamStub'),
);

vi.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: streamStub.consoleFetchStub,
}));

import { useBuildStatus } from './useBuildStatus';

describe('useBuildStatus', () => {
  beforeEach(() => {
    sessionStorage.setItem(PAT_KEY, 'test-pat');
    streamStub.resetStreamFrames();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('parses a build-status frame into a keyed map', async () => {
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame([
        { key: 'alice/fn', buildStatus: 'Building' },
        { key: 'alice/gn', buildStatus: 'Failed', failureReason: 'build / test', runURL: 'u' },
      ]),
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('alice/fn')?.buildStatus).toBe('Building');
    expect(result.current.get('alice/gn')?.failureReason).toBe('build / test');
  });

  it('ignores heartbeat comment frames', async () => {
    streamStub.setStreamFrames([
      ':\n\n',
      streamStub.buildStatusFrame([{ key: 'alice/fn', buildStatus: 'Succeeded' }]),
    ]);

    const { result } = renderHook(() => useBuildStatus());

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get('alice/fn')?.buildStatus).toBe('Succeeded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/common/clients/useBuildStatus.test.tsx`
Expected: FAIL (cannot resolve `./useBuildStatus`).

- [ ] **Step 3: Create `src/common/clients/useBuildStatus.ts`**

```ts
import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';
import { useEffect, useState } from 'react';
import { BuildStatus, PAT_KEY, PROXY_BASE } from '../types';

const RECONNECT_DELAY_MS = 3000;

interface BuildStatusItem {
  key: string;
  buildStatus: BuildStatus['buildStatus'];
  conclusion?: string;
  runURL?: string;
  failureReason?: string;
  headSHA?: string;
}

interface BuildSnapshot {
  functions: BuildStatusItem[];
}

// useBuildStatus streams per-function GitHub Actions build status over SSE and
// returns it keyed by "owner/repo". The backend scopes the stream to the
// authenticated user, so no arguments are required.
export function useBuildStatus(): ReadonlyMap<string, BuildStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, BuildStatus>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function run() {
      while (!cancelled) {
        const pat = sessionStorage.getItem(PAT_KEY);
        if (!pat) return;
        try {
          const res = await consoleFetch(`${PROXY_BASE}/api/v1/func/build/watch`, {
            headers: { 'X-SCM-Token': pat },
            signal: controller.signal,
          });
          if (!res.body) return;
          await readStream(res.body, (snap) => {
            if (!cancelled) setStatuses(toMap(snap));
          });
        } catch {
          if (cancelled) return;
        }
        // Stream ended or errored; back off, then reconnect.
        await delay(RECONNECT_DELAY_MS, controller.signal);
      }
    }

    run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return statuses;
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  onSnapshot: (snap: BuildSnapshot) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const snap = parseFrame(frame);
      if (snap) onSnapshot(snap);
    }
  }
}

function parseFrame(frame: string): BuildSnapshot | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat / comment
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (event && event !== 'build-status') return null;
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as BuildSnapshot;
  } catch {
    return null;
  }
}

function toMap(snap: BuildSnapshot): ReadonlyMap<string, BuildStatus> {
  return new Map(
    (snap.functions ?? []).map((f) => [
      f.key,
      {
        buildStatus: f.buildStatus,
        conclusion: f.conclusion,
        runURL: f.runURL,
        failureReason: f.failureReason,
      },
    ]),
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const id = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(id);
      resolve();
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/common/clients/useBuildStatus.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common/types.ts src/common/testing/consoleFetchStreamStub.ts src/common/clients/useBuildStatus.ts src/common/clients/useBuildStatus.test.tsx
git commit -m "feat(frontend): add useBuildStatus SSE hook"
```

### Task 13: List page merge

**Files:**
- Modify: `src/pages/function-list/components/FunctionTable.tsx` (add fields to `FunctionTableItem`)
- Modify: `src/pages/function-list/FunctionsListPage.tsx`

- [ ] **Step 1: Extend `FunctionTableItem`**

In `src/pages/function-list/components/FunctionTable.tsx`, extend the interface:

```ts
export interface FunctionTableItem {
  name: string;
  repoName: string;
  owner: string;
  runtime: string;
  status: FunctionStatus;
  url: string;
  replicas: number;
  namespace: string;
  mainResource?: K8sResourceCommon;
  buildRunURL?: string;
  failureReason?: string;
}
```

- [ ] **Step 2: Wire `useBuildStatus` into the list hook**

In `src/pages/function-list/FunctionsListPage.tsx`:

Add imports:

```ts
import { useBuildStatus } from '../../common/clients/useBuildStatus';
import { BuildStatus, ClusterFunction, FunctionListItem } from '../../common/types';
```

(Replace the existing `ClusterFunction, FunctionListItem` import line with the one above.)

In `newItem`, carry `owner`:

```ts
function newItem(item: FunctionListItem): FunctionTableItem {
  return {
    name: item.name || item.repoName,
    repoName: item.repoName,
    owner: item.owner,
    namespace: item.namespace,
    runtime: item.runtime,
    status: item.err ? 'Error' : 'NotDeployed',
    url: '',
    replicas: 0,
  };
}
```

Replace the `functions` memo (and add the `buildStatuses` call just above it):

```ts
  const { functions: clusterFunctions, loaded: clusterLoaded } = useCluster(functionNames);
  const buildStatuses = useBuildStatus();

  const functions = useMemo(
    () =>
      functionItems.map((item) => {
        const cf = clusterFunctions.get(item.name);
        const enriched = cf ? enrichItem(item, cf) : item;
        const build = buildStatuses.get(`${item.owner}/${item.repoName}`);
        return build ? mergeBuild(enriched, build) : enriched;
      }),
    [functionItems, clusterFunctions, buildStatuses],
  );
```

Add the merge helper (next to `enrichItem`):

```ts
function mergeBuild(item: FunctionTableItem, build: BuildStatus): FunctionTableItem {
  if (build.buildStatus === 'Building') {
    return { ...item, status: 'Building' };
  }
  if (build.buildStatus === 'Failed' && item.status !== 'Running') {
    return {
      ...item,
      status: 'BuildFailed',
      buildRunURL: build.runURL,
      failureReason: build.failureReason,
    };
  }
  // Succeeded / None: fall through to the cluster-derived status.
  return item;
}
```

- [ ] **Step 3: Verify typecheck** — `npx tsc --noEmit` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/function-list/FunctionsListPage.tsx src/pages/function-list/components/FunctionTable.tsx
git commit -m "feat(frontend): merge build status into the functions list"
```

### Task 14: `StatusCell` rendering + list test

**Files:**
- Modify: `src/pages/function-list/components/FunctionTable.tsx`
- Modify: `src/pages/function-list/FunctionsListPage.test.tsx`

- [ ] **Step 1: Write the failing list test**

In `src/pages/function-list/FunctionsListPage.test.tsx`, add a hoisted stream stub import next to the existing `clusterStub` hoist:

```tsx
const streamStub = await vi.hoisted(
  async () => import('../../common/testing/consoleFetchStreamStub'),
);
```

Add `consoleFetch` to the mocked SDK (inside the `@openshift-console/dynamic-plugin-sdk` factory's returned object, alongside `consoleFetchJSON`):

```tsx
    consoleFetch: streamStub.consoleFetchStub,
```

Reset frames in `beforeEach` (after `authenticateGithubFake()`):

```tsx
    streamStub.resetStreamFrames();
```

Add a test (inside `describe('FunctionsListPage', ...)`):

```tsx
  it('shows BuildFailed with the failure reason from the build stream', async () => {
    listFunctionsStub({ response: repoListItem(funcName) });
    streamStub.setStreamFrames([
      streamStub.buildStatusFrame([
        {
          key: `twoGiants/${funcName}`,
          buildStatus: 'Failed',
          failureReason: 'build / go test',
          runURL: 'https://github.com/twoGiants/my-func/actions/runs/1',
        },
      ]),
    ]);

    render(
      <MemoryRouter>
        <FunctionsListPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Error: BuildFailed')).toBeInTheDocument();
  });
```

> Confirm `repoListItem`'s owner is `twoGiants` (the fake auth login). If it differs, use the actual owner from `repoListItem` when building the key. Read the existing `repoListItem` helper in this test file before writing the key.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/function-list/FunctionsListPage.test.tsx`
Expected: FAIL (no `Error: BuildFailed` text; `StatusCell` has no `BuildFailed` case).

- [ ] **Step 3: Update `StatusCell`**

In `src/pages/function-list/components/FunctionTable.tsx`:

Add `Tooltip` to the PatternFly import:

```ts
import { ActionList, ActionListItem, Button, Tooltip } from '@patternfly/react-core';
```

Change the `StatusCell` invocation in the table body to pass the item:

```tsx
            <Td dataLabel={t('Status')}>
              <StatusCell
                status={fn.status}
                failureReason={fn.failureReason}
                buildRunURL={fn.buildRunURL}
              />
            </Td>
```

Replace `StatusCell`:

```tsx
function StatusCell({
  status,
  failureReason,
  buildRunURL,
}: {
  status: FunctionStatus;
  failureReason?: string;
  buildRunURL?: string;
}) {
  const { t } = useTranslation('plugin__console-functions-plugin');

  switch (status) {
    case 'Running':
      return <SuccessStatus title={status} />;
    case 'Building':
    case 'Deploying':
    case 'CreatingRepo':
    case 'Pushing':
    case 'PushedToGitHub':
      return <ProgressStatus title={status} />;
    case 'Error':
      return <ErrorStatus title={status} />;
    case 'BuildFailed': {
      const badge = <ErrorStatus title={status} />;
      const withLink = buildRunURL ? (
        <a href={buildRunURL} target="_blank" rel="noopener noreferrer">
          {badge}
        </a>
      ) : (
        badge
      );
      return <Tooltip content={failureReason || t('Build failed')}>{withLink}</Tooltip>;
    }
    case 'ScaledToZero':
    case 'NotDeployed':
      return <InfoStatus title={status} />;
    case 'Unknown':
      return <StatusIconAndText title={status} icon={<ExclamationTriangleIcon />} />;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pages/function-list/`
Expected: PASS (new test and existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/function-list/components/FunctionTable.tsx src/pages/function-list/FunctionsListPage.test.tsx
git commit -m "feat(frontend): render Building and BuildFailed statuses"
```

---

## Phase 5: E2e

### Task 15: `setWorkflowRun` helper + build-status e2e test

**Files:**
- Modify: `e2e/helpers/fakegithub.ts`
- Create: `e2e/use-cases/build-status/build-status.test.ts`

- [ ] **Step 1: Add the `setWorkflowRun` helper**

Append to `e2e/helpers/fakegithub.ts`:

```ts
interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string;
  number: number;
}

interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  steps: WorkflowStep[];
}

interface WorkflowRunInput {
  headSha?: string;
  status: string; // queued | in_progress | completed
  conclusion?: string; // success | failure | ...
  jobs?: WorkflowJob[];
}

export async function setWorkflowRun(
  owner: string,
  name: string,
  branch: string,
  run: WorkflowRunInput,
): Promise<void> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/_admin/actions/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner,
      repo: name,
      branch,
      headSha: run.headSha ?? '',
      status: run.status,
      conclusion: run.conclusion ?? '',
      jobs: run.jobs ?? [],
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to set workflow run for ${owner}/${name} in fake GitHub: ${resp.status} ${await resp.text()}`,
    );
  }
}
```

- [ ] **Step 2: Write the e2e test**

Create `e2e/use-cases/build-status/build-status.test.ts`:

```ts
import { test, expect } from '../../fixtures/authenticated-page';
import { navigateToFunctionsList } from '../../helpers/navigation';
import { seedRepo, setWorkflowRun } from '../../helpers/fakegithub';
import { E2E_USER } from '../../helpers/constants';

const FUNC_NAME = 'build-status-func';

test.describe('Build status', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await seedRepo(E2E_USER, FUNC_NAME, 'main', ['serverless-function'], [
      {
        path: 'func.yaml',
        mode: '100644',
        content: `name: ${FUNC_NAME}\nruntime: node\nnamespace: default\n`,
      },
    ]);
  });

  test('reflects an in-progress run then a failure over SSE', async ({ page }) => {
    await setWorkflowRun(E2E_USER, FUNC_NAME, 'main', {
      headSha: 'sha-building',
      status: 'in_progress',
    });

    await navigateToFunctionsList(page);
    const grid = page.getByRole('grid', { name: 'Functions' });
    await expect(grid).toBeVisible({ timeout: 30_000 });

    const row = grid.locator('tbody tr').filter({ hasText: FUNC_NAME });
    await expect(row.getByText('Building')).toBeVisible({ timeout: 30_000 });

    // Script a failure; the list streams over SSE, so it should update without a refresh.
    await setWorkflowRun(E2E_USER, FUNC_NAME, 'main', {
      headSha: 'sha-failed',
      status: 'completed',
      conclusion: 'failure',
      jobs: [
        {
          id: 1,
          name: 'build',
          status: 'completed',
          conclusion: 'failure',
          steps: [
            { name: 'checkout', status: 'completed', conclusion: 'success', number: 1 },
            { name: 'go test', status: 'completed', conclusion: 'failure', number: 2 },
          ],
        },
      ],
    });

    await expect(row.getByText('BuildFailed')).toBeVisible({ timeout: 30_000 });
  });
});
```

- [ ] **Step 3: Run the e2e test**

Run: `npm run test:e2e -- build-status` (confirm the exact e2e invocation in `package.json`; use `make dev-fake-gh` env as other e2e tests require).
Expected: PASS. The `Building` state appears on load, and `BuildFailed` appears after the second `setWorkflowRun` without navigating again.

> The dev environment must be running with fakegithub. Ask the user to start/restart it (`make dev-fake-gh` / `hack/dev.sh`); you cannot start it yourself.

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers/fakegithub.ts e2e/use-cases/build-status/build-status.test.ts
git commit -m "test(e2e): cover build status Building and BuildFailed over SSE"
```

---

## Phase 6: Revisit

### Task 16: Reconcile backend with frontend findings

- [ ] **Step 1:** Review whether the frontend needs any snapshot field not currently emitted (e.g. an explicit `branch` for key disambiguation). If so, add it to `buildStatusItem` and the `BuildStatusItem` TS interface together, with a test on each side.
- [ ] **Step 2:** Confirm the SSE reconnect behavior is acceptable in the running dev environment (watch the network panel: stream stays open, heartbeats arrive, status changes propagate). Note any tuning of `buildPollInterval` needed for GitHub rate limits.
- [ ] **Step 3:** Run the full suites: `cd backend && go test ./...` and `npx vitest run`. Both green.
- [ ] **Step 4:** Move this plan to `docs/plans/completed/` when the story is done.

---

## Notes on conventions

- No em dashes in code comments or docs (project style).
- Backend: stdlib + go-github only; SSE is `net/http` + `http.Flusher`, no new deps.
- Tests: red/green/refactor, one test at a time; stub the network boundary, never `vi.mock` our own hooks (SRVOCF-822 precedent).
- E2e runs against the real backend connected to fakegithub; no `page.route` GitHub mocking.
