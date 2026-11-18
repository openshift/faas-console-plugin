package ticker

import (
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("Ticker", func() {
	Describe("CreateFakeTickerFactory", func() {
		It("panics on second invocation", func() {
			tick, newTicker := CreateFakeTickerFactory()
			_ = tick // silence unused warning

			// First invocation should succeed
			ticker1 := newTicker(0)
			Expect(ticker1).NotTo(BeNil())

			// Second invocation should panic
			Expect(func() {
				_ = newTicker(0)
			}).To(Panic())
		})
	})

	Describe("tickerFake", func() {
		It("sends a tick when tick() is called", func() {
			tick, newTicker := CreateFakeTickerFactory()
			ticker := newTicker(0)
			DeferCleanup(ticker.Stop)

			ch := ticker.Chan()
			Expect(ch).NotTo(BeNil())

			go tick()
			Eventually(ch).Should(Receive())
		})

		It("panics when tick() is called after Stop()", func() {
			tick, newTicker := CreateFakeTickerFactory()
			ticker := newTicker(0)

			ticker.Stop()

			Expect(func() {
				tick()
			}).To(Panic())
		})

		It("is idempotent (multiple Stop() calls are safe)", func() {
			_, newTicker := CreateFakeTickerFactory()
			ticker := newTicker(0)

			// First Stop should succeed
			ticker.Stop()

			// Second Stop should not panic (idempotent like time.Ticker)
			Expect(func() {
				ticker.Stop()
			}).NotTo(Panic())
		})
	})

	Describe("SilentTickerFactory", func() {
		It("returns a ticker with nil channel", func() {
			newTicker := SilentTickerFactory()
			ticker := newTicker(0)

			Expect(ticker.Chan()).To(BeNil())
		})
	})

	Describe("New", func() {
		It("returns a working ticker that emits ticks", func() {
			ticker := New(10 * time.Millisecond)
			DeferCleanup(ticker.Stop)

			ch := ticker.Chan()
			Expect(ch).NotTo(BeNil())

			// Verify we receive a tick within reasonable time
			Eventually(ch, 100*time.Millisecond).Should(Receive())
		})
	})
})
