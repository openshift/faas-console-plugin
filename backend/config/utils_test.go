package config

import (
	"strconv"
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

var _ = Describe("ParseWorkflowPollingInterval", func() {
	DescribeTable("accepts positive durations", func(value string, want time.Duration) {
		got, err := ParseWorkflowPollingInterval(value)

		Expect(err).NotTo(HaveOccurred())
		Expect(got).To(Equal(want))
	},
		Entry("empty value uses the 3s default", "", 3*time.Second),
		Entry("flag default", "3s", 3*time.Second),
		Entry("seconds", "10s", 10*time.Second),
		Entry("minutes and seconds", "1m30s", 90*time.Second),
		Entry("milliseconds", "500ms", 500*time.Millisecond),
	)

	DescribeTable("rejects malformed, zero, and negative values", func(value string) {
		got, err := ParseWorkflowPollingInterval(value)

		Expect(err).To(MatchError(And(
			ContainSubstring(strconv.Quote(value)),
			ContainSubstring("must be a positive duration"),
		)))
		Expect(got).To(BeZero())
	},
		Entry("malformed", "abc"),
		Entry("missing unit", "10"),
		Entry("unknown unit", "5x"),
		Entry("days are not supported", "1d"),
		Entry("zero without unit", "0"),
		Entry("zero", "0s"),
		Entry("negative", "-1s"),
		Entry("negative minutes", "-5m"),
	)
})

var _ = Describe("RefreshWindow", func() {
	DescribeTable("derives the refresh threshold from the token lifetime", func(saTokenExpirySeconds int64, want time.Duration) {
		Expect(RefreshWindow(saTokenExpirySeconds)).To(Equal(want))
	},
		Entry("7 day default", DefaultSATokenExpiry, 28*time.Hour),
		Entry("24h lifetime", int64(24*60*60), 4*time.Hour),
		Entry("1h lifetime", int64(60*60), 10*time.Minute),
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
