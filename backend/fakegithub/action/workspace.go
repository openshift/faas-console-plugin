package action

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func WriteWorkspace(ctx context.Context, files map[string]string) (dir string, cleanup func(), err error) {
	dir, err = os.MkdirTemp("", "fakegithub-workspace-*")
	if err != nil {
		return "", nil, fmt.Errorf("create temp dir: %w", err)
	}
	cleanup = func() { os.RemoveAll(dir) }

	for path, content := range files {
		full := filepath.Join(dir, path)
		if mkErr := os.MkdirAll(filepath.Dir(full), 0o755); mkErr != nil {
			cleanup()
			return "", nil, fmt.Errorf("mkdir %s: %w", filepath.Dir(full), mkErr)
		}
		perm := os.FileMode(0o644)
		base := filepath.Base(path)
		if base == "mvnw" || base == "gradlew" || strings.HasSuffix(base, ".sh") {
			perm = 0o755
		}
		if writeErr := os.WriteFile(full, []byte(content), perm); writeErr != nil {
			cleanup()
			return "", nil, fmt.Errorf("write %s: %w", path, writeErr)
		}
	}

	gitCmds := [][]string{
		{"init", "-b", "main"},
		{"config", "user.email", "fakegithub@test.local"},
		{"config", "user.name", "fakegithub"},
		{"config", "commit.gpgsign", "false"},
		{"add", "."},
		{"commit", "-m", "sync"},
	}
	for _, args := range gitCmds {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = dir
		if out, cmdErr := cmd.CombinedOutput(); cmdErr != nil {
			cleanup()
			return "", nil, fmt.Errorf("git %v: %w\n%s", args, cmdErr, out)
		}
	}
	return dir, cleanup, nil
}
