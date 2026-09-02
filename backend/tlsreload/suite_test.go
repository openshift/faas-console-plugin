package tlsreload

import (
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

func TestTLSReload(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "TLS Reload Suite")
}
