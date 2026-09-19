package config

import (
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("ParseSATokenExpiry", func() {
	DescribeTable("parses token expiry values", func(value string, want int64, wantErr bool) {
		got, err := ParseSATokenExpiry(value)

		if wantErr {
			Expect(err).To(HaveOccurred())
		} else {
			Expect(err).NotTo(HaveOccurred())
		}
		Expect(got).To(Equal(want))
	},
		Entry("empty value uses default", "", DefaultSATokenExpiry, false),
		Entry("days", "30d", int64(30*24*60*60), false),
		Entry("hours", "10h", int64(10*60*60), false),
		Entry("days and hours", "7d12h", int64(7*24*60*60+12*60*60), false),
		Entry("hours and minutes", "1h30m", int64(90*60), false),
		Entry("malformed value", "not-a-duration", int64(0), true),
		Entry("invalid days component", "days1h", int64(0), true),
		Entry("invalid duration component", "1d2d", int64(0), true),
		Entry("zero", "0s", int64(0), true),
		Entry("negative", "-1s", int64(0), true),
		Entry("less than one second", "500ms", int64(0), true),
	)
})

var _ = Describe("parseExpiryDuration", func() {
	DescribeTable("parses extended duration values", func(value string, want time.Duration, wantErr bool) {
		got, err := parseExpiryDuration(value)

		if wantErr {
			Expect(err).To(HaveOccurred())
		} else {
			Expect(err).NotTo(HaveOccurred())
		}
		Expect(got).To(Equal(want))
	},
		Entry("days only", "2d", 48*time.Hour, false),
		Entry("non-numeric days", "days1h", time.Duration(0), true),
		Entry("invalid standard duration", "1d2d", time.Duration(0), true),
	)
})
