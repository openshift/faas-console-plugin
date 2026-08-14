package functions

import (
	"context"
	"errors"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"k8s.io/client-go/rest"
	fn "knative.dev/func/pkg/functions"
)

type listerStub struct {
	list func(ctx context.Context, namespace string) ([]fn.ListItem, error)
}

func (s *listerStub) List(ctx context.Context, namespace string) ([]fn.ListItem, error) {
	return s.list(ctx, namespace)
}

func withKnativeLister(stub fn.Lister) {
	orig := newKnativeLister
	newKnativeLister = func(cfg *rest.Config) fn.Lister { return stub }
	DeferCleanup(func() { newKnativeLister = orig })
}

var _ = Describe("Lister.List", func() {
	It("returns the functions from the knative lister", func() {
		withKnativeLister(&listerStub{
			list: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				return []fn.ListItem{
					{Name: "a", Namespace: "ns1", Runtime: "go"},
					{Name: "b", Namespace: "ns2"},
				}, nil
			},
		})
		l := &client{}

		funcs, err := l.List(context.Background(), "")

		Expect(err).NotTo(HaveOccurred())
		Expect(funcs).To(Equal([]fn.ListItem{
			{Name: "a", Namespace: "ns1", Runtime: "go"},
			{Name: "b", Namespace: "ns2"},
		}))
	})

	It("passes the namespace through to the knative lister", func() {
		var gotNS string
		withKnativeLister(&listerStub{
			list: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				gotNS = namespace
				return nil, nil
			},
		})
		l := &client{}

		_, err := l.List(context.Background(), "team-a")

		Expect(err).NotTo(HaveOccurred())
		Expect(gotNS).To(Equal("team-a"))
	})

	It("wraps an error from the knative lister", func() {
		withKnativeLister(&listerStub{
			list: func(ctx context.Context, namespace string) ([]fn.ListItem, error) {
				return nil, errors.New("boom")
			},
		})
		l := &client{}

		_, err := l.List(context.Background(), "")

		Expect(err).To(MatchError("list cluster functions: boom"))
	})
})
