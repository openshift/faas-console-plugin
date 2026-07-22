package github

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

func isUnauthorized(err error) bool { return errors.Is(err, scm.ErrUnauthorized) }

func newClient(handler http.HandlerFunc) scm.Client {
	srv := httptest.NewServer(handler)
	DeferCleanup(srv.Close)
	return NewWithBaseURL("test-pat", srv.URL)
}

func assertAuth(r *http.Request) {
	Expect(r.Header.Get("Authorization")).To(Equal("Bearer test-pat"))
}

var _ = Describe("GitHub SCM client", func() {

	Describe("GetUser", func() {
		It("returns the authenticated user's identity", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(r)
				json.NewEncoder(w).Encode(map[string]string{"login": "alice", "avatar_url": "https://example.com/avatar"})
			})

			user, err := cl.GetUser(context.Background())

			Expect(err).NotTo(HaveOccurred())
			Expect(user.Login).To(Equal("alice"))
			Expect(user.AvatarURL).To(Equal("https://example.com/avatar"))
		})

		It("returns an unauthorized error when the token is invalid", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
				json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
			})

			_, err := cl.GetUser(context.Background())

			Expect(isUnauthorized(err)).To(BeTrue())
		})

		It("returns an unauthorized error when the token is forbidden (403)", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"message": "Forbidden"})
			})

			_, err := cl.GetUser(context.Background())

			Expect(isUnauthorized(err)).To(BeTrue())
		})

		It("returns an error when the GitHub API is unavailable", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"message": "Internal Server Error"})
			})

			_, err := cl.GetUser(context.Background())

			Expect(err).To(HaveOccurred())
			Expect(isUnauthorized(err)).To(BeFalse())
		})
	})

	Describe("GetFiles", func() {
		It("returns all blob files from the repository, excluding directory entries", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(r)
				if strings.Contains(r.URL.Path, "/git/trees/") {
					Expect(r.URL.RawQuery).To(ContainSubstring("recursive=1"))
					json.NewEncoder(w).Encode(map[string]any{
						"tree": []map[string]any{
							{"path": "func.go", "mode": "100644", "type": "blob", "sha": "sha1"},
							{"path": "src", "mode": "040000", "type": "tree", "sha": "sha2"},
						},
					})
				} else {
					json.NewEncoder(w).Encode(map[string]string{
						"content":  "aGVsbG8=",
						"encoding": "base64",
					})
				}
			})

			files, err := cl.GetFiles(context.Background(), "alice", "my-func", "HEAD")

			Expect(err).NotTo(HaveOccurred())
			Expect(files).To(HaveLen(1))
			Expect(files[0].Path).To(Equal("func.go"))
			Expect(files[0].Content).To(Equal("hello"))
		})

		It("returns an unauthorized error when the token is invalid", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusUnauthorized)
				json.NewEncoder(w).Encode(map[string]string{"message": "Bad credentials"})
			})

			_, err := cl.GetFiles(context.Background(), "alice", "my-func", "HEAD")

			Expect(isUnauthorized(err)).To(BeTrue())
		})

		It("returns an error when the repository tree is truncated", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/git/trees/") {
					json.NewEncoder(w).Encode(map[string]any{
						"tree":      []map[string]any{{"path": "func.go", "mode": "100644", "type": "blob", "sha": "sha1"}},
						"truncated": true,
					})
				}
			})

			_, err := cl.GetFiles(context.Background(), "alice", "my-func", "HEAD")

			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("truncated"))
		})

		It("propagates errors from individual blob fetches", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/git/trees/") {
					json.NewEncoder(w).Encode(map[string]any{
						"tree": []map[string]any{
							{"path": "func.go", "mode": "100644", "type": "blob", "sha": "sha1"},
						},
					})
				} else {
					w.WriteHeader(http.StatusInternalServerError)
					json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
				}
			})

			_, err := cl.GetFiles(context.Background(), "alice", "my-func", "HEAD")

			Expect(err).To(HaveOccurred())
		})
	})

	Describe("PushFiles", func() {
		It("commits all files to the branch", func() {
			calls := map[string]int{}
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/git/ref/"):
					calls["getRef"]++
					json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "headsha"}})
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/git/commits/"):
					calls["getCommit"]++
					json.NewEncoder(w).Encode(map[string]any{"sha": "headsha", "tree": map[string]string{"sha": "treesha"}})
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/blobs"):
					calls["createBlob"]++
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(map[string]string{"sha": "blobsha"})
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/trees"):
					calls["createTree"]++
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(map[string]string{"sha": "newtreesha"})
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/commits"):
					calls["createCommit"]++
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(map[string]string{"sha": "newcommitsha"})
				case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/git/refs/"):
					calls["updateRef"]++
					json.NewEncoder(w).Encode(map[string]string{})
				}
			})

			files := []scm.FileEntry{{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"}}
			err := cl.PushFiles(context.Background(), "alice", "my-func", "main", "Update files", files)

			Expect(err).NotTo(HaveOccurred())
			for _, op := range []string{"getRef", "getCommit", "createBlob", "createTree", "createCommit", "updateRef"} {
				Expect(calls[op]).To(Equal(1), "expected %q to be called once", op)
			}
		})

		It("propagates errors from upstream Git API calls", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
			})

			err := cl.PushFiles(context.Background(), "alice", "my-func", "main", "msg", []scm.FileEntry{{Path: "f", Mode: "100644", Content: "x", Type: "blob"}})

			Expect(err).To(HaveOccurred())
		})
	})

	Describe("InitRepo", func() {
		repoHandler := func() http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/user/repos":
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/topics"):
					json.NewEncoder(w).Encode(map[string][]string{"names": {"serverless-function"}})
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/repos/"):
					json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
				}
			}
		}

		It("creates the repo, sets the branch and topics", func() {
			cl := newClient(repoHandler())

			Expect(cl.InitRepo(context.Background(), "alice", "my-func", "main", []string{"serverless-function"})).To(Succeed())
		})

		It("renames the default branch when it differs from the requested branch", func() {
			renameCalled := false
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/branches/master/rename"):
					renameCalled = true
					var body map[string]string
					json.NewDecoder(r.Body).Decode(&body)
					Expect(body["new_name"]).To(Equal("develop"))
					json.NewEncoder(w).Encode(map[string]string{})
				case r.Method == http.MethodPost && r.URL.Path == "/user/repos":
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/repos/"):
					json.NewEncoder(w).Encode(map[string]string{"default_branch": "master"})
				case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/topics"):
					json.NewEncoder(w).Encode(map[string][]string{"names": {}})
				}
			})

			Expect(cl.InitRepo(context.Background(), "alice", "my-func", "develop", nil)).To(Succeed())
			Expect(renameCalled).To(BeTrue())
		})

		It("returns an error when repo creation fails with a non-name-taken error", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost && r.URL.Path == "/user/repos" {
					w.WriteHeader(http.StatusInternalServerError)
					json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
				}
			})

			err := cl.InitRepo(context.Background(), "alice", "my-func", "main", nil)

			Expect(err).To(HaveOccurred())
			Expect(errors.Is(err, scm.ErrRepoExists)).To(BeFalse())
		})

		It("returns an error when fetching repo info fails after creation", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/user/repos":
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/repos/"):
					w.WriteHeader(http.StatusInternalServerError)
					json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
				}
			})

			err := cl.InitRepo(context.Background(), "alice", "my-func", "main", nil)

			Expect(err).To(HaveOccurred())
		})

		It("returns an error when renaming the default branch fails", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/user/repos":
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/repos/"):
					json.NewEncoder(w).Encode(map[string]string{"default_branch": "master"})
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/branches/master/rename"):
					w.WriteHeader(http.StatusInternalServerError)
					json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
				}
			})

			err := cl.InitRepo(context.Background(), "alice", "my-func", "develop", nil)

			Expect(err).To(HaveOccurred())
		})

		It("returns an error when setting topics fails", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/user/repos":
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/repos/"):
					json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
				case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/topics"):
					w.WriteHeader(http.StatusInternalServerError)
					json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
				}
			})

			err := cl.InitRepo(context.Background(), "alice", "my-func", "main", []string{"serverless-function"})

			Expect(err).To(HaveOccurred())
			Expect(errors.Is(err, scm.ErrRepoExists)).To(BeFalse())
		})

		It("returns ErrRepoExists when GitHub reports the name is already taken", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost && r.URL.Path == "/user/repos" {
					w.WriteHeader(http.StatusUnprocessableEntity)
					json.NewEncoder(w).Encode(map[string]any{
						"message": "Repository creation failed.",
						"errors": []map[string]string{
							{"resource": "Repository", "code": "custom", "field": "name", "message": "name already exists on this account"},
						},
					})
				}
			})

			err := cl.InitRepo(context.Background(), "alice", "my-func", "main", nil)

			Expect(err).To(HaveOccurred())
			Expect(errors.Is(err, scm.ErrRepoExists)).To(BeTrue())
		})
	})

	Describe("StoreSecret", func() {
		It("returns an error when storing the secret fails after the public key is fetched", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/actions/secrets/public-key"):
					json.NewEncoder(w).Encode(map[string]string{
						"key_id": "kid123",
						"key":    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
					})
				case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/actions/secrets/"):
					w.WriteHeader(http.StatusInternalServerError)
					json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
				}
			})

			err := cl.StoreSecret(context.Background(), "alice", "my-func", "KUBECONFIG", "value")

			Expect(err).To(HaveOccurred())
			Expect(isUnauthorized(err)).To(BeFalse())
		})

		It("returns an error when the public-key endpoint fails", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"message": "internal server error"})
			})

			err := cl.StoreSecret(context.Background(), "alice", "my-func", "KUBECONFIG", "value")

			Expect(err).To(HaveOccurred())
		})

		It("encrypts the value and stores it as a GitHub Actions secret", func() {
			secretStored := false
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/actions/secrets/public-key"):
					json.NewEncoder(w).Encode(map[string]string{
						"key_id": "kid123",
						"key":    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
					})
				case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/actions/secrets/KUBECONFIG"):
					secretStored = true
					var body map[string]string
					json.NewDecoder(r.Body).Decode(&body)
					Expect(body["key_id"]).To(Equal("kid123"))
					Expect(body["encrypted_value"]).NotTo(BeEmpty())
					w.WriteHeader(http.StatusCreated)
				}
			})

			Expect(cl.StoreSecret(context.Background(), "alice", "my-func", "KUBECONFIG", "kubeconfig-value")).To(Succeed())
			Expect(secretStored).To(BeTrue())
		})
	})
})
