package fakegithub_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/fakegithub"
	"github.com/openshift/faas-console-plugin/backend/fakegithub/action"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

type stubExecutor struct {
	called chan action.RunRequest
	result action.RunResult
}

func (e *stubExecutor) Run(_ context.Context, req action.RunRequest) (action.RunResult, error) {
	if req.Output != nil {
		_, _ = req.Output.Write(e.result.Log)
	}
	if e.called != nil {
		e.called <- req
	}
	return e.result, nil
}

func TestFakeGitHub(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "FakeGitHub Suite")
}

const testPAT = "test-pat"

var _ = Describe("FakeGitHub Server", func() {

	Describe("GetUser", func() {
		It("returns the configured user identity", func() {
			_, cl := startServer()

			user, err := cl.GetUser(context.Background())

			Expect(err).NotTo(HaveOccurred())
			Expect(user.Login).To(Equal("testuser"))
			Expect(user.AvatarURL).To(Equal("https://example.com/avatar"))
		})
	})

	Describe("InitRepo + ListRepos", func() {
		It("creates a repo and finds it via ListRepos", func() {
			_, cl := startServer()

			err := cl.InitRepo(context.Background(), "testuser", "my-func", "main", []string{"serverless-function"})
			Expect(err).NotTo(HaveOccurred())

			repos, err := cl.ListRepos(context.Background())
			Expect(err).NotTo(HaveOccurred())
			Expect(repos).To(HaveLen(1))
			Expect(repos[0].Name).To(Equal("my-func"))
			Expect(repos[0].Owner).To(Equal("testuser"))
			Expect(repos[0].DefaultBranch).To(Equal("main"))
		})

		It("returns ErrRepoExists when creating a duplicate", func() {
			_, cl := startServer()

			Expect(cl.InitRepo(context.Background(), "testuser", "dup", "main", nil)).To(Succeed())

			err := cl.InitRepo(context.Background(), "testuser", "dup", "main", nil)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("already exists"))
		})

		It("renames the default branch when it differs from the requested branch", func() {
			_, cl := startServer()

			err := cl.InitRepo(context.Background(), "testuser", "branch-test", "develop", []string{"serverless-function"})
			Expect(err).NotTo(HaveOccurred())

			repos, err := cl.ListRepos(context.Background())
			Expect(err).NotTo(HaveOccurred())
			Expect(repos).To(HaveLen(1))
			Expect(repos[0].DefaultBranch).To(Equal("develop"))
		})
	})

	Describe("Seeded repo operations", func() {
		var cl scm.Client
		var ts *httptest.Server

		BeforeEach(func() {
			ts, cl = startServer()
			seedRepo(ts)
		})

		Describe("ListRepos", func() {
			It("returns seeded repos with the serverless-function topic", func() {
				repos, err := cl.ListRepos(context.Background())

				Expect(err).NotTo(HaveOccurred())
				Expect(repos).To(HaveLen(1))
				Expect(repos[0].Name).To(Equal("test-func"))
				Expect(repos[0].Owner).To(Equal("testuser"))
				Expect(repos[0].DefaultBranch).To(Equal("main"))
			})
		})

		Describe("GetFileContent", func() {
			It("returns file content for a seeded file", func() {
				content, err := cl.GetFileContent(context.Background(), "testuser", "test-func", "main", "func.yaml")

				Expect(err).NotTo(HaveOccurred())
				Expect(content).To(ContainSubstring("name: test-func"))
			})

			It("returns 404 for a non-existent file", func() {
				_, err := cl.GetFileContent(context.Background(), "testuser", "test-func", "main", "nonexistent.txt")

				Expect(err).To(HaveOccurred())
			})
		})

		Describe("GetFiles", func() {
			It("returns all files from the repository tree", func() {
				files, err := cl.GetFiles(context.Background(), "testuser", "test-func", "main")

				Expect(err).NotTo(HaveOccurred())
				Expect(files).To(HaveLen(2))

				var paths []string
				for _, f := range files {
					paths = append(paths, f.Path)
				}
				Expect(paths).To(ContainElements("func.yaml", "index.js"))
			})

			It("returns correct file content", func() {
				files, err := cl.GetFiles(context.Background(), "testuser", "test-func", "main")

				Expect(err).NotTo(HaveOccurred())
				for _, f := range files {
					if f.Path == "func.yaml" {
						Expect(f.Content).To(ContainSubstring("name: test-func"))
					}
					if f.Path == "index.js" {
						Expect(f.Content).To(Equal("module.exports = async (context) => context;"))
					}
				}
			})
		})

		Describe("PushFiles", func() {
			It("pushes files and updates the repo state", func() {
				files := []scm.FileEntry{
					{Path: "func.yaml", Mode: "100644", Content: "name: test-func\nruntime: node\nnamespace: updated\n", Type: "blob"},
					{Path: "index.js", Mode: "100644", Content: "// updated\nmodule.exports = async (context) => context;", Type: "blob"},
				}

				err := cl.PushFiles(context.Background(), "testuser", "test-func", "main", "Update files", files)

				Expect(err).NotTo(HaveOccurred())

				// Verify the files were updated by fetching them again.
				updated, err := cl.GetFiles(context.Background(), "testuser", "test-func", "main")
				Expect(err).NotTo(HaveOccurred())
				Expect(updated).To(HaveLen(2))

				for _, f := range updated {
					if f.Path == "func.yaml" {
						Expect(f.Content).To(ContainSubstring("namespace: updated"))
					}
					if f.Path == "index.js" {
						Expect(f.Content).To(ContainSubstring("// updated"))
					}
				}
			})
		})

		Describe("StoreSecret", func() {
			It("stores a secret without error", func() {
				err := cl.StoreSecret(context.Background(), "testuser", "test-func", "KUBECONFIG", "secret-value")

				Expect(err).NotTo(HaveOccurred())
			})
		})

		Describe("StoreVariable + GetVariable", func() {
			It("stores a variable and reads it back", func() {
				err := cl.StoreVariable(context.Background(), "testuser", "test-func", "CLUSTER_API_URL", "https://api.my-cluster.example.com:6443")
				Expect(err).NotTo(HaveOccurred())

				value, err := cl.GetVariable(context.Background(), "testuser", "test-func", "CLUSTER_API_URL")
				Expect(err).NotTo(HaveOccurred())
				Expect(value).To(Equal("https://api.my-cluster.example.com:6443"))
			})

			It("returns empty string when variable does not exist", func() {
				value, err := cl.GetVariable(context.Background(), "testuser", "test-func", "NO_SUCH_VAR")
				Expect(err).NotTo(HaveOccurred())
				Expect(value).To(BeEmpty())
			})

			It("overwrites a variable when stored again", func() {
				Expect(cl.StoreVariable(context.Background(), "testuser", "test-func", "CLUSTER_API_URL", "first")).To(Succeed())
				Expect(cl.StoreVariable(context.Background(), "testuser", "test-func", "CLUSTER_API_URL", "second")).To(Succeed())

				value, err := cl.GetVariable(context.Background(), "testuser", "test-func", "CLUSTER_API_URL")
				Expect(err).NotTo(HaveOccurred())
				Expect(value).To(Equal("second"))
			})
		})

		Describe("StoreSecret plaintext storage", func() {
			It("stores the decrypted plaintext so act can read it", func() {
				err := cl.StoreSecret(context.Background(), "testuser", "test-func", "MY_SECRET", "my-plaintext-value")
				Expect(err).NotTo(HaveOccurred())
			})
		})

		Describe("Actions Runs API", func() {
			It("returns an empty run list when no runs exist", func() {
				req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
					ts.URL+"/repos/testuser/test-func/actions/workflows/func-deploy.yaml/runs", nil)
				Expect(err).NotTo(HaveOccurred())
				req.Header.Set("Authorization", "token "+testPAT)
				resp, err := ts.Client().Do(req)
				Expect(err).NotTo(HaveOccurred())
				defer resp.Body.Close()
				Expect(resp.StatusCode).To(Equal(http.StatusOK))
				var result map[string]any
				Expect(json.NewDecoder(resp.Body).Decode(&result)).To(Succeed())
				Expect(result["total_count"]).To(BeEquivalentTo(0))
				Expect(result["workflow_runs"]).To(BeEmpty())
			})

			It("returns 404 for a non-existent run ID", func() {
				req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
					ts.URL+"/repos/testuser/test-func/actions/runs/99999", nil)
				Expect(err).NotTo(HaveOccurred())
				req.Header.Set("Authorization", "token "+testPAT)
				resp, err := ts.Client().Do(req)
				Expect(err).NotTo(HaveOccurred())
				resp.Body.Close()
				Expect(resp.StatusCode).To(Equal(http.StatusNotFound))
			})

			It("returns 404 from log viewer for a non-existent run", func() {
				req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
					ts.URL+"/repos/testuser/test-func/actions/runs/99999/log", nil)
				Expect(err).NotTo(HaveOccurred())
				resp, err := ts.Client().Do(req)
				Expect(err).NotTo(HaveOccurred())
				resp.Body.Close()
				Expect(resp.StatusCode).To(Equal(http.StatusNotFound))
			})
		})

		Describe("DeleteRepo", func() {
			It("removes the repo so it is no longer listed", func() {
				err := cl.DeleteRepo(context.Background(), "testuser", "test-func")
				Expect(err).NotTo(HaveOccurred())

				repos, err := cl.ListRepos(context.Background())
				Expect(err).NotTo(HaveOccurred())
				Expect(repos).To(BeEmpty())
			})

			It("returns an error when deleting a non-existent repo", func() {
				err := cl.DeleteRepo(context.Background(), "testuser", "no-such-repo")
				Expect(err).To(HaveOccurred())
			})
		})
	})

	Describe("Authentication", func() {
		It("rejects requests with a wrong PAT", func() {
			ts, _ := startServer()

			req, err := http.NewRequest("GET", ts.URL+"/user", nil)
			Expect(err).NotTo(HaveOccurred())
			req.Header.Set("Authorization", "token wrong-pat")

			resp, err := ts.Client().Do(req)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusUnauthorized))
		})

		It("rejects requests with no credentials", func() {
			ts, _ := startServer()

			req, err := http.NewRequest("GET", ts.URL+"/user", nil)
			Expect(err).NotTo(HaveOccurred())

			resp, err := ts.Client().Do(req)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusUnauthorized))
		})
	})

	Describe("UpdateRef triggers executor", func() {
		It("creates a completed run record and log after push", func() {
			called := make(chan action.RunRequest, 1)
			stub := &stubExecutor{
				called: called,
				result: action.RunResult{Conclusion: "success", Log: []byte("all good")},
			}
			srv := fakegithub.New(fakegithub.User{Login: "testuser", AvatarURL: "https://example.com/avatar"}, testPAT)
			srv.Executor = stub
			ts2 := httptest.NewServer(srv)
			DeferCleanup(ts2.Close)
			cl2 := github.NewWithBaseURL(testPAT, ts2.URL)

			err := cl2.InitRepo(context.Background(), "testuser", "wf-test", "main", []string{"serverless-function"})
			Expect(err).NotTo(HaveOccurred())

			files := []scm.FileEntry{
				{Path: ".github/workflows/func-deploy.yaml", Mode: "100644", Type: "blob",
					Content: "name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"},
				{Path: "func.yaml", Mode: "100644", Type: "blob", Content: "name: wf-test\n"},
			}
			err = cl2.PushFiles(context.Background(), "testuser", "wf-test", "main", "add workflow", files)
			Expect(err).NotTo(HaveOccurred())

			// Executor was called with a push event.
			var req action.RunRequest
			Eventually(called, "5s").Should(Receive(&req))
			Expect(req.EventName).To(Equal("push"))
			Expect(req.Workdir).NotTo(BeEmpty())

			// Run record eventually reaches "completed".
			Eventually(func() string {
				listReq, _ := http.NewRequestWithContext(context.Background(), http.MethodGet,
					ts2.URL+"/repos/testuser/wf-test/actions/workflows/func-deploy.yaml/runs", nil)
				listReq.Header.Set("Authorization", "token "+testPAT)
				resp, err := ts2.Client().Do(listReq)
				if err != nil || resp == nil {
					return ""
				}
				defer resp.Body.Close()
				var result map[string]any
				json.NewDecoder(resp.Body).Decode(&result)
				runs, _ := result["workflow_runs"].([]any)
				if len(runs) == 0 {
					return ""
				}
				run, _ := runs[0].(map[string]any)
				return run["status"].(string)
			}, "5s", "100ms").Should(Equal("completed"))

			// Log viewer returns the captured output.
			Eventually(func() string {
				listReq, _ := http.NewRequestWithContext(context.Background(), http.MethodGet,
					ts2.URL+"/repos/testuser/wf-test/actions/workflows/func-deploy.yaml/runs", nil)
				listReq.Header.Set("Authorization", "token "+testPAT)
				resp, err := ts2.Client().Do(listReq)
				if err != nil || resp == nil {
					return ""
				}
				defer resp.Body.Close()
				var result map[string]any
				json.NewDecoder(resp.Body).Decode(&result)
				runs, _ := result["workflow_runs"].([]any)
				if len(runs) == 0 {
					return ""
				}
				run, _ := runs[0].(map[string]any)
				htmlURL, _ := run["html_url"].(string)
				if htmlURL == "" {
					return ""
				}
				logReq, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, htmlURL, nil)
				logResp, err := ts2.Client().Do(logReq)
				if err != nil || logResp == nil {
					return ""
				}
				defer logResp.Body.Close()
				b, _ := io.ReadAll(logResp.Body)
				return string(b)
			}, "5s", "100ms").Should(ContainSubstring("all good"))
		})
	})

	Describe("Admin API", func() {
		It("seeds and resets all state", func() {
			ts, cl := startServer()
			seedRepo(ts)

			repos, err := cl.ListRepos(context.Background())
			Expect(err).NotTo(HaveOccurred())
			Expect(repos).To(HaveLen(1))

			resetFakeGitHub(ts)

			repos, err = cl.ListRepos(context.Background())
			Expect(err).NotTo(HaveOccurred())
			Expect(repos).To(BeEmpty())
		})

		It("stores a scripted workflow run via /_admin/actions/runs", func() {
			ts, cl := startServer()
			seedRepo(ts)

			setWorkflowRun(ts, `{
				"owner": "testuser", "repo": "test-func", "branch": "main",
				"headSha": "abc123", "status": "in_progress", "conclusion": ""
			}`)

			run := latestRun(cl, "testuser", "test-func")
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

			run := latestRun(cl, "testuser", "test-func")
			Expect(run).To(BeNil())
		})
	})

	Describe("LatestWorkflowRun", func() {
		It("returns nil when the repo has no runs", func() {
			ts, cl := startServer()
			seedRepo(ts)

			run := latestRun(cl, "testuser", "test-func")
			Expect(run).To(BeNil())
		})

		It("returns the latest in-progress run", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{"owner":"testuser","repo":"test-func","branch":"main","headSha":"sha1","status":"in_progress","conclusion":""}`)

			run := latestRun(cl, "testuser", "test-func")
			Expect(run).NotTo(BeNil())
			Expect(run.Status).To(Equal("in_progress"))
			Expect(run.Conclusion).To(BeEmpty())
			Expect(run.HeadSHA).To(Equal("sha1"))
			Expect(run.HTMLURL).To(ContainSubstring("/actions/runs/"))
		})

		It("filters by branch", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{"owner":"testuser","repo":"test-func","branch":"other","status":"completed","conclusion":"success"}`)

			run := latestRun(cl, "testuser", "test-func")
			Expect(run).To(BeNil())
		})

		It("scopes to the func workflow file, ignoring runs of other workflows", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{
				"owner":"testuser","repo":"test-func","branch":"main",
				"status":"completed","conclusion":"success","workflow":"other.yaml"
			}`)

			run := latestRun(cl, "testuser", "test-func")
			Expect(run).To(BeNil())
		})

		It("returns a completed failed run", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{
				"owner":"testuser","repo":"test-func","branch":"main","headSha":"badsha",
				"status":"completed","conclusion":"failure"
			}`)

			run := latestRun(cl, "testuser", "test-func")
			Expect(run).NotTo(BeNil())
			Expect(run.Status).To(Equal("completed"))
			Expect(run.Conclusion).To(Equal("failure"))
			Expect(run.HTMLURL).To(ContainSubstring("/actions/runs/"))
		})

		It("returns a latest run of default branch", func() {
			ts, cl := startServer()
			seedRepo(ts)

			setWorkflowRun(ts, `{
				"owner":"testuser","repo":"test-func","branch":"main","headSha":"badsha",
				"status":"completed","conclusion":"failure"
			}`)

			setWorkflowRun(ts, `{
				"owner":"testuser","repo":"test-func","branch":"main","headSha":"goodsh",
				"status":"completed","conclusion":"success"
			}`)

			setWorkflowRun(ts, `{
				"owner":"testuser","repo":"test-func","branch":"devel","headSha":"badsha",
				"status":"completed","conclusion":"failure"
			}`)

			run := latestRun(cl, "testuser", "test-func")
			Expect(run).NotTo(BeNil())
			Expect(run.Status).To(Equal("completed"))
			Expect(run.Conclusion).To(Equal("success"))
			Expect(run.HTMLURL).To(ContainSubstring("/actions/runs/"))
		})
	})
})

