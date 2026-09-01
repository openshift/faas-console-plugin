package fakegithub_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/fakegithub"
	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github"
)

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

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main", "func-deploy.yaml")
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

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main", "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).To(BeNil())
		})
	})

	Describe("LatestWorkflowRun", func() {
		It("returns nil when the repo has no runs", func() {
			ts, cl := startServer()
			seedRepo(ts)

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main", "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).To(BeNil())
		})

		It("returns the latest in-progress run", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{"owner":"testuser","repo":"test-func","branch":"main","headSha":"sha1","status":"in_progress","conclusion":""}`)

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main", "func-deploy.yaml")
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

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main", "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).To(BeNil())
		})

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

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main", "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).NotTo(BeNil())
			Expect(run.Conclusion).To(Equal("failure"))
			Expect(run.FailureReason).To(Equal("build / go test"))
		})

		It("falls back to the job name when no step failed", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{
				"owner":"testuser","repo":"test-func","branch":"main","headSha":"badsha",
				"status":"completed","conclusion":"failure",
				"jobs":[{
					"id":1,"name":"build","status":"completed","conclusion":"failure",
					"steps":[
						{"name":"checkout","status":"completed","conclusion":"success","number":1}
					]
				}]
			}`)

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main", "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).NotTo(BeNil())
			Expect(run.Conclusion).To(Equal("failure"))
			Expect(run.FailureReason).To(Equal("build"))
		})

		It("skips successful jobs and uses a later failing job", func() {
			ts, cl := startServer()
			seedRepo(ts)
			setWorkflowRun(ts, `{
				"owner":"testuser","repo":"test-func","branch":"main","headSha":"badsha",
				"status":"completed","conclusion":"failure",
				"jobs":[
					{
						"id":1,"name":"lint","status":"completed","conclusion":"success",
						"steps":[
							{"name":"eslint","status":"completed","conclusion":"success","number":1}
						]
					},
					{
						"id":2,"name":"test","status":"completed","conclusion":"failure",
						"steps":[
							{"name":"setup","status":"completed","conclusion":"success","number":1},
							{"name":"unit tests","status":"completed","conclusion":"failure","number":2}
						]
					}
				]
			}`)

			run, err := cl.LatestWorkflowRun(context.Background(), "testuser", "test-func", "main", "func-deploy.yaml")
			Expect(err).NotTo(HaveOccurred())
			Expect(run).NotTo(BeNil())
			Expect(run.Conclusion).To(Equal("failure"))
			Expect(run.FailureReason).To(Equal("test / unit tests"))
		})
	})
})

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
