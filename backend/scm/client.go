package scm

type Client interface {
	GetUser() (*User, error)
	GetFiles(owner, repo, ref string) ([]FileEntry, error)
	PushFiles(owner, repo, branch, message string, files []FileEntry) error
	InitRepo(owner, name, branch string, topics []string) error
	StoreSecret(owner, repo, name, value string) error
}

type User struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

type FileEntry struct {
	Path    string `json:"path"`
	Mode    string `json:"mode"`
	Content string `json:"content"`
	Type    string `json:"type"`
}
