package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

// New returns a scm.Client that authenticates with pat.
// baseURL defaults to "https://api.github.com"; override in tests.
func New(pat, baseURL string) scm.Client {
	if baseURL == "" {
		baseURL = "https://api.github.com"
	}
	return &httpClient{
		pat:     pat,
		baseURL: baseURL,
		client:  &http.Client{Timeout: 30 * time.Second},
	}
}

type httpClient struct {
	pat     string
	baseURL string
	client  *http.Client
}

type apiError struct {
	StatusCode int
	Message    string           `json:"message"`
	Errors     []apiErrorDetail `json:"errors"`
}

type apiErrorDetail struct {
	Message string `json:"message"`
}

func (e *apiError) Error() string {
	return fmt.Sprintf("github API error %d: %s", e.StatusCode, e.Message)
}

// ErrRepoExists is returned by InitRepo when the repository already exists.
var ErrRepoExists = errors.New("repository already exists")

func IsUnauthorized(err error) bool {
	var e *apiError
	return errors.As(err, &e) && e.StatusCode == http.StatusUnauthorized
}

func isRepoExists(err error) bool {
	var e *apiError
	if !errors.As(err, &e) || e.StatusCode != http.StatusUnprocessableEntity {
		return false
	}
	for _, detail := range e.Errors {
		if strings.Contains(detail.Message, "already exists") {
			return true
		}
	}
	return strings.Contains(e.Message, "already exists")
}

// do executes an authenticated GitHub API request. ctx is forwarded to the
// underlying HTTP call so cancellation propagates into in-flight requests.
func (c *httpClient) do(ctx context.Context, method, path string, body, result any) error {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.pat)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var apiErr apiError
		apiErr.StatusCode = resp.StatusCode
		_ = json.NewDecoder(resp.Body).Decode(&apiErr)
		return &apiErr
	}

	if result != nil && resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

func (c *httpClient) GetUser(ctx context.Context) (*scm.User, error) {
	var raw struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := c.do(ctx, "GET", "/user", nil, &raw); err != nil {
		return nil, err
	}
	return &scm.User{Login: raw.Login, AvatarURL: raw.AvatarURL}, nil
}

