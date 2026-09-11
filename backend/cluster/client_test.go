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

			created, err := cl.CreateServiceAccount(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())
			Expect(created).To(BeTrue())

			_, err = cs.CoreV1().ServiceAccounts("default").Get(context.Background(), saName, metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
		})

		It("returns false when the service account already exists", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			_, err := cl.CreateServiceAccount(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())

			created, err := cl.CreateServiceAccount(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())
			Expect(created).To(BeFalse())
		})

		It("returns an error for non-conflict failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "serviceaccounts", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("serviceaccounts")
			})
			cl := &k8sClient{clientset: cs}

			_, err := cl.CreateServiceAccount(context.Background(), "default")
			Expect(err).To(HaveOccurred())
		})
	})

	Describe("DeleteServiceAccount", func() {
		It("deletes the service account from the namespace", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			_, err := cl.CreateServiceAccount(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())

			Expect(cl.DeleteServiceAccount(context.Background(), "default")).To(Succeed())

			_, err = cs.CoreV1().ServiceAccounts("default").Get(context.Background(), saName, metav1.GetOptions{})
			Expect(k8serrors.IsNotFound(err)).To(BeTrue())
		})

		It("succeeds when the service account does not exist", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			Expect(cl.DeleteServiceAccount(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-NotFound failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("delete", "serviceaccounts", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("serviceaccounts")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.DeleteServiceAccount(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("ApplyRole", func() {
		It("creates the role with the required permissions when it does not exist", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			created, err := cl.ApplyRole(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())
			Expect(created).To(BeTrue())

			role, err := cs.RbacV1().Roles("default").Get(context.Background(), roleName, metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
			var resources []string
			for _, rule := range role.Rules {
				resources = append(resources, rule.Resources...)
			}
			Expect(resources).To(ContainElements("pods", "pods/exec", "services", "configmaps"))
		})

		It("returns false when the role already exists", func() {
			existing := &rbacv1.Role{
				ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: "default", ResourceVersion: "42"},
			}
			cs := fake.NewSimpleClientset(existing)
			cl := &k8sClient{clientset: cs}

			created, err := cl.ApplyRole(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())
			Expect(created).To(BeFalse())

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

			_, err := cl.ApplyRole(context.Background(), "default")
			Expect(err).To(HaveOccurred())
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

			_, err := cl.ApplyRole(context.Background(), "default")
			Expect(err).To(HaveOccurred())
		})

		It("returns an error when the existing role has no resourceVersion", func() {
			existing := &rbacv1.Role{
				ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: "default"},
			}
			cs := fake.NewSimpleClientset(existing)
			cl := &k8sClient{clientset: cs}

			_, err := cl.ApplyRole(context.Background(), "default")
			Expect(err).To(HaveOccurred())
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

			_, err := cl.ApplyRole(context.Background(), "default")
			Expect(err).To(HaveOccurred())
		})
	})

	Describe("DeleteRole", func() {
		It("deletes the role from the namespace", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			_, err := cl.ApplyRole(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())

			Expect(cl.DeleteRole(context.Background(), "default")).To(Succeed())

			_, err = cs.RbacV1().Roles("default").Get(context.Background(), roleName, metav1.GetOptions{})
			Expect(k8serrors.IsNotFound(err)).To(BeTrue())
		})

		It("succeeds when the role does not exist", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			Expect(cl.DeleteRole(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-NotFound failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("delete", "roles", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("roles")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.DeleteRole(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("CreateRoleBinding", func() {
		It("binds the service account to the deployer role", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			created, err := cl.CreateRoleBinding(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())
			Expect(created).To(BeTrue())

			rb, err := cs.RbacV1().RoleBindings("default").Get(context.Background(), roleName, metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
			Expect(rb.RoleRef.Kind).To(Equal("Role"))
			Expect(rb.RoleRef.Name).To(Equal(roleName))
		})

		It("returns false when the binding already exists", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			_, err := cl.CreateRoleBinding(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())

			created, err := cl.CreateRoleBinding(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())
			Expect(created).To(BeFalse())
		})

		It("returns an error for non-conflict failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "rolebindings", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("rolebindings")
			})
			cl := &k8sClient{clientset: cs}

			_, err := cl.CreateRoleBinding(context.Background(), "default")
			Expect(err).To(HaveOccurred())
		})
	})

	Describe("DeleteRoleBinding", func() {
		It("deletes the role binding from the namespace", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			_, err := cl.CreateRoleBinding(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())

			Expect(cl.DeleteRoleBinding(context.Background(), "default")).To(Succeed())

			_, err = cs.RbacV1().RoleBindings("default").Get(context.Background(), roleName, metav1.GetOptions{})
			Expect(k8serrors.IsNotFound(err)).To(BeTrue())
		})

		It("succeeds when the role binding does not exist", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			Expect(cl.DeleteRoleBinding(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-NotFound failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("delete", "rolebindings", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("rolebindings")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.DeleteRoleBinding(context.Background(), "default")).NotTo(Succeed())
		})
	})

	Describe("CreateImageBuilderBinding", func() {
		It("binds the service account to the image-builder cluster role", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			created, err := cl.CreateImageBuilderBinding(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())
			Expect(created).To(BeTrue())

			rb, err := cs.RbacV1().RoleBindings("default").Get(context.Background(), saName+"-image-builder", metav1.GetOptions{})
			Expect(err).NotTo(HaveOccurred())
			Expect(rb.RoleRef.Kind).To(Equal("ClusterRole"))
			Expect(rb.RoleRef.Name).To(Equal("system:image-builder"))
		})

		It("returns false when the binding already exists", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			_, err := cl.CreateImageBuilderBinding(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())

			created, err := cl.CreateImageBuilderBinding(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())
			Expect(created).To(BeFalse())
		})

		It("returns an error for non-conflict failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "rolebindings", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("rolebindings")
			})
			cl := &k8sClient{clientset: cs}

			_, err := cl.CreateImageBuilderBinding(context.Background(), "default")
			Expect(err).To(HaveOccurred())
		})
	})

	Describe("DeleteImageBuilderBinding", func() {
		It("deletes the image builder binding from the namespace", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}
			_, err := cl.CreateImageBuilderBinding(context.Background(), "default")
			Expect(err).NotTo(HaveOccurred())

			Expect(cl.DeleteImageBuilderBinding(context.Background(), "default")).To(Succeed())

			_, err = cs.RbacV1().RoleBindings("default").Get(context.Background(), saName+"-image-builder", metav1.GetOptions{})
			Expect(k8serrors.IsNotFound(err)).To(BeTrue())
		})

		It("succeeds when the binding does not exist", func() {
			cs := fake.NewSimpleClientset()
			cl := &k8sClient{clientset: cs}

			Expect(cl.DeleteImageBuilderBinding(context.Background(), "default")).To(Succeed())
		})

		It("returns an error for non-NotFound failures", func() {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("delete", "rolebindings", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("rolebindings")
			})
			cl := &k8sClient{clientset: cs}

			Expect(cl.DeleteImageBuilderBinding(context.Background(), "default")).NotTo(Succeed())
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

		It("requests a token with the configured expiry", func() {
			var requestedExpiry *int64
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "serviceaccounts", func(action k8stesting.Action) (bool, runtime.Object, error) {
				if action.GetSubresource() != "token" {
					return false, nil, nil
				}
				tr := action.(k8stesting.CreateAction).GetObject().(*authenticationv1.TokenRequest)
				requestedExpiry = tr.Spec.ExpirationSeconds
				return true, &authenticationv1.TokenRequest{
					Status: authenticationv1.TokenRequestStatus{Token: "sa-token-value"},
				}, nil
			})
			cl := &k8sClient{clientset: cs, tokenExpiry: 7 * 24 * 60 * 60}

			_, err := cl.RequestToken(context.Background(), "default")

			Expect(err).NotTo(HaveOccurred())
			Expect(requestedExpiry).NotTo(BeNil())
			Expect(*requestedExpiry).To(Equal(int64(7 * 24 * 60 * 60)))
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

var _ = Describe("ParseTokenExpiry", func() {
	It("defaults to 30 days when unset", func() {
		secs, err := ParseTokenExpiry("")

		Expect(err).NotTo(HaveOccurred())
		Expect(secs).To(Equal(int64(30 * 24 * 60 * 60)))
	})

	DescribeTable("parses common duration notation",
		func(value string, want int64) {
			secs, err := ParseTokenExpiry(value)
			Expect(err).NotTo(HaveOccurred())
			Expect(secs).To(Equal(want))
		},
		Entry("days", "7d", int64(7*24*60*60)),
		Entry("hours", "10h", int64(10*60*60)),
		Entry("minutes", "90m", int64(90*60)),
		Entry("days and hours combined", "7d12h", int64(7*24*60*60+12*60*60)),
	)

	DescribeTable("rejects invalid values",
		func(value string) {
			_, err := ParseTokenExpiry(value)
			Expect(err).To(HaveOccurred())
		},
		Entry("non-numeric", "banana"),
		Entry("missing unit", "720"),
		Entry("bare days unit", "d"),
		Entry("zero", "0h"),
		Entry("negative", "-5h"),
		Entry("rounds down to zero seconds", "500ms"),
	)
})
