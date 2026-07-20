package github

import (
	"encoding/base64"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Secret encryption", func() {

	Describe("base64ToUTF8", func() {
		It("decodes standard base64", func() {
			encoded := base64.StdEncoding.EncodeToString([]byte("hello world"))
			got, err := base64ToUTF8(encoded)
			Expect(err).NotTo(HaveOccurred())
			Expect(got).To(Equal("hello world"))
		})

		It("strips GitHub API line breaks before decoding", func() {
			raw := base64.StdEncoding.EncodeToString([]byte("hello world"))
			withNewlines := raw[:4] + "\n" + raw[4:] + "\n"
			got, err := base64ToUTF8(withNewlines)
			Expect(err).NotTo(HaveOccurred())
			Expect(got).To(Equal("hello world"))
		})

		It("returns an error for invalid base64", func() {
			_, err := base64ToUTF8("not-valid-base64!!!")
			Expect(err).To(HaveOccurred())
		})
	})

	Describe("encryptSecret", func() {
		It("produces valid base64 output for a well-formed public key", func() {
			pubKey := base64.StdEncoding.EncodeToString(make([]byte, 32))
			encrypted, err := encryptSecret(pubKey, "my-secret-value")
			Expect(err).NotTo(HaveOccurred())
			_, decodeErr := base64.StdEncoding.DecodeString(encrypted)
			Expect(decodeErr).NotTo(HaveOccurred())
		})

		It("returns an error for an invalid public key", func() {
			_, err := encryptSecret("not-valid-base64!!!", "value")
			Expect(err).To(HaveOccurred())
		})

		It("returns an error when the key is not 32 bytes", func() {
			shortKey := base64.StdEncoding.EncodeToString(make([]byte, 16))
			_, err := encryptSecret(shortKey, "value")
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("32 bytes"))
		})
	})
})
