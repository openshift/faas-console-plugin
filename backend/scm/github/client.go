package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	ghlib "github.com/google/go-github/v90/github"
	"golang.org/x/sync/errgroup"

	"github.com/openshift/faas-console-plugin/backend/scm"
	"github.com/openshift/faas-console-plugin/backend/scm/github/httpcache"
	"github.com/openshift/faas-console-plugin/backend/ticker"
)

type Option func(*ghClient)

func WithWatchPollInterval(d time.Duration) Option {
	if d <= 0 {
		panic(fmt.Sprintf("watch poll interval must be positive, got %s", d))
	}
	return func(c *ghClient) {
		c.pollInterval = d
	}
}

func WithWatchRediscoverInterval(d time.Duration) Option {
	if d <= 0 {
		panic(fmt.Sprintf("watch rediscover interval must be positive, got %s", d))
	}
	return func(c *ghClient) {
		c.rediscoverInterval = d
	}
}

func WithWatchTickerFactory(newTicker ticker.Factory) Option {
	if newTicker == nil {
		panic("newTicker must not be nil")
	}
	return func(c *ghClient) {
		c.newTicker = newTicker
	}
}

// New builds a client against github.com with default settings. It is not
// variadic so it stays assignable to scm.ClientFactory, which is how the
// registry wires it; use NewWithBaseURL to pass options.
func New(pat string) scm.Client {
	return NewWithBaseURL(pat, "")
}

func NewWithBaseURL(pat, baseURL string, opts ...Option) scm.Client {
	// Its own ETag cache, so responses are never served across PATs. Unchanged
	// workflow run status comes back as a 304, which does NOT count against the
	// primary rate limit, so the poll loop stays nearly free. See
	// httpcache.NewETagCache.
	httpClient := &http.Client{Transport: httpcache.NewETagCache(http.DefaultTransport), Timeout: 30 * time.Second}
	clientOpts := []ghlib.ClientOptionsFunc{
		ghlib.WithHTTPClient(httpClient),
		ghlib.WithAuthToken(pat),
	}
	if baseURL != "" {
		clientOpts = append(clientOpts, ghlib.WithURLs(&baseURL, nil))
	}
	client, err := ghlib.NewClient(clientOpts...)
	if err != nil {
		panic(fmt.Sprintf("github.NewWithBaseURL: invalid baseURL %q: %v", baseURL, err))
	}
	c := &ghClient{
		client:             client,
		newTicker:          ticker.New,
		pollInterval:       defaultWatchPollInterval,
		rediscoverInterval: defaultWatchRediscoverInterval,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

type ghClient struct {
	client *ghlib.Client
	// Ticker factories for the WatchWorkflowRuns loop. Set once at construction
	// and only read afterwards, including by the watch goroutine.
	newTicker          ticker.Factory
	pollInterval       time.Duration
	rediscoverInterval time.Duration
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
	user, resp, err := c.client.Users.Get(ctx, "")
	if err != nil {
		return nil, fmt.Errorf("get user: %w", mapErr(err))
	}
	return &scm.User{
		Login:          user.GetLogin(),
		AvatarURL:      user.GetAvatarURL(),
		TokenExpiresAt: resp.TokenExpiration.Time,
	}, nil
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

func (c *ghClient) GetVariable(ctx context.Context, owner, repo, name string) (string, error) {
	variable, _, err := c.client.Actions.GetRepoVariable(ctx, owner, repo, name)
	if err != nil {
		var ghErr *ghlib.ErrorResponse
		if errors.As(err, &ghErr) && ghErr.Response != nil && ghErr.Response.StatusCode == http.StatusNotFound {
			return "", nil
		}
		return "", fmt.Errorf("get variable %s: %w", name, mapErr(err))
	}
	return variable.GetValue(), nil
}

func (c *ghClient) StoreVariable(ctx context.Context, owner, repo, name, value string) error {
	_, err := c.client.Actions.CreateRepoVariable(ctx, owner, repo, ghlib.ActionsCreateVariableRequest{
		Name:  name,
		Value: value,
	})
	if err != nil {
		var ghErr *ghlib.ErrorResponse
		if errors.As(err, &ghErr) && ghErr.Response != nil && ghErr.Response.StatusCode == http.StatusConflict {
			newValue := value
			_, updateErr := c.client.Actions.UpdateRepoVariable(ctx, owner, repo, name, ghlib.ActionsUpdateVariableRequest{
				Value: &newValue,
			})
			if updateErr != nil {
				return fmt.Errorf("update variable %s: %w", name, mapErr(updateErr))
			}
			return nil
		}
		return fmt.Errorf("store variable %s: %w", name, mapErr(err))
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
