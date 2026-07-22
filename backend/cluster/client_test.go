package cluster

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	authenticationv1 "k8s.io/api/authentication/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func forbiddenFor(resource string) error {
	return k8serrors.NewForbidden(schema.GroupResource{Resource: resource}, "", nil)
}

var _ = Describe("Kubernetes cluster client", func() {

	Describe("CreateServiceAccount", func() {
		It("creates the service account in the namespace", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			Expect(cl.CreateServiceAccount(context.Background(), "default")).To(Succeed())

			_, err := cs.CoreV1().ServiceAccounts("default").Get(context.Background(), saName, metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
		})

		It("succeeds when the service account already exists", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			Expect(cl.CreateServiceAccount(context.Background(), "default")).To(Succeed())

			Expect(cl.CreateServiceAccount(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-conflict failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "serviceaccounts", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("serviceaccounts")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.CreateServiceAccount(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("ApplyRole", func() {
		It("creates the role with the required permissions when it does not exist", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			Expect(cl.ApplyRole(context.Background(), "default")).To(Succeed())

			role, err := cs.RbacV1().Roles("default").Get(context.Background(), roleName, metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
			var resources []string
			for _, rule := range role.Rules {
				resources = append(resources, rule.Resources...)
			}
			Expect(resources).To(ContainElements("pods", "pods/exec", "services", "configmaps"))
		})

		It("updates the role when it already exists, forwarding the existing resourceVersion", func() {
			existing := &rbacv1.Role{
				ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: "default", ResourceVersion: "42"},
			}
			cs := fake.NewSimpleClientset(existing)
			cl := &k8sClient{clientset: cs}

			Expect(cl.ApplyRole(context.Background(), "default")).To(Succeed())

			var capturedRV string
			for _, a := range cs.Actions() {
				if a.GetVerb() == "update" {
					capturedRV = a.(k8stesting.UpdateAction).GetObject().(*rbacv1.Role).ResourceVersion
				}
			}
			Expect(capturedRV).To(Equal("42"))
		})

		It("returns an error when role creation fails with a non-conflict error", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "roles", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("roles")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.ApplyRole(context.Background(), "default")).NotTo(Succeed())
		})

		It("returns an error when fetching the existing role fails", func() {
			existing := &rbacv1.Role{
				ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: "default", ResourceVersion: "1"},
			}
			cs := fake.NewSimpleClientset(existing)
			cs.PrependReactor("get", "roles", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("roles")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.ApplyRole(context.Background(), "default")).NotTo(Succeed())
		})

		It("returns an error when the existing role has no resourceVersion", func() {
			existing := &rbacv1.Role{
				ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: "default"},
			}
			cs := fake.NewSimpleClientset(existing)
			cl := &k8sClient{clientset: cs}

			Expect(cl.ApplyRole(context.Background(), "default")).NotTo(Succeed())
		})

		It("returns an error when updating the existing role fails", func() {
			existing := &rbacv1.Role{
				ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: "default", ResourceVersion: "42"},
			}
			cs := fake.NewSimpleClientset(existing)
			cs.PrependReactor("update", "roles", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("roles")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.ApplyRole(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("CreateRoleBinding", func() {
		It("binds the service account to the deployer role", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			Expect(cl.CreateRoleBinding(context.Background(), "default")).To(Succeed())

			rb, err := cs.RbacV1().RoleBindings("default").Get(context.Background(), roleName, metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
			Expect(rb.RoleRef.Kind).To(Equal("Role"))
			Expect(rb.RoleRef.Name).To(Equal(roleName))
		})

		It("succeeds when the binding already exists", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			Expect(cl.CreateRoleBinding(context.Background(), "default")).To(Succeed())

			Expect(cl.CreateRoleBinding(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-conflict failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "rolebindings", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("rolebindings")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.CreateRoleBinding(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("CreateImageBuilderBinding", func() {
		It("binds the service account to the image-builder cluster role", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			Expect(cl.CreateImageBuilderBinding(context.Background(), "default")).To(Succeed())

			rb, err := cs.RbacV1().RoleBindings("default").Get(context.Background(), saName+"-image-builder", metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
			Expect(rb.RoleRef.Kind).To(Equal("ClusterRole"))
			Expect(rb.RoleRef.Name).To(Equal("system:image-builder"))
		})

		It("succeeds when the binding already exists", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			Expect(cl.CreateImageBuilderBinding(context.Background(), "default")).To(Succeed())

			Expect(cl.CreateImageBuilderBinding(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-conflict failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "rolebindings", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("rolebindings")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.CreateImageBuilderBinding(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("RequestToken", func() {
		It("returns a bound service account token", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "serviceaccounts", func(action k8stesting.Action) (bool, runtime.Object, error) {
				if action.GetSubresource() != "token" {
					return false, nil, nil
				}
				return true, &authenticationv1.TokenRequest{
					Status: authenticationv1.TokenRequestStatus{
						Token:               "sa-token-value",
						ExpirationTimestamp: metav1.NewTime(metav1.Now().Time),
					},
				}, nil
			})
			cl := &k8sClient{clientset: cs}

			token, err := cl.RequestToken(context.Background(), "default")

			Expect(err).NotTo(HaveOccurred())
			Expect(token).To(Equal("sa-token-value"))
		})

		It("returns an error when the token endpoint is unavailable", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "serviceaccounts", func(action k8stesting.Action) (bool, runtime.Object, error) {
				if action.GetSubresource() != "token" {
					return false, nil, nil
				}
				return true, nil, forbiddenFor("serviceaccounts")
			})
			cl := &k8sClient{clientset: cs}

			_, err := cl.RequestToken(context.Background(), "default")

			Expect(err).To(HaveOccurred())
		})
	})
})
