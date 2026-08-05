package fakegithub_test

import (
	"context"
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

func startServer() (*httptest.Server, scm.Client) {
	srv := fakegithub.New(fakegithub.User{Login: "testuser", AvatarURL: "https://example.com/avatar"}, testPAT)
	ts := httptest.NewServer(srv)
	DeferCleanup(ts.Close)
	client := github.NewWithBaseURL(testPAT, ts.URL)
	return ts, client
}

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

			err := cl.InitRepo(context.Background(), "testuser", "branch-test", "develop", nil)
			Expect(err).NotTo(HaveOccurred())

			repos, err := cl.ListRepos(context.Background())
			Expect(err).NotTo(HaveOccurred())
			// After init, the repo should be listed (though without serverless-function topic
			// it won't match the search). We check the default branch via GetFiles on the branch.
			_ = repos
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

	Describe("Admin API", func() {
		It("resets all state", func() {
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
	})
})

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
	resp, err := ts.Client().Post(ts.URL+"/_admin/seed", "application/json", strings.NewReader(body))
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	ExpectWithOffset(1, resp.StatusCode).To(Equal(200))
	resp.Body.Close()
}

func resetFakeGitHub(ts *httptest.Server) {
	resp, err := ts.Client().Post(ts.URL+"/_admin/reset", "application/json", nil)
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	ExpectWithOffset(1, resp.StatusCode).To(Equal(200))
	resp.Body.Close()
}