// latestRun drives WatchWorkflowRuns and returns the given repo's latest run
// from the initial snapshot. The repo must be discoverable (seeded with the
// serverless-function topic) before calling. WatchWorkflowRuns uses the repo's
// default branch, so callers seed runs on the default branch (main).
func latestRun(cl scm.Client, owner, repo string) *scm.WorkflowRun {
	ctx, cancel := context.WithCancel(context.Background())
	DeferCleanup(cancel)
	watch, err := cl.WatchWorkflowRuns(ctx, "func-deploy.yaml")
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	var event scm.WorkflowRunsOrErr
	EventuallyWithOffset(1, watch.ResultChan()).Should(Receive(&event))
	ExpectWithOffset(1, event.Err).NotTo(HaveOccurred())
	for _, rr := range event.Runs {
		if rr.Repo.Owner == owner && rr.Repo.Name == repo {
			return rr.Run
		}
	}
	return nil
}

func startServer() (*httptest.Server, scm.Client) {
	srv := fakegithub.New(fakegithub.User{Login: "testuser", AvatarURL: "https://example.com/avatar"}, testPAT)
	ts := httptest.NewServer(srv)
	DeferCleanup(ts.Close)
	client := github.NewWithBaseURL(testPAT, ts.URL)
	return ts, client
}

func seedRepo(ts *httptest.Server) {
	body := `{
		"owner": "testuser",
		"repo": "test-func",
		"branch": "main",
		"topics": ["serverless-function"],
		"files": [
			{"path": "func.yaml", "mode": "100644", "content": "name: test-func\nruntime: node\nnamespace: default\n"},
			{"path": "index.js", "mode": "100644", "content": "module.exports = async (context) => context;"}
		]
	}`
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, ts.URL+"/_admin/seed", strings.NewReader(body))
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	ExpectWithOffset(1, resp.StatusCode).To(Equal(200))
	resp.Body.Close()
}

func setWorkflowRun(ts *httptest.Server, body string) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, ts.URL+"/_admin/actions/runs", strings.NewReader(body))
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	ExpectWithOffset(1, resp.StatusCode).To(Equal(200))
	resp.Body.Close()
}

func resetFakeGitHub(ts *httptest.Server) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, ts.URL+"/_admin/reset", nil)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	ExpectWithOffset(1, resp.StatusCode).To(Equal(200))
	resp.Body.Close()
}
