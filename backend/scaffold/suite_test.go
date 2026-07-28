package scaffold

import (
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

func TestScaffold(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Scaffold Suite")
}
