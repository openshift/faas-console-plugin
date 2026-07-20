package scm

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// CollectFiles walks root and returns every file as a FileEntry.
// Mode is set per Git conventions: "100644" regular, "100755" executable, "120000" symlink.
func CollectFiles(root string) ([]FileEntry, error) {
	var files []FileEntry
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		relPath, err := filepath.Rel(root, path)
		if err != nil {
			return fmt.Errorf("rel path: %w", err)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", relPath, err)
		}
		mode := "100644"
		info, err := d.Info()
		if err != nil {
			return fmt.Errorf("stat %s: %w", relPath, err)
		}
		if info.Mode()&0111 != 0 {
			mode = "100755"
		}
		if info.Mode()&os.ModeSymlink != 0 {
			mode = "120000"
		}
		files = append(files, FileEntry{Path: relPath, Mode: mode, Content: string(content), Type: "blob"})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk: %w", err)
	}
	return files, nil
}