func (c *httpClient) GetFiles(ctx context.Context, owner, repo, ref string) ([]scm.FileEntry, error) {
	blobs, err := c.getTree(ctx, owner, repo, ref)
	if err != nil {
		return nil, err
	}

	entries := make([]scm.FileEntry, len(blobs))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, blob := range blobs {
		i, blob := i, blob
		g.Go(func() error {
			content, err := c.getBlob(ctx, owner, repo, blob.sha)
			if err != nil {
				return err
			}
			entries[i] = scm.FileEntry{Path: blob.path, Mode: blob.mode, Content: content, Type: "blob"}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, fmt.Errorf("fetch blobs: %w", err)
	}
	return entries, nil
}

func (c *httpClient) PushFiles(ctx context.Context, owner, repo, branch, message string, files []scm.FileEntry) error {
	headSHA, err := c.getRef(ctx, owner, repo, "heads/"+branch)
	if err != nil {
		return fmt.Errorf("get ref: %w", err)
	}
	parentTreeSHA, err := c.getCommit(ctx, owner, repo, headSHA)
	if err != nil {
		return fmt.Errorf("get commit: %w", err)
	}
	treeEntries, err := c.createBlobs(ctx, owner, repo, files)
	if err != nil {
		return fmt.Errorf("create blobs: %w", err)
	}
	treeSHA, err := c.createTree(ctx, owner, repo, treeEntries, parentTreeSHA)
	if err != nil {
		return fmt.Errorf("create tree: %w", err)
	}
	commitSHA, err := c.createCommit(ctx, owner, repo, message, treeSHA, headSHA)
	if err != nil {
		return fmt.Errorf("create commit: %w", err)
	}
	return c.updateRef(ctx, owner, repo, "heads/"+branch, commitSHA)
}

func (c *httpClient) InitRepo(ctx context.Context, owner, name, branch string, topics []string) error {
	if err := c.do(ctx, "POST", "/user/repos", map[string]any{"name": name, "auto_init": true}, nil); err != nil {
		if isRepoExists(err) {
			return fmt.Errorf("%w: %s/%s", ErrRepoExists, owner, name)
		}
		return fmt.Errorf("create repo: %w", err)
	}

	// Read the actual default branch GitHub created - it depends on the account's
	// configured default and may not be "main".
	var repoInfo struct {
		DefaultBranch string `json:"default_branch"`
	}
	base := repoPath(owner, name)
	if err := c.do(ctx, "GET", base, nil, &repoInfo); err != nil {
		return fmt.Errorf("get repo default branch: %w", err)
	}
	if repoInfo.DefaultBranch != branch {
		body := map[string]string{"new_name": branch}
		if err := c.do(ctx, "POST", base+"/branches/"+repoInfo.DefaultBranch+"/rename", body, nil); err != nil {
			return fmt.Errorf("rename branch: %w", err)
		}
	}

	if err := c.do(ctx, "PUT", base+"/topics", map[string][]string{"names": topics}, nil); err != nil {
		return fmt.Errorf("set topics: %w", err)
	}

	return nil
}

func (c *httpClient) StoreSecret(ctx context.Context, owner, repo, name, value string) error {
	var pubKey struct {
		KeyID string `json:"key_id"`
		Key   string `json:"key"`
	}
	base := repoPath(owner, repo)
	if err := c.do(ctx, "GET", base+"/actions/secrets/public-key", nil, &pubKey); err != nil {
		return fmt.Errorf("get repo public key: %w", err)
	}
	encrypted, err := encryptSecret(pubKey.Key, value)
	if err != nil {
		return fmt.Errorf("encrypt secret: %w", err)
	}
	secretBody := map[string]string{"encrypted_value": encrypted, "key_id": pubKey.KeyID}
	if err := c.do(ctx, "PUT", base+"/actions/secrets/"+name, secretBody, nil); err != nil {
		return fmt.Errorf("store secret: %w", err)
	}
	return nil
}

type treeBlob struct{ path, mode, sha string }

type treeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
}

func repoPath(owner, repo string) string {
	return fmt.Sprintf("/repos/%s/%s", owner, repo)
}

func (c *httpClient) getRef(ctx context.Context, owner, repo, ref string) (string, error) {
	var result struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := c.do(ctx, "GET", repoPath(owner, repo)+"/git/ref/"+ref, nil, &result); err != nil {
		return "", err
	}
	return result.Object.SHA, nil
}

func (c *httpClient) getCommit(ctx context.Context, owner, repo, sha string) (string, error) {
	var result struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := c.do(ctx, "GET", repoPath(owner, repo)+"/git/commits/"+sha, nil, &result); err != nil {
		return "", err
	}
	return result.Tree.SHA, nil
}

func (c *httpClient) createBlob(ctx context.Context, owner, repo, content string) (string, error) {
	body := map[string]string{"content": content, "encoding": "utf-8"}
	var result struct {
		SHA string `json:"sha"`
	}
	if err := c.do(ctx, "POST", repoPath(owner, repo)+"/git/blobs", body, &result); err != nil {
		return "", err
	}
	if result.SHA == "" {
		return "", fmt.Errorf("GitHub returned empty blob SHA")
	}
	return result.SHA, nil
}

func (c *httpClient) createBlobs(ctx context.Context, owner, repo string, files []scm.FileEntry) ([]treeEntry, error) {
	entries := make([]treeEntry, len(files))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, f := range files {
		i, f := i, f
		g.Go(func() error {
			sha, err := c.createBlob(ctx, owner, repo, f.Content)
			if err != nil {
				return err
			}
			entries[i] = treeEntry{Path: f.Path, Mode: f.Mode, Type: "blob", SHA: sha}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, fmt.Errorf("create blobs: %w", err)
	}
	return entries, nil
}

func (c *httpClient) createTree(ctx context.Context, owner, repo string, entries []treeEntry, baseTree string) (string, error) {
	body := map[string]any{"tree": entries, "base_tree": baseTree}
	var result struct {
		SHA string `json:"sha"`
	}
	if err := c.do(ctx, "POST", repoPath(owner, repo)+"/git/trees", body, &result); err != nil {
		return "", err
	}
	return result.SHA, nil
}

func (c *httpClient) createCommit(ctx context.Context, owner, repo, message, tree, parent string) (string, error) {
	body := map[string]any{"message": message, "tree": tree, "parents": []string{parent}}
	var result struct {
		SHA string `json:"sha"`
	}
	if err := c.do(ctx, "POST", repoPath(owner, repo)+"/git/commits", body, &result); err != nil {
		return "", err
	}
	return result.SHA, nil
}

func (c *httpClient) updateRef(ctx context.Context, owner, repo, ref, sha string) error {
	return c.do(ctx, "PATCH", repoPath(owner, repo)+"/git/refs/"+ref, map[string]any{"sha": sha, "force": false}, nil)
}

func (c *httpClient) getTree(ctx context.Context, owner, repo, refOrSHA string) ([]treeBlob, error) {
	var result struct {
		Tree []struct {
			Path string `json:"path"`
			Mode string `json:"mode"`
			Type string `json:"type"`
			SHA  string `json:"sha"`
		} `json:"tree"`
		Truncated bool `json:"truncated"`
	}
	if err := c.do(ctx, "GET", repoPath(owner, repo)+"/git/trees/"+refOrSHA+"?recursive=1", nil, &result); err != nil {
		return nil, err
	}
	if result.Truncated {
		return nil, fmt.Errorf("repository tree is too large and was truncated by GitHub; cannot operate on a partial file list")
	}
	var blobs []treeBlob
	for _, e := range result.Tree {
		if e.Type == "blob" {
			blobs = append(blobs, treeBlob{path: e.Path, mode: e.Mode, sha: e.SHA})
		}
	}
	return blobs, nil
}

func (c *httpClient) getBlob(ctx context.Context, owner, repo, sha string) (string, error) {
	var result struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := c.do(ctx, "GET", repoPath(owner, repo)+"/git/blobs/"+sha, nil, &result); err != nil {
		return "", err
	}
	if result.Encoding != "base64" {
		return result.Content, nil
	}
	return base64ToUTF8(result.Content)
}
