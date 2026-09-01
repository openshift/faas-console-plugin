package tlsreload

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Reloader", func() {
	It("uses the certificate loaded after a rotation", func() {
		dir := GinkgoT().TempDir()
		certFile := filepath.Join(dir, "tls.crt")
		keyFile := filepath.Join(dir, "tls.key")

		writeCertificatePair(certFile, keyFile, "old.example.com")
		reloader, err := New(certFile, keyFile)
		Expect(err).NotTo(HaveOccurred())

		writeCertificatePair(certFile, keyFile, "new.example.com")
		Expect(reloader.reload()).To(Succeed())

		cert, err := reloader.GetCertificate(nil)
		Expect(err).NotTo(HaveOccurred())
		Expect(certificateCommonName(cert)).To(Equal("new.example.com"))
	})

	It("keeps the current certificate when the replacement is invalid", func() {
		dir := GinkgoT().TempDir()
		certFile := filepath.Join(dir, "tls.crt")
		keyFile := filepath.Join(dir, "tls.key")

		writeCertificatePair(certFile, keyFile, "current.example.com")
		reloader, err := New(certFile, keyFile)
		Expect(err).NotTo(HaveOccurred())

		Expect(os.WriteFile(certFile, []byte("invalid certificate"), 0600)).To(Succeed())
		Expect(reloader.reload()).To(MatchError(ContainSubstring("load TLS certificate")))

		cert, err := reloader.GetCertificate(nil)
		Expect(err).NotTo(HaveOccurred())
		Expect(certificateCommonName(cert)).To(Equal("current.example.com"))
	})

	It("skips reparsing when the certificate pair is unchanged", func() {
		dir := GinkgoT().TempDir()
		certFile := filepath.Join(dir, "tls.crt")
		keyFile := filepath.Join(dir, "tls.key")

		writeCertificatePair(certFile, keyFile, "stable.example.com")
		reloader, err := New(certFile, keyFile)
		Expect(err).NotTo(HaveOccurred())

		before, err := reloader.GetCertificate(nil)
		Expect(err).NotTo(HaveOccurred())

		Expect(reloader.reload()).To(Succeed())

		after, err := reloader.GetCertificate(nil)
		Expect(err).NotTo(HaveOccurred())
		Expect(after).To(BeIdenticalTo(before))
	})
})

func writeCertificatePair(certFile, keyFile, commonName string) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	Expect(err).NotTo(HaveOccurred())

	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: commonName},
		DNSNames:     []string{commonName},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	Expect(err).NotTo(HaveOccurred())

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	Expect(os.WriteFile(certFile, certPEM, 0600)).To(Succeed())
	Expect(os.WriteFile(keyFile, keyPEM, 0600)).To(Succeed())
}

func certificateCommonName(cert *tls.Certificate) string {
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	Expect(err).NotTo(HaveOccurred())
	return parsed.Subject.CommonName
}
