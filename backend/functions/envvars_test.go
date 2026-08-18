package functions

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	fn "knative.dev/func/pkg/functions"
)

var _ = Describe("envVarToFuncEnv", func() {
	It("converts a plain value env var", func() {
		ev := EnvVar{Name: "PORT", Value: "8080"}
		result := envVarToFuncEnv(ev)
		Expect(*result.Name).To(Equal("PORT"))
		Expect(*result.Value).To(Equal("8080"))
	})

	It("converts a secret reference", func() {
		ev := EnvVar{Name: "DB_PASS", Source: "secret", ResourceName: "db-creds", ResourceKey: "password"}
		result := envVarToFuncEnv(ev)
		Expect(*result.Name).To(Equal("DB_PASS"))
		Expect(*result.Value).To(Equal("{{ secret:db-creds:password }}"))
	})

	It("converts a configMap reference", func() {
		ev := EnvVar{Name: "LOG_LEVEL", Source: "configMap", ResourceName: "app-config", ResourceKey: "log-level"}
		result := envVarToFuncEnv(ev)
		Expect(*result.Name).To(Equal("LOG_LEVEL"))
		Expect(*result.Value).To(Equal("{{ configMap:app-config:log-level }}"))
	})

	It("treats unknown source as plain value", func() {
		ev := EnvVar{Name: "FOO", Source: "unknown", Value: "bar"}
		result := envVarToFuncEnv(ev)
		Expect(*result.Name).To(Equal("FOO"))
		Expect(*result.Value).To(Equal("bar"))
	})
})

var _ = Describe("injectEnvVars", func() {
	It("appends env vars to an initialized function", func() {
		root := GinkgoT().TempDir()

		_, err := fn.New().Init(fn.Function{
			Name:    "test-func",
			Root:    root,
			Runtime: "node",
		})
		Expect(err).NotTo(HaveOccurred())

		envs := []EnvVar{
			{Name: "PORT", Value: "8080"},
			{Name: "DB_PASS", Source: "secret", ResourceName: "db-creds", ResourceKey: "password"},
		}
		Expect(injectEnvVars(root, envs)).To(Succeed())

		f, err := fn.NewFunction(root)
		Expect(err).NotTo(HaveOccurred())
		Expect(f.Run.Envs).To(HaveLen(2))
		Expect(*f.Run.Envs[0].Name).To(Equal("PORT"))
		Expect(*f.Run.Envs[0].Value).To(Equal("8080"))
		Expect(*f.Run.Envs[1].Name).To(Equal("DB_PASS"))
		Expect(*f.Run.Envs[1].Value).To(Equal("{{ secret:db-creds:password }}"))
	})
})
