package cluster

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"go.yaml.in/yaml/v3"
)

func newClient(handler http.HandlerFunc) Client {
	srv := httptest.NewServer(handler)
	DeferCleanup(srv.Close)
	cl, err := New("test-token", srv.URL, nil, 0)
	Expect(err).NotTo(HaveOccurred())
	return cl
}

func assertAuth(r *http.Request) {
	Expect(r.Header.Get("Authorization")).To(Equal("Bearer test-token"))
}

var _ = Describe("Kubernetes cluster client", func() {

	Describe("CreateServiceAccount", func() {
		It("creates the service account in the namespace", func() {
			called := false
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(r)
				Expect(r.Method).To(Equal(http.MethodPost))
				Expect(r.URL.Path).To(ContainSubstring("/serviceaccounts"))
				called = true
				w.WriteHeader(http.StatusCreated)
			})

			Expect(cl.CreateServiceAccount("default")).To(Succeed())
			Expect(called).To(BeTrue())
		})

		It("succeeds when the service account already exists", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(map[string]string{"reason": "AlreadyExists", "message": "already exists"})
			})

			Expect(cl.CreateServiceAccount("default")).To(Succeed())
		})

		It("returns an error for non-conflict failures", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"reason": "Forbidden", "message": "forbidden"})
			})

			Expect(cl.CreateServiceAccount("default")).NotTo(Succeed())
		})
	})

	Describe("ApplyRole", func() {
		It("creates the role with the required permissions when it does not exist", func() {
			postCalled := false
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					postCalled = true
					var body map[string]any
					json.NewDecoder(r.Body).Decode(&body)
					rules, _ := body["rules"].([]any)
					var resources []string
					for _, rule := range rules {
						for _, res := range rule.(map[string]any)["resources"].([]any) {
							resources = append(resources, res.(string))
						}
					}
					Expect(resources).To(ContainElements("pods", "pods/exec", "services", "configmaps"))
					w.WriteHeader(http.StatusCreated)
				}
			})

			Expect(cl.ApplyRole("default")).To(Succeed())
			Expect(postCalled).To(BeTrue())
		})

		It("updates the role when it already exists, preserving the resource version", func() {
			putCalled := false
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodPost:
					w.WriteHeader(http.StatusConflict)
					json.NewEncoder(w).Encode(map[string]string{"reason": "AlreadyExists"})
				case http.MethodGet:
					json.NewEncoder(w).Encode(map[string]any{
						"metadata": map[string]string{"name": roleName, "resourceVersion": "42"},
					})
				case http.MethodPut:
					putCalled = true
					var body map[string]any
					json.NewDecoder(r.Body).Decode(&body)
					meta := body["metadata"].(map[string]any)
					Expect(meta["resourceVersion"]).To(Equal("42"))
					json.NewEncoder(w).Encode(map[string]string{})
				}
			})

			Expect(cl.ApplyRole("default")).To(Succeed())
			Expect(putCalled).To(BeTrue())
		})
	})

	Describe("CreateRoleBinding", func() {
		It("binds the service account to the deployer role", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				roleRef := body["roleRef"].(map[string]any)
				Expect(roleRef["kind"]).To(Equal("Role"))
				Expect(roleRef["name"]).To(Equal(roleName))
				w.WriteHeader(http.StatusCreated)
			})

			Expect(cl.CreateRoleBinding("default")).To(Succeed())
		})

		It("succeeds when the binding already exists", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(map[string]string{"reason": "AlreadyExists"})
			})

			Expect(cl.CreateRoleBinding("default")).To(Succeed())
		})

		It("returns an error for non-conflict failures", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"reason": "Forbidden", "message": "forbidden"})
			})

			Expect(cl.CreateRoleBinding("default")).NotTo(Succeed())
		})
	})

	Describe("CreateImageBuilderBinding", func() {
		It("binds the service account to the image-builder cluster role", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				roleRef := body["roleRef"].(map[string]any)
				Expect(roleRef["kind"]).To(Equal("ClusterRole"))
				Expect(roleRef["name"]).To(Equal("system:image-builder"))
				w.WriteHeader(http.StatusCreated)
			})

			Expect(cl.CreateImageBuilderBinding("default")).To(Succeed())
		})

		It("returns an error for non-conflict failures", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"reason": "Forbidden", "message": "forbidden"})
			})

			Expect(cl.CreateImageBuilderBinding("default")).NotTo(Succeed())
		})
	})

	Describe("RequestToken", func() {
		It("returns a bound service account token", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(r)
				Expect(r.URL.Path).To(ContainSubstring("/token"))
				json.NewEncoder(w).Encode(map[string]any{
					"status": map[string]any{
						"token":               "sa-token-value",
						"expirationTimestamp": "2026-10-18T14:30:00Z",
					},
				})
			})

			token, err := cl.RequestToken("default")

			Expect(err).NotTo(HaveOccurred())
			Expect(token).To(Equal("sa-token-value"))
		})

		It("returns an error when the token endpoint is unavailable", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"reason": "Forbidden", "message": "forbidden"})
			})

			_, err := cl.RequestToken("default")

			Expect(err).To(HaveOccurred())
		})
	})

	Describe("GetExternalAPIURL", func() {
		It("returns the cluster's external API server URL from the infrastructure API", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(r)
				Expect(r.URL.Path).To(Equal("/apis/config.openshift.io/v1/infrastructures/cluster"))
				json.NewEncoder(w).Encode(map[string]any{
					"status": map[string]string{"apiServerURL": "https://api.mycluster.example.com:6443"},
				})
			})

			url, err := cl.GetExternalAPIURL()

			Expect(err).NotTo(HaveOccurred())
			Expect(url).To(Equal("https://api.mycluster.example.com:6443"))
		})

		It("returns an error when the infrastructure API is unavailable", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"message": "Forbidden"})
			})

			_, err := cl.GetExternalAPIURL()

			Expect(err).To(HaveOccurred())
		})

		It("returns an error when the response has no API server URL", func() {
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{
					"status": map[string]string{"apiServerURL": ""},
				})
			})

			_, err := cl.GetExternalAPIURL()

			Expect(err).To(HaveOccurred())
		})
	})

	Describe("resolveExternalAPIURL", func() {
		It("returns baseURL directly when non-empty (dev mode)", func() {
			url, err := resolveExternalAPIURL("https://api.example.com:6443", nil)
			Expect(err).NotTo(HaveOccurred())
			Expect(url).To(Equal("https://api.example.com:6443"))
		})

		It("returns an error when the in-cluster SA token file is missing", func() {
			_, err := resolveExternalAPIURL("", nil)
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("read SA token"))
		})
	})

	Describe("GenerateKubeconfig", func() {
		const fakeAPIURL = "https://api.example.com:6443"

		buildK8sMock := func() (Client, *map[string]int) {
			calls := &map[string]int{}
			cl := newClient(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/serviceaccounts"):
					(*calls)["sa"]++
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/roles"):
					(*calls)["role"]++
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/rolebindings"):
					(*calls)["rb"]++
					w.WriteHeader(http.StatusCreated)
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/token"):
					(*calls)["token"]++
					json.NewEncoder(w).Encode(map[string]any{
						"status": map[string]string{"token": "sa-token-value"},
					})
				}
			})
			return cl, calls
		}

		It("provisions RBAC and returns a valid kubeconfig", func() {
			cl, calls := buildK8sMock()

			kubeconfig, err := GenerateKubeconfig(cl, "default", fakeAPIURL, nil)

			Expect(err).NotTo(HaveOccurred())
			Expect((*calls)["sa"]).To(Equal(1))
			Expect((*calls)["role"]).To(Equal(1))
			Expect((*calls)["rb"]).To(Equal(2))
			Expect((*calls)["token"]).To(Equal(1))

			var parsed map[string]any
			Expect(yaml.Unmarshal([]byte(kubeconfig), &parsed)).To(Succeed())
			Expect(parsed["apiVersion"]).To(Equal("v1"))
			clusters := parsed["clusters"].([]any)
			cluster := clusters[0].(map[string]any)["cluster"].(map[string]any)
			Expect(cluster["server"]).To(Equal(fakeAPIURL))
			Expect(cluster).NotTo(HaveKey("certificate-authority-data"))
		})

		It("embeds the CA certificate when the cluster uses a private CA", func() {
			cl, _ := buildK8sMock()
			caCert := []byte("-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n")

			kubeconfig, err := GenerateKubeconfig(cl, "default", fakeAPIURL, caCert)

			Expect(err).NotTo(HaveOccurred())
			var parsed map[string]any
			Expect(yaml.Unmarshal([]byte(kubeconfig), &parsed)).To(Succeed())
			clusters := parsed["clusters"].([]any)
			cluster := clusters[0].(map[string]any)["cluster"].(map[string]any)
			Expect(cluster).To(HaveKey("certificate-authority-data"))
		})
	})
})
