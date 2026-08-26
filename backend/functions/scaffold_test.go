package functions

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/openshift/faas-console-plugin/backend/scm"
)

var _ = Describe("Generate", func() {
	It("creates the function source and CI files for a Go function", func() {
		files, err := Generate(ScaffoldConfig{
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

	It("returns an error when function init fails", func() {
		_, err := Generate(ScaffoldConfig{
			Name: "my-func", Runtime: "invalid-runtime", Registry: "quay.io/myuser",
			Namespace: "default", Branch: "main", SCM: scm.GitHub,
		})
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("init function"))
	})

	It("returns an error for an unsupported SCM platform", func() {
		_, err := Generate(ScaffoldConfig{
			Name: "my-func", Runtime: "go", Registry: "quay.io/myuser",
			Namespace: "default", Branch: "main", SCM: scm.Platform("gitlab"),
		})
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("unsupported SCM"))
	})

})
