package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	ghlib "github.com/google/go-github/v90/github"
	"github.com/gregjones/httpcache"
	"golang.org/x/sync/errgroup"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

func New(pat string) scm.Client {
	return NewWithBaseURL(pat, "")
}

func NewWithBaseURL(pat, baseURL string) scm.Client {
	// A per-client in-memory HTTP cache issues conditional requests
	// (If-None-Match) using the ETags GitHub returns. When build status is
	// unchanged the server replies 304 Not Modified, which does NOT count
	// against the primary rate limit, so the 3s poll loop stays nearly free.
	// The cache is scoped per client (one per PAT), so one user's cached
	// responses are never served to another.
	//
	// forceRevalidate wraps the cache so every request revalidates instead of
	// being served from GitHub's max-age freshness window. Without it a newly
	// triggered build would stay hidden for up to ~60s; with it an unchanged
	// status is still just a (free) 304, but a real change is seen immediately.
	cacheTransport := httpcache.NewMemoryCacheTransport()
	httpClient := &http.Client{Transport: &forceRevalidate{next: cacheTransport}, Timeout: 30 * time.Second}
	opts := []ghlib.ClientOptionsFunc{
		ghlib.WithHTTPClient(httpClient),
		ghlib.WithAuthToken(pat),
	}
	if baseURL != "" {
		opts = append(opts, ghlib.WithURLs(&baseURL, nil))
	}
	client, err := ghlib.NewClient(opts...)
	if err != nil {
		panic(fmt.Sprintf("github.NewWithBaseURL: invalid baseURL %q: %v", baseURL, err))
	}
	return &ghClient{client: client}
}

// forceRevalidate sets Cache-Control: max-age=0 on every request so the
// underlying cache always revalidates with a conditional request rather than
// serving a still-"fresh" response from GitHub's max-age window.
type forceRevalidate struct {
	next http.RoundTripper
}

func (t *forceRevalidate) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Cache-Control", "max-age=0")
	resp, err := t.next.RoundTrip(req)
	if err != nil {
		return nil, fmt.Errorf("forced-revalidation round trip: %w", err)
	}
	return resp, nil
}

type ghClient struct {
	client *ghlib.Client
}

func mapErr(err error) error {
	var ghErr *ghlib.ErrorResponse
	if errors.As(err, &ghErr) && ghErr.Response != nil {
		switch ghErr.Response.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return fmt.Errorf("%w: %w", scm.ErrUnauthorized, err)
		}
	}
	return err
}

func isNotFound(err error) bool {
	var ghErr *ghlib.ErrorResponse
	return errors.As(err, &ghErr) && ghErr.Response != nil && ghErr.Response.StatusCode == http.StatusNotFound
}

func isRepoExists(err error) bool {
	var ghErr *ghlib.ErrorResponse
	if !errors.As(err, &ghErr) || ghErr.Response == nil || ghErr.Response.StatusCode != http.StatusUnprocessableEntity {
		return false
	}
	for _, e := range ghErr.Errors {
		if e.Field == "name" {
			return true
		}
	}
	return false
}

// branchRef returns the fully qualified Git reference for a branch, e.g.
// "refs/heads/main". No equivalent helper is provided by go-github; its ref
// methods accept a plain ref string that must be constructed by the caller.
func branchRef(branch string) string {
	return "refs/heads/" + branch
}

func (c *ghClient) GetUser(ctx context.Context) (*scm.User, error) {
	user, _, err := c.client.Users.Get(ctx, "")
	if err != nil {
		return nil, fmt.Errorf("get user: %w", mapErr(err))
	}
	return &scm.User{Login: user.GetLogin(), AvatarURL: user.GetAvatarURL()}, nil
}

