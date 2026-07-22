package cluster

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

var _ = Describe("infrastructure", func() {

	Describe("getExternalAPIURL", func() {
		It("returns an error when cluster env vars are not set", func() {
			_, err := getExternalAPIURL(context.Background(), "fake-token", nil)
			Expect(err).To(MatchError(ContainSubstring("KUBERNETES_SERVICE_HOST")))
		})
	})

	Describe("fetchExternalAPIURL", func() {
		newDynClient := func(handler http.HandlerFunc) dynamic.Interface {
			srv := httptest.NewServer(handler)
			DeferCleanup(srv.Close)
			cfg := &rest.Config{
				Host: srv.URL,
				ContentConfig: rest.ContentConfig{
					ContentType:        "application/json",
					AcceptContentTypes: "application/json",
				},
			}
			dynClient, err := dynamic.NewForConfig(cfg)
			Expect(err).NotTo(HaveOccurred())
			return dynClient
		}

		It("returns the cluster's external API server URL from the infrastructure API", func() {
			dynClient := newDynClient(func(w http.ResponseWriter, r *http.Request) {
				defer GinkgoRecover()
				Expect(r.URL.Path).To(Equal("/apis/config.openshift.io/v1/infrastructures/cluster"))
				writeJSON(w, http.StatusOK, map[string]any{
					"apiVersion": "config.openshift.io/v1",
					"kind":       "Infrastructure",
					"metadata":   map[string]string{"name": "cluster"},
					"status":     map[string]string{"apiServerURL": "https://api.mycluster.example.com:6443"},
				})
			})

			url, err := fetchExternalAPIURL(context.Background(), dynClient)

			Expect(err).NotTo(HaveOccurred())
			Expect(url).To(Equal("https://api.mycluster.example.com:6443"))
		})

		It("returns an error when the infrastructure API is unavailable", func() {
			dynClient := newDynClient(func(w http.ResponseWriter, r *http.Request) {
				writeStatus(w, http.StatusForbidden, "Forbidden", "forbidden")
			})

			_, err := fetchExternalAPIURL(context.Background(), dynClient)

			Expect(err).To(MatchError(ContainSubstring("get infrastructure")))
		})

		It("returns an error when the status field is absent from the response", func() {
			dynClient := newDynClient(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{
					"apiVersion": "config.openshift.io/v1",
					"kind":       "Infrastructure",
				})
			})

			_, err := fetchExternalAPIURL(context.Background(), dynClient)

			Expect(err).To(MatchError(ContainSubstring("empty apiServerURL")))
		})

		It("returns an error when the apiServerURL field is empty", func() {
			dynClient := newDynClient(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{
					"apiVersion": "config.openshift.io/v1",
					"kind":       "Infrastructure",
					"status":     map[string]string{"apiServerURL": ""},
				})
			})

			_, err := fetchExternalAPIURL(context.Background(), dynClient)

			Expect(err).To(MatchError(ContainSubstring("empty apiServerURL")))
		})
	})

	Describe("resolveExternalAPIURL", func() {
		It("returns baseURL directly when non-empty (dev mode)", func() {
			url, err := resolveExternalAPIURL(context.Background(), "https://api.example.com:6443", nil)
			Expect(err).NotTo(HaveOccurred())
			Expect(url).To(Equal("https://api.example.com:6443"))
		})

		It("returns an error when the in-cluster SA token file is missing", func() {
			tmp := inClusterSATokenPath
			inClusterSATokenPath = "/nonexistent/sa/token"
			DeferCleanup(func() { inClusterSATokenPath = tmp })

			_, err := resolveExternalAPIURL(context.Background(), "", nil)
			Expect(err).To(MatchError(ContainSubstring("read SA token")))
		})

		It("returns an error when cluster env vars are not set but the token file exists", func() {
			f := GinkgoT().TempDir() + "/token"
			Expect(os.WriteFile(f, []byte("fake-sa-token"), 0600)).To(Succeed())
			tmp := inClusterSATokenPath
			inClusterSATokenPath = f
			DeferCleanup(func() { inClusterSATokenPath = tmp })

			_, err := resolveExternalAPIURL(context.Background(), "", nil)
			Expect(err).To(MatchError(ContainSubstring("KUBERNETES_SERVICE_HOST")))
		})
	})
})
