package functions

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

func collectFiles(root string) ([]scm.FileEntry, error) {
	var files []scm.FileEntry
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
		files = append(files, scm.FileEntry{Path: relPath, Mode: mode, Content: string(content), Type: "blob"})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk: %w", err)
	}
	return files, nil
}
