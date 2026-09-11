package tlsreload

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/fsnotify/fsnotify"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Reloader", func() {
	var (
		dir      string
		certFile string
		keyFile  string
	)

	BeforeEach(func() {
		dir = GinkgoT().TempDir()
		certFile = filepath.Join(dir, "tls.crt")
		keyFile = filepath.Join(dir, "tls.key")
	})

	Describe("New", func() {
		It("returns an error when the certificate files are missing", func() {
			_, err := New(certFile, keyFile)
			Expect(err).To(HaveOccurred())
		})

		It("returns an error when only the key file is missing", func() {
			writeCertificatePair(certFile, keyFile, "initial.example.com")
			Expect(os.Remove(keyFile)).To(Succeed())

			_, err := New(certFile, keyFile)
			Expect(err).To(HaveOccurred())
		})

		It("loads the initial certificate", func() {
			writeCertificatePair(certFile, keyFile, "initial.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())

			cert, err := reloader.GetCertificate(nil)
			Expect(err).NotTo(HaveOccurred())
			Expect(certificateCommonName(cert)).To(Equal("initial.example.com"))
		})
	})

	Describe("GetCertificate", func() {
		It("returns an error before a certificate is loaded", func() {
			reloader := &Reloader{}

			cert, err := reloader.GetCertificate(nil)
			Expect(err).To(HaveOccurred())
			Expect(cert).To(BeNil())
		})
	})

	It("keeps the current certificate when a removed file cannot be watched again", func() {
		writeCertificatePair(certFile, keyFile, "rewatch.example.com")
		reloader, err := New(certFile, keyFile)
		Expect(err).NotTo(HaveOccurred())
		watcher, err := fsnotify.NewWatcher()
		Expect(err).NotTo(HaveOccurred())
		Expect(watcher.Close()).To(Succeed())

		reloader.handleEvent(watcher, fsnotify.Event{Name: certFile, Op: fsnotify.Remove})

		cert, err := reloader.GetCertificate(nil)
		Expect(err).NotTo(HaveOccurred())
		Expect(certificateCommonName(cert)).To(Equal("rewatch.example.com"))
	})

	Describe("Run", func() {
		It("returns an error after a watcher channel closes", func() {
			writeCertificatePair(certFile, keyFile, "channel-close.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())

			original := newWatcher
			newWatcher = func() (*fsnotify.Watcher, error) {
				watcher, err := fsnotify.NewWatcher()
				Expect(err).NotTo(HaveOccurred())
				time.AfterFunc(20*time.Millisecond, func() {
					_ = watcher.Close()
				})
				return watcher, nil
			}
			DeferCleanup(func() { newWatcher = original })

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			err = reloader.watch(ctx, make(chan time.Time))
			Expect(err).To(MatchError(ContainSubstring("channel closed")))
		})

		It("keeps the current certificate when polling finds an invalid replacement", func() {
			writeCertificatePair(certFile, keyFile, "poll-current.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())
			Expect(os.WriteFile(certFile, []byte("invalid certificate"), 0600)).To(Succeed())

			original := newWatcher
			DeferCleanup(func() { newWatcher = original })
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ticks := make(chan time.Time, 1)
			done := make(chan error, 1)
			go func() { done <- reloader.watch(ctx, ticks) }()

			ticks <- time.Now()
			Consistently(func() string {
				cert, err := reloader.GetCertificate(nil)
				Expect(err).NotTo(HaveOccurred())
				return certificateCommonName(cert)
			}, 100*time.Millisecond, 10*time.Millisecond).Should(Equal("poll-current.example.com"))
			cancel()
			Expect(<-done).NotTo(HaveOccurred())
		})

		It("keeps the current certificate when an event reload fails", func() {
			writeCertificatePair(certFile, keyFile, "event-current.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())
			Expect(os.WriteFile(certFile, []byte("invalid certificate"), 0600)).To(Succeed())
			watcher, err := fsnotify.NewWatcher()
			Expect(err).NotTo(HaveOccurred())
			DeferCleanup(watcher.Close)

			reloader.handleEvent(watcher, fsnotify.Event{Name: certFile, Op: fsnotify.Write})

			cert, err := reloader.GetCertificate(nil)
			Expect(err).NotTo(HaveOccurred())
			Expect(certificateCommonName(cert)).To(Equal("event-current.example.com"))
		})

		DescribeTable("returns an error when watcher setup fails", func(factory func() (*fsnotify.Watcher, error), expected string) {
			writeCertificatePair(certFile, keyFile, "old.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())

			original := newWatcher
			newWatcher = factory
			DeferCleanup(func() { newWatcher = original })
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			err = reloader.watch(ctx, make(chan time.Time))
			Expect(err).To(MatchError(ContainSubstring(expected)))
		},
			Entry("creation fails", func() (*fsnotify.Watcher, error) {
				return nil, errors.New("watcher unavailable")
			}, "create fsnotify watcher"),
			Entry("registration fails", func() (*fsnotify.Watcher, error) {
				watcher, err := fsnotify.NewWatcher()
				if err != nil {
					return nil, err
				}
				return watcher, watcher.Close()
			}, "watch "),
		)

		It("serves the rotated certificate after the files change", func() {
			writeCertificatePair(certFile, keyFile, "old.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runInBackground(ctx, reloader)

			writeCertificatePair(certFile, keyFile, "new.example.com")

			Eventually(func() string {
				cert, err := reloader.GetCertificate(nil)
				Expect(err).NotTo(HaveOccurred())
				return certificateCommonName(cert)
			}).Should(Equal("new.example.com"))
		})

		It("keeps the current certificate when the replacement is invalid", func() {
			writeCertificatePair(certFile, keyFile, "current.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runInBackground(ctx, reloader)

			Expect(os.WriteFile(certFile, []byte("invalid certificate"), 0600)).To(Succeed())

			Consistently(func() string {
				cert, err := reloader.GetCertificate(nil)
				Expect(err).NotTo(HaveOccurred())
				return certificateCommonName(cert)
			}, 200*time.Millisecond, 20*time.Millisecond).Should(Equal("current.example.com"))
		})

		It("keeps serving the current certificate when the files are deleted", func() {
			writeCertificatePair(certFile, keyFile, "current.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runInBackground(ctx, reloader)

			Expect(os.Remove(certFile)).To(Succeed())
			Expect(os.Remove(keyFile)).To(Succeed())

			Consistently(func() string {
				cert, err := reloader.GetCertificate(nil)
				Expect(err).NotTo(HaveOccurred())
				return certificateCommonName(cert)
			}, 200*time.Millisecond, 20*time.Millisecond).Should(Equal("current.example.com"))
		})

		It("skips reloading when the certificate pair is unchanged", func() {
			writeCertificatePair(certFile, keyFile, "stable.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())

			before, err := reloader.GetCertificate(nil)
			Expect(err).NotTo(HaveOccurred())

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runInBackground(ctx, reloader)

			Consistently(func() *tls.Certificate {
				cert, err := reloader.GetCertificate(nil)
				Expect(err).NotTo(HaveOccurred())
				return cert
			}, 200*time.Millisecond, 20*time.Millisecond).Should(BeIdenticalTo(before))
		})

		It("stops when the context is cancelled", func() {
			writeCertificatePair(certFile, keyFile, "shutdown.example.com")
			reloader, err := New(certFile, keyFile)
			Expect(err).NotTo(HaveOccurred())

			ctx, cancel := context.WithCancel(context.Background())
			done := runInBackground(ctx, reloader)

			cancel()
			Eventually(done).Should(BeClosed())
		})
	})
})

// runInBackground starts the reloader and returns a channel that is closed when
// Run returns.
func runInBackground(ctx context.Context, reloader *Reloader) chan struct{} {
	done := make(chan struct{})
	DeferCleanup(func() { Eventually(done).Should(BeClosed()) })
	go func() {
		defer GinkgoRecover()
		defer close(done)
		reloader.Run(ctx)
	}()
	return done
}

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
