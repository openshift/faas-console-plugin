package scaffold

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/config"
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

var _ = Describe("Generate", func() {
	It("creates the function source and CI files for a Go function", func() {
		files, err := Generate(Config{
			Name:      "my-func",
			Runtime:   "go",
			Registry:  "image-registry.openshift-image-registry.svc:5000/default",
			Namespace: "default",
			Branch:    "main",
			SCM:       scm.GitHub,
		})

		Expect(err).NotTo(HaveOccurred())
		Expect(files).NotTo(BeEmpty())

		fileMap := map[string]string{}
		for _, f := range files {
			fileMap[f.Path] = f.Content
			Expect(f.Mode).NotTo(BeEmpty())
			Expect(f.Type).To(Equal("blob"))
		}

		Expect(fileMap).To(HaveKey("func.yaml"))
		funcYAML := fileMap["func.yaml"]
		Expect(funcYAML).To(ContainSubstring("my-func"))
		Expect(funcYAML).To(ContainSubstring("go"))
		Expect(funcYAML).To(ContainSubstring("image-registry.openshift-image-registry.svc:5000/default"))

		Expect(fileMap).To(HaveKey(".github/workflows/func-deploy.yaml"))
	})

	DescribeTable("produces source and CI files for all supported runtimes",
		func(runtime string) {
			files, err := Generate(Config{
				Name:      "test-fn",
				Runtime:   runtime,
				Registry:  "quay.io/myuser",
				Namespace: "default",
				Branch:    "main",
				SCM:       scm.GitHub,
			})
			Expect(err).NotTo(HaveOccurred())
			Expect(files).NotTo(BeEmpty())
		},
		Entry("node", "node"),
		Entry("python", "python"),
		Entry("go", "go"),
		Entry("quarkus", "quarkus"),
	)

	Describe("CI workflow", func() {
		It("targets the configured branch", func() {
			files, err := Generate(Config{
				Name: "my-func", Runtime: "go", Registry: "quay.io/myuser",
				Namespace: "default", Branch: "release", SCM: scm.GitHub,
			})
			Expect(err).NotTo(HaveOccurred())
			Expect(workflowContent(files)).To(ContainSubstring("release"))
		})

		It("includes registry login steps for external registries", func() {
			files, err := Generate(Config{
				Name: "my-func", Runtime: "go", Registry: "quay.io/myuser",
				Namespace: "default", Branch: "main", SCM: scm.GitHub,
			})
			Expect(err).NotTo(HaveOccurred())
			Expect(workflowContent(files)).To(ContainSubstring("docker/login-action"))
		})

		It("skips registry login for the OCP internal registry", func() {
			files, err := Generate(Config{
				Name: "my-func", Runtime: "go",
				Registry:  config.OCPInternalRegistry + "default",
				Namespace: "default", Branch: "main", SCM: scm.GitHub,
				InternalRegistry: true,
			})
			Expect(err).NotTo(HaveOccurred())
			Expect(workflowContent(files)).NotTo(ContainSubstring("docker/login-action"))
		})
	})
})
