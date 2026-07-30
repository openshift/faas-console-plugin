package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	ghlib "github.com/google/go-github/v72/github"
	"golang.org/x/sync/errgroup"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

func New(pat string) scm.Client {
	return NewWithBaseURL(pat, "")
}

func NewWithBaseURL(pat, baseURL string) scm.Client {
	httpClient := &http.Client{Timeout: 30 * time.Second}
	client := ghlib.NewClient(httpClient).WithAuthToken(pat)
	if baseURL != "" {
		u, err := url.Parse(baseURL)
		if err != nil {
			panic(fmt.Sprintf("github.NewWithBaseURL: invalid baseURL %q: %v", baseURL, err))
		}
		if !strings.HasSuffix(u.Path, "/") {
			u.Path += "/"
		}
		client.BaseURL = u
	}
	return &ghClient{client: client}
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

func (c *ghClient) GetUser(ctx context.Context) (*scm.User, error) {
	user, _, err := c.client.Users.Get(ctx, "")
	if err != nil {
		return nil, mapErr(err)
	}
	return &scm.User{Login: user.GetLogin(), AvatarURL: user.GetAvatarURL()}, nil
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
	ref, _, err := c.client.Git.GetRef(ctx, owner, repo, "heads/"+branch)
	if err != nil {
		return fmt.Errorf("get ref: %w", mapErr(err))
	}
	headSHA := ref.GetObject().GetSHA()

	commit, _, err := c.client.Git.GetCommit(ctx, owner, repo, headSHA)
	if err != nil {
		return fmt.Errorf("get commit: %w", mapErr(err))
	}
	parentTreeSHA := commit.GetTree().GetSHA()

	treeEntries, err := c.createBlobs(ctx, owner, repo, files)
	if err != nil {
		return err
	}

	newTree, _, err := c.client.Git.CreateTree(ctx, owner, repo, parentTreeSHA, treeEntries)
	if err != nil {
		return fmt.Errorf("create tree: %w", mapErr(err))
	}

	newCommit, _, err := c.client.Git.CreateCommit(ctx, owner, repo, &ghlib.Commit{
		Message: new(message),
		Tree:    &ghlib.Tree{SHA: newTree.SHA},
		Parents: []*ghlib.Commit{{SHA: new(headSHA)}},
	}, nil)
	if err != nil {
		return fmt.Errorf("create commit: %w", mapErr(err))
	}

	_, _, err = c.client.Git.UpdateRef(ctx, owner, repo, &ghlib.Reference{
		Ref:    new("refs/heads/" + branch),
		Object: &ghlib.GitObject{SHA: newCommit.SHA},
	}, false)
	if err != nil {
		return fmt.Errorf("update ref: %w", mapErr(err))
	}
	return nil
}

func (c *ghClient) createBlobs(ctx context.Context, owner, repo string, files []scm.FileEntry) ([]*ghlib.TreeEntry, error) {
	entries := make([]*ghlib.TreeEntry, len(files))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(10)
	for i, f := range files {
		g.Go(func() error {
			blob, _, err := c.client.Git.CreateBlob(ctx, owner, repo, &ghlib.Blob{
				Content:  new(f.Content),
				Encoding: new("utf-8"),
			})
			if err != nil {
				return mapErr(err)
			}
			if blob.GetSHA() == "" {
				return fmt.Errorf("GitHub returned empty blob SHA")
			}
			mode := f.Mode
			entries[i] = &ghlib.TreeEntry{
				Path: new(f.Path),
				Mode: &mode,
				Type: new("blob"),
				SHA:  blob.SHA,
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
	_, err = c.client.Actions.CreateOrUpdateRepoSecret(ctx, owner, repo, &ghlib.EncryptedSecret{
		Name:           name,
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
