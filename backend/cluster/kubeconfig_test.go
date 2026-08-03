package cluster

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"go.yaml.in/yaml/v3"

	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

const fakeAPIURL = "https://api.example.com:6443"

// tokenReactor handles CreateToken subresource requests on serviceaccounts.
func tokenReactor(token string) k8stesting.ReactionFunc {
	return func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() != "token" {
			return false, nil, nil
		}
		return true, &authenticationv1.TokenRequest{
			Status: authenticationv1.TokenRequestStatus{
				Token:               token,
				ExpirationTimestamp: metav1.NewTime(metav1.Now().Time),
			},
		}, nil
	}
}

// fullFakeClient returns a k8sClient backed by a fake clientset that succeeds
// for all RBAC operations and issues the given token on TokenRequest.
func fullFakeClient(token string) (*k8sClient, *fake.Clientset) {
	cs := fake.NewSimpleClientset()
	cs.PrependReactor("create", "serviceaccounts", tokenReactor(token))
	return &k8sClient{clientset: cs}, cs
}

var _ = Describe("GenerateKubeconfig", func() {

	It("returns a valid kubeconfig with the token and server URL", func() {
		cl, _ := fullFakeClient("sa-token-value")

		kubeconfig, err := GenerateKubeconfig(context.Background(), cl, "default", fakeAPIURL, nil)

		Expect(err).NotTo(HaveOccurred())

		var parsed map[string]any
		Expect(yaml.Unmarshal([]byte(kubeconfig), &parsed)).To(Succeed())
		Expect(parsed["apiVersion"]).To(Equal("v1"))
		clusters := parsed["clusters"].([]any)
		cluster := clusters[0].(map[string]any)["cluster"].(map[string]any)
		Expect(cluster["server"]).To(Equal(fakeAPIURL))
		Expect(cluster).NotTo(HaveKey("certificate-authority-data"))
		users := parsed["users"].([]any)
		user := users[0].(map[string]any)["user"].(map[string]any)
		Expect(user["token"]).To(Equal("sa-token-value"))
	})

	It("embeds the CA certificate when the cluster uses a private CA", func() {
		cl, _ := fullFakeClient("sa-token-value")
		caCert := []byte("-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n")

		kubeconfig, err := GenerateKubeconfig(context.Background(), cl, "default", fakeAPIURL, caCert)

		Expect(err).NotTo(HaveOccurred())
		var parsed map[string]any
		Expect(yaml.Unmarshal([]byte(kubeconfig), &parsed)).To(Succeed())
		clusters := parsed["clusters"].([]any)
		cluster := clusters[0].(map[string]any)["cluster"].(map[string]any)
		Expect(cluster).To(HaveKey("certificate-authority-data"))
	})

	It("returns an error when requesting the service account token fails", func() {
		cs := fake.NewSimpleClientset()
		cs.PrependReactor("create", "serviceaccounts", func(action k8stesting.Action) (bool, runtime.Object, error) {
			if action.GetSubresource() == "token" {
				return true, nil, forbiddenFor("serviceaccounts")
			}
			return false, nil, nil
		})
		cl := &k8sClient{clientset: cs}

		_, err := GenerateKubeconfig(context.Background(), cl, "default", fakeAPIURL, nil)

		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("request token"))
	})

	It("returns an error when the external API server URL is empty", func() {
		cl, _ := fullFakeClient("sa-token-value")

		_, err := GenerateKubeconfig(context.Background(), cl, "default", "", nil)

		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("API server URL is required"))
	})
})