func (c *ghClient) ListRepos(ctx context.Context) ([]scm.Repo, error) {
	user, _, err := c.client.Users.Get(ctx, "")
	if err != nil {
		return nil, fmt.Errorf("get authenticated user: %w", mapErr(err))
	}
	login := user.GetLogin()

	var repos []scm.Repo
	opts := &ghlib.SearchOptions{ListOptions: ghlib.ListOptions{PerPage: 100}}
	for {
		result, resp, err := c.client.Search.Repositories(ctx, fmt.Sprintf("topic:serverless-function user:%s", login), opts)
		if err != nil {
			return nil, fmt.Errorf("search repos for user %s: %w", login, mapErr(err))
		}
		for _, r := range result.Repositories {
			repos = append(repos, scm.Repo{
				Owner:         r.GetOwner().GetLogin(),
				Name:          r.GetName(),
				URL:           r.GetHTMLURL(),
				DefaultBranch: r.GetDefaultBranch(),
			})
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}
	return repos, nil
}

func (c *ghClient) GetFileContent(ctx context.Context, owner, repo, ref, path string) (string, error) {
	opts := &ghlib.RepositoryContentGetOptions{Ref: ref}
	file, _, _, err := c.client.Repositories.GetContents(ctx, owner, repo, path, opts)
	if err != nil {
		return "", fmt.Errorf("get file %s/%s/%s: %w", owner, repo, path, mapErr(err))
	}
	if file == nil {
		return "", fmt.Errorf("path %q is a directory, not a file", path)
	}
	content, err := file.GetContent()
	if err != nil {
		return "", fmt.Errorf("decode content for %q: %w", path, err)
	}
	return content, nil
}

func (c *ghClient) GetFiles(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
	tree, _, err := c.client.Git.GetTree(ctx, owner, repo, ref, true)
	if err != nil {
		return nil, mapErr(err)
	}
	if tree.GetTruncated() {
		return nil, fmt.Errorf("repository tree is too large and was truncated by GitHub; cannot operate on a partial file list")
	}

	var blobs []*ghlib.TreeEntry
	for i := range tree.Entries {
		if tree.Entries[i].GetType() == "blob" {
			blobs = append(blobs, tree.Entries[i])
		}
	}

	entries := make([]scm.FileEntry, len(blobs))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, blob := range blobs {
		g.Go(func() error {
			b, _, err := c.client.Git.GetBlob(ctx, owner, repo, blob.GetSHA())
			if err != nil {
				return mapErr(err)
			}
			var content string
			if b.GetEncoding() == "base64" {
				content, err = base64ToUTF8(b.GetContent())
				if err != nil {
					return fmt.Errorf("decode blob %s: %w", blob.GetPath(), err)
				}
			} else {
				content = b.GetContent()
			}
			entries[i] = scm.FileEntry{Path: blob.GetPath(), Mode: blob.GetMode(), Content: content, Type: "blob"}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, fmt.Errorf("fetch blobs: %w", err)
	}
	return entries, nil
}

func (c *ghClient) PushFiles(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
	ref, _, err := c.client.Git.GetRef(ctx, owner, repo, branchRef(branch))
	if err != nil {
		return fmt.Errorf("get ref: %w", mapErr(err))
	}
	headSHA := ref.GetObject().GetSHA()

	commit, _, err := c.client.Git.GetCommit(ctx, owner, repo, headSHA)
	if err != nil {
		return fmt.Errorf("get commit: %w", mapErr(err))
	}
	parentTreeSHA := commit.GetTree().GetSHA()

	treeEntries, err := c.buildTreeEntries(ctx, owner, repo, files)
	if err != nil {
		return err
	}

	newTree, _, err := c.client.Git.CreateTree(ctx, owner, repo, parentTreeSHA, treeEntries)
	if err != nil {
		return fmt.Errorf("create tree: %w", mapErr(err))
	}

	newCommit, _, err := c.client.Git.CreateCommit(ctx, owner, repo, ghlib.Commit{
		Message: new(message),
		Tree:    &ghlib.Tree{SHA: newTree.SHA},
		Parents: []*ghlib.Commit{{SHA: new(headSHA)}},
	}, nil)
	if err != nil {
		return fmt.Errorf("create commit: %w", mapErr(err))
	}

	_, _, err = c.client.Git.UpdateRef(ctx, owner, repo, branchRef(branch), ghlib.UpdateRef{
		SHA: newCommit.GetSHA(),
	})
	if err != nil {
		return fmt.Errorf("update ref: %w", mapErr(err))
	}
	return nil
}

func (c *ghClient) buildTreeEntries(ctx context.Context, owner, repo string, files []scm.FileEntry) ([]*ghlib.TreeEntry, error) {
	entries := make([]*ghlib.TreeEntry, len(files))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, f := range files {
		g.Go(func() error {
			var sha *string
			if !f.Deleted {
				blob, _, err := c.client.Git.CreateBlob(ctx, owner, repo, ghlib.Blob{
					Content:  new(f.Content),
					Encoding: new("utf-8"),
				})
				if err != nil {
					return mapErr(err)
				}
				if blob.GetSHA() == "" {
					return fmt.Errorf("GitHub returned empty blob SHA")
				}
				sha = blob.SHA
			}
			mode := f.Mode
			entries[i] = &ghlib.TreeEntry{
				Path: new(f.Path),
				Mode: &mode,
				Type: new("blob"),
				SHA:  sha,
			}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, fmt.Errorf("create blobs: %w", err)
	}
	return entries, nil
}

func (c *ghClient) InitRepo(ctx context.Context, owner, name, branch string, topics []string) error {
	autoInit := true
	_, _, err := c.client.Repositories.Create(ctx, "", &ghlib.Repository{
		Name:     new(name),
		AutoInit: &autoInit,
	})
	if err != nil {
		if isRepoExists(err) {
			return fmt.Errorf("%w: %s/%s", scm.ErrRepoExists, owner, name)
		}
		return fmt.Errorf("create repo: %w", mapErr(err))
	}

	repoInfo, _, err := c.client.Repositories.Get(ctx, owner, name)
	if err != nil {
		return fmt.Errorf("get repo default branch: %w", mapErr(err))
	}
	if repoInfo.GetDefaultBranch() != branch {
		if _, _, err := c.client.Repositories.RenameBranch(ctx, owner, name, repoInfo.GetDefaultBranch(), branch); err != nil {
			return fmt.Errorf("rename branch: %w", mapErr(err))
		}
	}

	if _, _, err := c.client.Repositories.ReplaceAllTopics(ctx, owner, name, topics); err != nil {
		return fmt.Errorf("set topics: %w", mapErr(err))
	}
	return nil
}

func (c *ghClient) StoreSecret(ctx context.Context, owner, repo, name, value string) error {
	pubKey, _, err := c.client.Actions.GetRepoPublicKey(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("get repo public key: %w", mapErr(err))
	}
	encrypted, err := encryptSecret(pubKey.GetKey(), value)
	if err != nil {
		return fmt.Errorf("encrypt secret: %w", err)
	}
	_, err = c.client.Actions.CreateOrUpdateRepoSecret(ctx, owner, repo, name, ghlib.SecretRequest{
		KeyID:          pubKey.GetKeyID(),
		EncryptedValue: encrypted,
	})
	if err != nil {
		return fmt.Errorf("store secret: %w", mapErr(err))
	}
	return nil
}

func (c *ghClient) DeleteRepo(ctx context.Context, owner, repo string) error {
	_, err := c.client.Repositories.Delete(ctx, owner, repo)
	if err != nil {
		return fmt.Errorf("delete repo: %w", mapErr(err))
	}
	return nil
}

func (c *ghClient) LatestWorkflowRun(ctx context.Context, owner, repo, branch, workflowFile string) (*scm.WorkflowRun, error) {
	opts := &ghlib.ListWorkflowRunsOptions{
		Branch:      branch,
		ListOptions: ghlib.ListOptions{PerPage: 1},
	}
	runs, _, err := c.client.Actions.ListWorkflowRunsByFileName(ctx, owner, repo, workflowFile, opts)
	if err != nil {
		if isNotFound(err) {
			// The workflow file does not exist in this repo (e.g. a non-func repo,
			// or the func workflow has not been pushed yet). Treat it like a repo
			// with no runs rather than surfacing an error.
			return nil, nil
		}
		return nil, fmt.Errorf("list workflow runs for %s/%s (%s): %w", owner, repo, workflowFile, mapErr(err))
	}
	if len(runs.WorkflowRuns) == 0 {
		return nil, nil
	}

	// GitHub returns runs in created_at descending order by default, so with
	// PerPage 1 the single element WorkflowRuns[0] is the newest run.
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
