package scm

import (
	"context"
	"errors"
	"fmt"
)

var (
	ErrUnauthorized = errors.New("unauthorized")
	ErrRepoExists   = errors.New("repository already exists")
)

type Platform string

const (
	GitHub          Platform = "github"
	DefaultPlatform Platform = GitHub
)

type ClientFactory func(token string) Client

type Registry map[Platform]ClientFactory

func (r Registry) NewClient(platform Platform, token string) (Client, error) {
	factory, ok := r[platform]
	if !ok {
		return nil, fmt.Errorf("unsupported SCM: %q", platform)
	}
	return factory(token), nil
}

// Client returns an authenticated client for the given platform.
// Panics if the platform is not registered - use when the platform is statically known to be present.
func (r Registry) Client(platform Platform, token string) Client {
	client, err := r.NewClient(platform, token)
	if err != nil {
		panic(err)
	}
	return client
}

type Client interface {
	GetUser(ctx context.Context) (*User, error)
	ListRepos(ctx context.Context) ([]Repo, error)
	GetFileContent(ctx context.Context, owner, repo, ref, path string) (string, error)
	GetFiles(ctx context.Context, owner, repo, ref string) ([]FileEntry, error)
	PushFiles(ctx context.Context, owner, repo, branch, message string, files []FileEntry) error
	InitRepo(ctx context.Context, owner, name, branch string, topics []string) error
	StoreSecret(ctx context.Context, owner, repo, name, value string) error
	DeleteRepo(ctx context.Context, owner, repo string) error
	LatestWorkflowRun(ctx context.Context, owner, repo, branch, workflowFile string) (*WorkflowRun, error)
}

type Repo struct {
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	URL           string `json:"url"`
	DefaultBranch string `json:"defaultBranch"`
}

type User struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

type FileEntry struct {
	Path    string `json:"path"`
	Mode    string `json:"mode"` // Git modes: "100644" regular, "100755" executable, "120000" symlink
	Content string `json:"content"`
	Type    string `json:"type"`
	Deleted bool   `json:"deleted,omitempty"`
}

// WorkflowRun is the latest GitHub Actions run of a specific workflow file on a
// repo branch. A nil *WorkflowRun means the workflow has no runs on that branch
// (including when the workflow file does not exist in the repo).
type WorkflowRun struct {
	ID            int64
	Status        string // queued | in_progress | completed
	Conclusion    string // success | failure | cancelled | timed_out | ""
	HeadSHA       string
	HTMLURL       string
	FailureReason string // set for failures: "<job> / <step>" summary
}

type ClientStub struct {
	OnGetUser           func(ctx context.Context) (*User, error)
	OnListRepos         func(ctx context.Context) ([]Repo, error)
	OnGetFileContent    func(ctx context.Context, owner, repo, ref, path string) (string, error)
	OnGetFiles          func(ctx context.Context, owner, repo, ref string) ([]FileEntry, error)
	OnPushFiles         func(ctx context.Context, owner, repo, branch, message string, files []FileEntry) error
	OnInitRepo          func(ctx context.Context, owner, name, branch string, topics []string) error
	OnStoreSecret       func(ctx context.Context, owner, repo, name, value string) error
	OnDeleteRepo        func(ctx context.Context, owner, repo string) error
	OnLatestWorkflowRun func(ctx context.Context, owner, repo, branch, workflowFile string) (*WorkflowRun, error)
}

func (s *ClientStub) GetUser(ctx context.Context) (*User, error) {
	if s.OnGetUser != nil {
		return s.OnGetUser(ctx)
	}
	return &User{}, nil
}

func (s *ClientStub) ListRepos(ctx context.Context) ([]Repo, error) {
	if s.OnListRepos != nil {
		return s.OnListRepos(ctx)
	}
	return nil, nil
}

func (s *ClientStub) GetFileContent(ctx context.Context, owner, repo, ref, path string) (string, error) {
	if s.OnGetFileContent != nil {
		return s.OnGetFileContent(ctx, owner, repo, ref, path)
	}
	return "", nil
}

func (s *ClientStub) GetFiles(ctx context.Context, owner, repo, ref string) ([]FileEntry, error) {
	if s.OnGetFiles != nil {
		return s.OnGetFiles(ctx, owner, repo, ref)
	}
	return nil, nil
}

func (s *ClientStub) PushFiles(ctx context.Context, owner, repo, branch, message string, files []FileEntry) error {
	if s.OnPushFiles != nil {
		return s.OnPushFiles(ctx, owner, repo, branch, message, files)
	}
	return nil
}

func (s *ClientStub) InitRepo(ctx context.Context, owner, name, branch string, topics []string) error {
	if s.OnInitRepo != nil {
		return s.OnInitRepo(ctx, owner, name, branch, topics)
	}
	return nil
}

func (s *ClientStub) StoreSecret(ctx context.Context, owner, repo, name, value string) error {
	if s.OnStoreSecret != nil {
		return s.OnStoreSecret(ctx, owner, repo, name, value)
	}
	return nil
}

func (s *ClientStub) DeleteRepo(ctx context.Context, owner, repo string) error {
	if s.OnDeleteRepo != nil {
		return s.OnDeleteRepo(ctx, owner, repo)
	}
	return nil
}

func (s *ClientStub) LatestWorkflowRun(ctx context.Context, owner, repo, branch, workflowFile string) (*WorkflowRun, error) {
	if s.OnLatestWorkflowRun != nil {
		return s.OnLatestWorkflowRun(ctx, owner, repo, branch, workflowFile)
	}
	return nil, nil
}
