package scm

import "context"

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
