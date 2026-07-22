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
	GetFiles(ctx context.Context, owner, repo, ref string) ([]FileEntry, error)
	PushFiles(ctx context.Context, owner, repo, branch, message string, files []FileEntry) error
	InitRepo(ctx context.Context, owner, name, branch string, topics []string) error
	StoreSecret(ctx context.Context, owner, repo, name, value string) error
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
}
