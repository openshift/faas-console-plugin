package ticker

import (
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

func TestTicker(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Ticker Suite")
}
