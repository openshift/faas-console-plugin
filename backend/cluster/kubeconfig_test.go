package cluster

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"go.yaml.in/yaml/v3"
)

var _ = Describe("GenerateKubeconfig", func() {
	const fakeAPIURL = "https://api.example.com:6443"

	buildK8sMock := func() (Client, *map[string]int) {
		calls := &map[string]int{}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/serviceaccounts"):
				(*calls)["sa"]++
				writeJSON(w, http.StatusCreated, map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/roles"):
				(*calls)["role"]++
				writeJSON(w, http.StatusCreated, map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/rolebindings"):
				(*calls)["rb"]++
				writeJSON(w, http.StatusCreated, map[string]any{})
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/token"):
				(*calls)["token"]++
				writeJSON(w, http.StatusCreated, map[string]any{
					"status": map[string]string{"token": "sa-token-value"},
				})
			}
		}))
		DeferCleanup(srv.Close)
		cl, err := New("test-token", srv.URL, nil, 0)
		Expect(err).NotTo(HaveOccurred())
		return cl, calls
	}

	It("provisions RBAC and returns a valid kubeconfig", func() {
		cl, calls := buildK8sMock()

		kubeconfig, err := GenerateKubeconfig(context.Background(), cl, "default", fakeAPIURL, nil)

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

		kubeconfig, err := GenerateKubeconfig(context.Background(), cl, "default", fakeAPIURL, caCert)

		Expect(err).NotTo(HaveOccurred())
		var parsed map[string]any
		Expect(yaml.Unmarshal([]byte(kubeconfig), &parsed)).To(Succeed())
		clusters := parsed["clusters"].([]any)
		cluster := clusters[0].(map[string]any)["cluster"].(map[string]any)
		Expect(cluster).To(HaveKey("certificate-authority-data"))
	})
})
