package handler

import (
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	k8svalidation "k8s.io/apimachinery/pkg/util/validation"
)

func isValidDNSLabel(s string) bool { return len(k8svalidation.IsDNS1123Label(s)) == 0 }

var _ = Describe("Request validation", func() {
	Describe("function name", func() {
		DescribeTable("accepts valid names",
			func(name string) { Expect(isValidDNSLabel(name)).To(BeTrue()) },
			Entry("single char", "f"),
			Entry("alphanumeric", "func123"),
			Entry("hyphenated", "my-func"),
		)
		DescribeTable("rejects invalid names",
			func(name string) { Expect(isValidDNSLabel(name)).To(BeFalse()) },
			Entry("empty", ""),
			Entry("uppercase", "My-Func"),
			Entry("underscore", "func_name"),
			Entry("leading hyphen", "-func"),
			Entry("trailing hyphen", "func-"),
			Entry("space", "func name"),
			Entry("too long", strings.Repeat("a", 64)),
		)
	})

	Describe("branch name", func() {
		DescribeTable("accepts valid names",
			func(b string) { Expect(validBranch.MatchString(b)).To(BeTrue()) },
			Entry("main", "main"),
			Entry("feature slash", "feature/my-thing"),
			Entry("version tag", "v1.0.0"),
		)
		DescribeTable("rejects invalid names",
			func(b string) { Expect(validBranch.MatchString(b)).To(BeFalse()) },
			Entry("empty", ""),
			Entry("space", "bad branch"),
			Entry("exclamation", "bad!branch"),
		)
	})

	Describe("namespace", func() {
		DescribeTable("accepts valid names",
			func(ns string) { Expect(isValidDNSLabel(ns)).To(BeTrue()) },
			Entry("default", "default"),
			Entry("hyphenated", "my-ns"),
		)
		DescribeTable("rejects invalid names",
			func(ns string) { Expect(isValidDNSLabel(ns)).To(BeFalse()) },
			Entry("empty", ""),
			Entry("uppercase", "My-NS"),
			Entry("underscore", "ns_1"),
			Entry("too long", strings.Repeat("a", 64)),
		)
	})
})
