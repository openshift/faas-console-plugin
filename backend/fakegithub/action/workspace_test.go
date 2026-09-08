package action_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/fakegithub/action"
)

func TestAction(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Action Suite")
}

var _ = Describe("WriteWorkspace", func() {
	It("writes files to disk and initialises a git repo", func() {
		files := map[string]string{
			".github/workflows/func-deploy.yaml": "name: Deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
			"func.yaml":                          "name: my-func\n",
		}

		dir, cleanup, err := action.WriteWorkspace(context.Background(), files)
		Expect(err).NotTo(HaveOccurred())
		defer cleanup()

		Expect(dir).NotTo(BeEmpty())

		content, err := os.ReadFile(filepath.Join(dir, "func.yaml"))
		Expect(err).NotTo(HaveOccurred())
		Expect(string(content)).To(Equal("name: my-func\n"))

		_, err = os.Stat(filepath.Join(dir, ".github", "workflows", "func-deploy.yaml"))
		Expect(err).NotTo(HaveOccurred())

		_, err = os.Stat(filepath.Join(dir, ".git"))
		Expect(err).NotTo(HaveOccurred())
	})

	It("makes mvnw and gradlew executable", func() {
		files := map[string]string{
			"mvnw":    "#!/bin/sh\n",
			"gradlew": "#!/bin/sh\n",
			"run.sh":  "#!/bin/sh\n",
			"README":  "just a file\n",
		}
		dir, cleanup, err := action.WriteWorkspace(context.Background(), files)
		Expect(err).NotTo(HaveOccurred())
		defer cleanup()

		for _, name := range []string{"mvnw", "gradlew", "run.sh"} {
			info, statErr := os.Stat(filepath.Join(dir, name))
			Expect(statErr).NotTo(HaveOccurred())
			Expect(info.Mode()&0o111).NotTo(BeZero(), "%s should be executable", name)
		}
		info, err := os.Stat(filepath.Join(dir, "README"))
		Expect(err).NotTo(HaveOccurred())
		Expect(info.Mode()&0o111).To(BeZero(), "README should not be executable")
	})

	It("cleans up the temp directory when cleanup is called", func() {
		dir, cleanup, err := action.WriteWorkspace(context.Background(), map[string]string{"a.txt": "hello"})
		Expect(err).NotTo(HaveOccurred())
		cleanup()
		_, statErr := os.Stat(dir)
		Expect(os.IsNotExist(statErr)).To(BeTrue())
	})
})
