package github

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

func workflowContent(files []scm.FileEntry) string {
	for _, f := range files {
		if f.Path == ".github/workflows/func-deploy.yaml" {
			return f.Content
		}
	}
	return ""
}

var _ = Describe("GenerateCIFiles", func() {
	It("generates a workflow that targets the configured branch", func() {
		files, err := GenerateCIFiles(CIConfig{
			Runtime:  "go",
			Branch:   "release",
			Registry: "quay.io/myuser",
		})

		Expect(err).NotTo(HaveOccurred())
		Expect(workflowContent(files)).To(ContainSubstring("release"))
	})

	It("includes registry login steps for external registries", func() {
		files, err := GenerateCIFiles(CIConfig{
			Runtime:  "go",
			Branch:   "main",
			Registry: "quay.io/myuser",
		})

		Expect(err).NotTo(HaveOccurred())
		Expect(workflowContent(files)).To(ContainSubstring("docker/login-action"))
	})

	It("skips registry login for the OCP internal registry", func() {
		files, err := GenerateCIFiles(CIConfig{
			Runtime:  "go",
			Branch:   "main",
			Registry: OCPInternalRegistry + "default",
		})

		Expect(err).NotTo(HaveOccurred())
		Expect(workflowContent(files)).NotTo(ContainSubstring("docker/login-action"))
	})

	DescribeTable("generates a valid workflow for all supported runtimes",
		func(runtime string) {
			files, err := GenerateCIFiles(CIConfig{
				Runtime:  runtime,
				Branch:   "main",
				Registry: "quay.io/myuser",
			})
			Expect(err).NotTo(HaveOccurred())
			Expect(workflowContent(files)).NotTo(BeEmpty())
		},
		Entry("node", "node"),
		Entry("python", "python"),
		Entry("go", "go"),
		Entry("quarkus", "quarkus"),
	)
})
