package cluster

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	projectv1 "github.com/openshift/api/project/v1"
	projectfake "github.com/openshift/client-go/project/clientset/versioned/fake"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func projectObject(name string) *projectv1.Project {
	return &projectv1.Project{
		ObjectMeta: metav1.ObjectMeta{Name: name},
	}
}

func projectsClient(objects ...runtime.Object) *projectfake.Clientset {
	return projectfake.NewClientset(objects...)
}

var _ = Describe("Namespaces", func() {
	Describe("ListProjects", func() {
		It("returns the names of the projects the caller can see", func() {
			cl := &k8sClient{projects: projectsClient(projectObject("team-a"), projectObject("team-b"))}

			names, err := cl.ListProjects(context.Background())
			Expect(err).NotTo(HaveOccurred())
			Expect(names).To(ConsistOf("team-a", "team-b"))
		})

		It("returns an error when the list fails", func() {
			pc := projectsClient()
			pc.PrependReactor("list", "projects", func(action k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, forbiddenFor("projects")
			})
			cl := &k8sClient{projects: pc}

			_, err := cl.ListProjects(context.Background())
			Expect(err).To(HaveOccurred())
		})
	})

	Describe("CanCreateNamespaces", func() {
		reviewReturning := func(allowed bool) *fake.Clientset {
			cs := fake.NewSimpleClientset()
			cs.PrependReactor("create", "selfsubjectaccessreviews", func(action k8stesting.Action) (bool, runtime.Object, error) {
				review := action.(k8stesting.CreateAction).GetObject().(*authorizationv1.SelfSubjectAccessReview)
				attrs := review.Spec.ResourceAttributes
				Expect(attrs.Verb).To(Equal("create"))
				Expect(attrs.Resource).To(Equal("namespaces"))
				review.Status.Allowed = allowed
				return true, review, nil
			})
			return cs
		}

		It("is true when the caller may create namespaces", func() {
			cl := &k8sClient{clientset: reviewReturning(true)}

			allowed, err := cl.CanCreateNamespaces(context.Background())
			Expect(err).NotTo(HaveOccurred())
			Expect(allowed).To(BeTrue())
		})

		It("is false when the caller may not create namespaces", func() {
			cl := &k8sClient{clientset: reviewReturning(false)}

			allowed, err := cl.CanCreateNamespaces(context.Background())
			Expect(err).NotTo(HaveOccurred())
			Expect(allowed).To(BeFalse())
		})
	})

	DescribeTable("IsSystemNamespace",
		func(name string, expected bool) {
			Expect(IsSystemNamespace(name)).To(Equal(expected))
		},
		Entry("default", "default", true),
		Entry("openshift", "openshift", true),
		Entry("openshift- prefix", "openshift-monitoring", true),
		Entry("kube- prefix", "kube-system", true),
		Entry("knative- prefix", "knative-serving", true),
		Entry("user namespace", "my-functions", false),
		Entry("name that only starts with default", "defaulted", false),
		Entry("name that only starts with openshift", "openshiftish", false),
		Entry("empty", "", false),
	)
})
