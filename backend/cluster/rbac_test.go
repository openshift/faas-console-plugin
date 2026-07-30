package cluster

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

var _ = Describe("ProvisionRBAC", func() {

	It("creates all resources and reports them as provisioned", func() {
		cs := fake.NewSimpleClientset()
		cl := &k8sClient{clientset: cs}

		p, err := ProvisionRBAC(context.Background(), cl, "default")

		Expect(err).NotTo(HaveOccurred())
		Expect(p.ServiceAccount).To(BeTrue())
		Expect(p.Role).To(BeTrue())
		Expect(p.RoleBinding).To(BeTrue())
		Expect(p.ImageBuilderBinding).To(BeTrue())
	})

	It("reports false for pre-existing resources", func() {
		existingRole := roleBody("default")
		existingRole.ResourceVersion = "1"
		cs := fake.NewSimpleClientset(existingRole)
		cl := &k8sClient{clientset: cs}

		_, err := cl.CreateServiceAccount(context.Background(), "default")
		Expect(err).NotTo(HaveOccurred())
		_, err = cl.CreateRoleBinding(context.Background(), "default")
		Expect(err).NotTo(HaveOccurred())
		_, err = cl.CreateImageBuilderBinding(context.Background(), "default")
		Expect(err).NotTo(HaveOccurred())

		p, err := ProvisionRBAC(context.Background(), cl, "default")

		Expect(err).NotTo(HaveOccurred())
		Expect(p.ServiceAccount).To(BeFalse())
		Expect(p.Role).To(BeFalse())
		Expect(p.RoleBinding).To(BeFalse())
		Expect(p.ImageBuilderBinding).To(BeFalse())
	})

	It("returns an error when creating the service account fails", func() {
		cs := fake.NewSimpleClientset()
		cs.PrependReactor("create", "serviceaccounts", func(action k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, forbiddenFor("serviceaccounts")
		})
		cl := &k8sClient{clientset: cs}

		_, err := ProvisionRBAC(context.Background(), cl, "default")

		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("create service account"))
	})

	It("returns an error when applying the role fails", func() {
		cs := fake.NewSimpleClientset()
		cs.PrependReactor("create", "roles", func(action k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, forbiddenFor("roles")
		})
		cl := &k8sClient{clientset: cs}

		_, err := ProvisionRBAC(context.Background(), cl, "default")

		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("apply role"))
	})

	It("returns an error when creating the role binding fails", func() {
		cs := fake.NewSimpleClientset()
		cs.PrependReactor("create", "rolebindings", func(action k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, forbiddenFor("rolebindings")
		})
		cl := &k8sClient{clientset: cs}

		_, err := ProvisionRBAC(context.Background(), cl, "default")

		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("create role binding"))
	})

	It("returns an error when creating the image builder binding fails", func() {
		rbCount := 0
		cs := fake.NewSimpleClientset()
		cs.PrependReactor("create", "rolebindings", func(action k8stesting.Action) (bool, runtime.Object, error) {
			rbCount++
			if rbCount == 1 {
				return false, nil, nil
			}
			return true, nil, forbiddenFor("rolebindings")
		})
		cl := &k8sClient{clientset: cs}

		_, err := ProvisionRBAC(context.Background(), cl, "default")

		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("create image builder binding"))
	})
})
