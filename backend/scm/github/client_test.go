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

var _ = Describe("GitHub SCM client", func() {

	Describe("GetUser", func() {
		It("returns the authenticated user's identity", func() {
			var authHeader string
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				authHeader = r.Header.Get("Authorization")
				json.NewEncoder(w).Encode(map[string]string{"login": "alice", "avatar_url": "https://example.com/avatar"})
			})

			user, err := cl.GetUser(context.Background())

			Expect(err).NotTo(HaveOccurred())
			Expect(authHeader).To(Equal("Bearer test-pat"))
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
			var authHeader, treeQuery string
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				authHeader = r.Header.Get("Authorization")
				if strings.Contains(r.URL.Path, "/git/trees/") {
					treeQuery = r.URL.RawQuery
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
			Expect(authHeader).To(Equal("Bearer test-pat"))
			Expect(treeQuery).To(ContainSubstring("recursive=1"))
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

		It("returns raw content when the blob encoding is not base64", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/git/trees/") {
					json.NewEncoder(w).Encode(map[string]any{
						"tree": []map[string]any{
							{"path": "func.go", "mode": "100644", "type": "blob", "sha": "sha1"},
						},
					})
				} else {
					json.NewEncoder(w).Encode(map[string]string{
						"content":  "package main",
						"encoding": "utf-8",
					})
				}
			})

			files, err := cl.GetFiles(context.Background(), "alice", "my-func", "HEAD")

			Expect(err).NotTo(HaveOccurred())
			Expect(files).To(HaveLen(1))
			Expect(files[0].Content).To(Equal("package main"))
		})

		It("strips line breaks from base64 content before decoding", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/git/trees/") {
					json.NewEncoder(w).Encode(map[string]any{
						"tree": []map[string]any{
							{"path": "func.go", "mode": "100644", "type": "blob", "sha": "sha1"},
						},
					})
				} else {
					json.NewEncoder(w).Encode(map[string]string{
						"content":  "aGVs\nbG8=\n",
						"encoding": "base64",
					})
				}
			})

			files, err := cl.GetFiles(context.Background(), "alice", "my-func", "HEAD")

			Expect(err).NotTo(HaveOccurred())
			Expect(files).To(HaveLen(1))
			Expect(files[0].Content).To(Equal("hello"))
		})

		It("returns an error when base64 content is corrupted", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/git/trees/") {
					json.NewEncoder(w).Encode(map[string]any{
						"tree": []map[string]any{
							{"path": "func.go", "mode": "100644", "type": "blob", "sha": "sha1"},
						},
					})
				} else {
					json.NewEncoder(w).Encode(map[string]string{
						"content":  "!!!not-valid-base64!!!",
						"encoding": "base64",
					})
				}
			})

			_, err := cl.GetFiles(context.Background(), "alice", "my-func", "HEAD")

			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("decode blob"))
		})
	})

	Describe("PushFiles", func() {
		type updateRefBody struct {
			SHA   string `json:"sha"`
			Force bool   `json:"force"`
		}

		pushStub := func(failAt string, lastRequest *updateRefBody, blobCount *int, treeEntries *[]map[string]any) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/git/ref/"):
					if failAt == "getRef" {
						w.WriteHeader(http.StatusInternalServerError)
						json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
						return
					}
					json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "headsha"}})
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/git/commits/"):
					if failAt == "getCommit" {
						w.WriteHeader(http.StatusInternalServerError)
						json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
						return
					}
					json.NewEncoder(w).Encode(map[string]any{"sha": "headsha", "tree": map[string]string{"sha": "treesha"}})
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/blobs"):
					if failAt == "createBlob" {
						w.WriteHeader(http.StatusInternalServerError)
						json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
						return
					}
					if blobCount != nil {
						*blobCount++
					}
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(map[string]string{"sha": "blobsha"})
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/trees"):
					if failAt == "createTree" {
						w.WriteHeader(http.StatusInternalServerError)
						json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
						return
					}
					if treeEntries != nil {
						var body struct {
							Tree []map[string]any `json:"tree"`
						}
						json.NewDecoder(r.Body).Decode(&body)
						*treeEntries = body.Tree
					}
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(map[string]string{"sha": "newtreesha"})
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/git/commits"):
					if failAt == "createCommit" {
						w.WriteHeader(http.StatusInternalServerError)
						json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
						return
					}
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(map[string]string{"sha": "newcommitsha"})
				case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/git/refs/"):
					if failAt == "updateRef" {
						w.WriteHeader(http.StatusInternalServerError)
						json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
						return
					}
					if lastRequest != nil {
						json.NewDecoder(r.Body).Decode(lastRequest)
					}
					json.NewEncoder(w).Encode(map[string]string{})
				}
			}
		}

		pushFiles := func(cl scm.Client) error {
			files := []scm.FileEntry{{Path: "func.go", Mode: "100644", Content: "package main", Type: "blob"}}
			return cl.PushFiles(context.Background(), "alice", "my-func", "main", "Update files", files)
		}

		It("commits all files and updates the ref to the new commit SHA", func() {
			var refUpdate updateRefBody
			cl := newClient(pushStub("", &refUpdate, nil, nil))

			Expect(pushFiles(cl)).To(Succeed())
			Expect(refUpdate.SHA).To(Equal("newcommitsha"))
		})

		It("returns an error when getting the branch ref fails", func() {
			err := pushFiles(newClient(pushStub("getRef", nil, nil, nil)))
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("get ref"))
		})

		It("returns an error when getting the head commit fails", func() {
			err := pushFiles(newClient(pushStub("getCommit", nil, nil, nil)))
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("get commit"))
		})

		It("returns an error when creating a blob fails", func() {
			err := pushFiles(newClient(pushStub("createBlob", nil, nil, nil)))
			Expect(err).To(HaveOccurred())
		})

		It("returns an error when creating the tree fails", func() {
			err := pushFiles(newClient(pushStub("createTree", nil, nil, nil)))
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("create tree"))
		})

		It("returns an error when creating the commit fails", func() {
			err := pushFiles(newClient(pushStub("createCommit", nil, nil, nil)))
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("create commit"))
		})

		It("returns an error when updating the ref fails", func() {
			err := pushFiles(newClient(pushStub("updateRef", nil, nil, nil)))
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("update ref"))
		})

		It("does not create a blob and sends a nil SHA for a deleted file", func() {
			var blobCount int
			var entries []map[string]any
			files := []scm.FileEntry{{Path: "remove.go", Mode: "100644", Content: "", Type: "blob", Deleted: true}}
			cl := newClient(pushStub("", nil, &blobCount, &entries))

			Expect(cl.PushFiles(context.Background(), "alice", "my-func", "main", "Delete file", files)).To(Succeed())
			Expect(blobCount).To(Equal(0), "blob should not be created for a deleted file")
			Expect(entries).To(HaveLen(1))
			Expect(entries[0]["path"]).To(Equal("remove.go"))
			Expect(entries[0]["sha"]).To(BeNil())
		})

		It("creates blobs only for non-deleted files in a mixed batch", func() {
			var blobCount int
			var entries []map[string]any
			files := []scm.FileEntry{
				{Path: "keep.go", Mode: "100644", Content: "package main", Type: "blob"},
				{Path: "remove.go", Mode: "100644", Content: "", Type: "blob", Deleted: true},
			}
			cl := newClient(pushStub("", nil, &blobCount, &entries))

			Expect(cl.PushFiles(context.Background(), "alice", "my-func", "main", "Partial delete", files)).To(Succeed())
			Expect(blobCount).To(Equal(1), "only non-deleted files should create blobs")
			Expect(entries).To(HaveLen(2))
			var keepSHA, removeSHA any
			for _, e := range entries {
				if e["path"] == "keep.go" {
					keepSHA = e["sha"]
				} else {
					removeSHA = e["sha"]
				}
			}
			Expect(keepSHA).NotTo(BeNil())
			Expect(removeSHA).To(BeNil())
		})
	})

	Describe("InitRepo", func() {
		repoStub := func(topicsBody *map[string][]string) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && r.URL.Path == "/user/repos":
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/topics"):
					if topicsBody != nil {
						*topicsBody = map[string][]string{}
						json.NewDecoder(r.Body).Decode(topicsBody)
					}
					json.NewEncoder(w).Encode(map[string][]string{"names": {"serverless-function"}})
				case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/repos/"):
					json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
				}
			}
		}

		It("creates the repo, sets the branch and topics", func() {
			var topicsBody map[string][]string
			cl := newClient(repoStub(&topicsBody))

			Expect(cl.InitRepo(context.Background(), "alice", "my-func", "main", []string{"serverless-function"})).To(Succeed())
			Expect(topicsBody).NotTo(BeNil())
			Expect(topicsBody["names"]).To(ConsistOf("serverless-function"))
		})

		It("renames the default branch when it differs from the requested branch", func() {
			var renameBody map[string]string
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/branches/master/rename"):
					renameBody = map[string]string{}
					json.NewDecoder(r.Body).Decode(&renameBody)
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
			Expect(renameBody).NotTo(BeNil())
			Expect(renameBody["new_name"]).To(Equal("develop"))
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

	Describe("DeleteRepo", func() {
		It("deletes the repository", func() {
			var deletedPath string
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/repos/") {
					deletedPath = r.URL.Path
					w.WriteHeader(http.StatusNoContent)
				}
			})

			Expect(cl.DeleteRepo(context.Background(), "alice", "my-func")).To(Succeed())
			Expect(deletedPath).To(ContainSubstring("/repos/alice/my-func"))
		})

		It("returns an unauthorized error when the token lacks delete permission", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"message": "Must have admin rights"})
			})

			err := cl.DeleteRepo(context.Background(), "alice", "my-func")

			Expect(err).To(HaveOccurred())
			Expect(isUnauthorized(err)).To(BeTrue())
		})

		It("returns an error when the GitHub API fails", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"message": "server error"})
			})

			err := cl.DeleteRepo(context.Background(), "alice", "my-func")

			Expect(err).To(HaveOccurred())
			Expect(isUnauthorized(err)).To(BeFalse())
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

		It("returns an error when the public key is invalid base64", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/actions/secrets/public-key") {
					json.NewEncoder(w).Encode(map[string]string{
						"key_id": "kid123",
						"key":    "not-valid-base64!!!",
					})
				}
			})

			err := cl.StoreSecret(context.Background(), "alice", "my-func", "KUBECONFIG", "value")

			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("encrypt secret"))
		})

		It("returns an error when the public key is not 32 bytes", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/actions/secrets/public-key") {
					json.NewEncoder(w).Encode(map[string]string{
						"key_id": "kid123",
						"key":    "dG9vc2hvcnQ=",
					})
				}
			})

			err := cl.StoreSecret(context.Background(), "alice", "my-func", "KUBECONFIG", "value")

			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("32 bytes"))
		})

		It("encrypts the value and stores it as a GitHub Actions secret", func() {
			var secretBody map[string]string
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/actions/secrets/public-key"):
					json.NewEncoder(w).Encode(map[string]string{
						"key_id": "kid123",
						"key":    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
					})
				case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/actions/secrets/KUBECONFIG"):
					secretBody = map[string]string{}
					json.NewDecoder(r.Body).Decode(&secretBody)
					w.WriteHeader(http.StatusCreated)
				}
			})

			Expect(cl.StoreSecret(context.Background(), "alice", "my-func", "KUBECONFIG", "kubeconfig-value")).To(Succeed())
			Expect(secretBody).NotTo(BeNil())
			Expect(secretBody["key_id"]).To(Equal("kid123"))
			Expect(secretBody["encrypted_value"]).NotTo(BeEmpty())
		})
	})

	Describe("LatestWorkflowRun conditional requests", func() {
		It("revalidates with If-None-Match and serves cached data on a 304", func() {
			const runsPath = "/repos/alice/my-func/actions/runs"
			var requestCount int
			var conditional []string
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasPrefix(r.URL.Path, runsPath) {
					return
				}
				requestCount++
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
				json.NewEncoder(w).Encode(map[string]any{
					"total_count": 1,
					"workflow_runs": []map[string]any{
						{
							"id":         42,
							"status":     "completed",
							"conclusion": "success",
							"head_sha":   "abc123",
							"html_url":   "https://example.com/runs/42",
						},
					},
				})
			})

			first, err := cl.LatestWorkflowRun(context.Background(), "alice", "my-func", "main")
			Expect(err).NotTo(HaveOccurred())
			Expect(first).NotTo(BeNil())
			Expect(first.ID).To(Equal(int64(42)))

			second, err := cl.LatestWorkflowRun(context.Background(), "alice", "my-func", "main")
			Expect(err).NotTo(HaveOccurred())
			Expect(second).NotTo(BeNil())

			// The first call was unconditional; the second sent If-None-Match and
			// got a 304, yet still returned the same run data (served from cache).
			Expect(requestCount).To(Equal(2))
			Expect(conditional[0]).To(BeEmpty())
			Expect(conditional[1]).To(Equal(`"run-etag-v1"`))
			Expect(*second).To(Equal(*first))
		})
	})
})
