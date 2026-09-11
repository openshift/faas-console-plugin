//go:build e2e

package e2e

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Local certificate probe", func() {
	It("returns the leaf serial when the TLS handshake succeeds", func() {
		server := httptest.NewTLSServer(http.NotFoundHandler())
		DeferCleanup(server.Close)

		serial, err := servedCertSerial(context.Background(), localPort(server.Listener))

		Expect(err).NotTo(HaveOccurred())
		Expect(serial).To(Equal(server.Certificate().SerialNumber.String()))
	})

	It("returns an error when the server does not speak TLS", func() {
		server := httptest.NewServer(http.NotFoundHandler())
		DeferCleanup(server.Close)

		serial, err := servedCertSerial(context.Background(), localPort(server.Listener))

		Expect(err).To(HaveOccurred())
		Expect(serial).To(BeEmpty())
	})

	It("does not accept a failed handshake as a certificate rotation", func() {
		server := httptest.NewServer(http.NotFoundHandler())
		DeferCleanup(server.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		DeferCleanup(cancel)

		failures := InterceptGomegaFailures(func() {
			waitForRotatedCert(ctx, localPort(server.Listener), "123")
		})

		Expect(failures).To(HaveLen(1))
	})

	It("retains the successful rotated serial without a second handshake", func() {
		server := httptest.NewUnstartedServer(http.NotFoundHandler())
		var handshakes atomic.Int32
		server.TLS = &tls.Config{GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			if handshakes.Add(1) > 1 {
				return nil, errors.New("subsequent handshake rejected")
			}
			return nil, nil
		}}
		server.StartTLS()
		DeferCleanup(server.Close)

		serial := waitForRotatedCert(context.Background(), localPort(server.Listener), "123")

		Expect(serial).To(Equal(server.Certificate().SerialNumber.String()))
	})

	It("keeps waiting when a successful handshake serves the original certificate", func() {
		server := httptest.NewTLSServer(http.NotFoundHandler())
		DeferCleanup(server.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		DeferCleanup(cancel)

		failures := InterceptGomegaFailures(func() {
			waitForRotatedCert(ctx, localPort(server.Listener), server.Certificate().SerialNumber.String())
		})

		Expect(failures).To(HaveLen(1))
	})

	It("waits for a successful rotated certificate after a transient handshake failure", func() {
		server := httptest.NewUnstartedServer(http.NotFoundHandler())
		var handshakes atomic.Int32
		server.TLS = &tls.Config{GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			if handshakes.Add(1) == 1 {
				return nil, errors.New("temporary handshake failure")
			}
			return nil, nil
		}}
		server.StartTLS()
		DeferCleanup(server.Close)

		serial := waitForRotatedCert(context.Background(), localPort(server.Listener), "123")

		Expect(serial).To(Equal(server.Certificate().SerialNumber.String()))
	})

	It("cancels an in-flight handshake when the rotation wait deadline expires", func() {
		port := stalledTLSPort()
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		DeferCleanup(cancel)
		started := time.Now()

		failures := InterceptGomegaFailures(func() {
			waitForRotatedCert(ctx, port, "123")
		})

		Expect(failures).To(HaveLen(1))
		Expect(time.Since(started)).To(BeNumerically("<", time.Second))
	})

	It("honors the caller deadline when the TLS handshake stalls", func() {
		port := stalledTLSPort()
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		DeferCleanup(cancel)
		result := make(chan error, 1)

		go func() {
			_, err := servedCertSerial(ctx, port)
			result <- err
		}()

		Eventually(result, time.Second).Should(Receive(MatchError(context.DeadlineExceeded)))
	})

	It("bounds a stalled TLS handshake even without a caller deadline", func() {
		port := stalledTLSPort()
		result := make(chan error, 1)

		go func() {
			_, err := servedCertSerial(context.Background(), port)
			result <- err
		}()

		Eventually(result, 2*certProbeTimeout).Should(Receive(MatchError(context.DeadlineExceeded)))
	})
})

func localPort(listener net.Listener) uint16 {
	return uint16(listener.Addr().(*net.TCPAddr).Port)
}

func stalledTLSPort() uint16 {
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	Expect(err).NotTo(HaveOccurred())
	stop := make(chan struct{})
	done := make(chan struct{})
	DeferCleanup(func() {
		close(stop)
		Expect(listener.Close()).To(Succeed())
		Eventually(done, time.Second).Should(BeClosed())
	})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		<-stop
	}()
	return localPort(listener)
}
