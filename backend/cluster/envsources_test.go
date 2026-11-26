package cluster

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

var _ = Describe("Environment variable sources", func() {
	Describe("ListSecrets", func() {
		It("returns each secret in the namespace with its sorted key names", func() {
			cs := fake.NewSimpleClientset(
				&corev1.Secret{
					ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "team-a"},
					Data:       map[string][]byte{"password": []byte("s3cret"), "user": []byte("admin")},
				},
				&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "elsewhere", Namespace: "team-b"}},
			)
			cl := &k8sClient{clientset: cs}

			items, err := cl.ListSecrets(context.Background(), "team-a")
			Expect(err).NotTo(HaveOccurred())
			Expect(items).To(Equal([]KeyedResource{{Name: "db", Keys: []string{"password", "user"}}}))
		})

		It("returns an empty, non-nil key list for a secret without data", func() {
			cs := fake.NewSimpleClientset(&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "empty", Namespace: "team-a"}})
			cl := &k8sClient{clientset: cs}

			items, err := cl.ListSecrets(context.Background(), "team-a")
			Expect(err).NotTo(HaveOccurred())
			Expect(items).To(HaveLen(1))
			Expect(items[0].Keys).NotTo(BeNil())
			Expect(items[0].Keys).To(BeEmpty())
		})

		It("returns ErrNamespaceForbidden when the caller may not list secrets", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("list", "secrets", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("secrets")
			})
			cl := &k8sClient{clientset: cs}

			_, err := cl.ListSecrets(context.Background(), "team-a")
			Expect(err).To(MatchError(ErrNamespaceForbidden))
		})
	})

	Describe("ListConfigMaps", func() {
		It("returns each config map with its sorted data key names, leaving out binary data", func() {
			cs := fake.NewSimpleClientset(&corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{Name: "settings", Namespace: "team-a"},
				Data:       map[string]string{"mode": "fast", "level": "debug"},
				BinaryData: map[string][]byte{"cert": {0x1}},
			})
			cl := &k8sClient{clientset: cs}

			items, err := cl.ListConfigMaps(context.Background(), "team-a")
			Expect(err).NotTo(HaveOccurred())
			Expect(items).To(Equal([]KeyedResource{{Name: "settings", Keys: []string{"level", "mode"}}}))
		})

		It("returns an empty list for a namespace with no config maps", func() {
			cl := &k8sClient{clientset: fake.NewSimpleClientset()}

			items, err := cl.ListConfigMaps(context.Background(), "ghost")
			Expect(err).NotTo(HaveOccurred())
			Expect(items).To(BeEmpty())
			Expect(items).NotTo(BeNil())
		})
	})
})
