package ticker

import (
	"sync/atomic"
	"time"
)

// Ticker represents a ticker that emits time events on a channel.
type Ticker interface {
	Chan() <-chan time.Time
	Stop()
}

// Factory creates Ticker instances.
type Factory func() Ticker

// ticker wraps time.Ticker to satisfy the Ticker interface.
type ticker struct {
	*time.Ticker
}

// Chan returns the channel that emits ticks.
func (t *ticker) Chan() <-chan time.Time {
	return t.C
}

// New returns a Ticker that emits ticks at the given interval.
func New(d time.Duration) Ticker {
	return &ticker{time.NewTicker(d)}
}

// tickerFake is a test fake for Ticker.
type tickerFake struct {
	c    chan time.Time
	done chan struct{}
}

// Chan returns the channel that emits ticks.
func (m *tickerFake) Chan() <-chan time.Time {
	return m.c
}

// Stop closes the ticker and prevents further ticks. Multiple calls are safe (idempotent).
func (m *tickerFake) Stop() {
	select {
	case <-m.done:
		// Already stopped, no-op
	default:
		close(m.done)
	}
}

// tick emits a tick event.
func (m *tickerFake) tick() {
	select {
	case m.c <- time.Now():
	case <-m.done:
		panic("tick on closed ticker")
	}
}

// SilentTickerFactory returns a Factory that creates tickers with nil channels (no events).
func SilentTickerFactory() Factory {
	return func() Ticker {
		return &tickerFake{
			c:    nil,
			done: make(chan struct{}),
		}
	}
}

// CreateFakeTickerFactory returns a tick function and ticker factory for tests
// that need explicit control over timing.
//
// Example:
//
//	tick, factory := CreateFakeTickerFactory()
//	tick()  // Emit a tick on demand
func CreateFakeTickerFactory() (func(), Factory) {
	t := &tickerFake{c: make(chan time.Time), done: make(chan struct{})}
	var invoked atomic.Bool
	tick := func() {
		t.tick()
	}
	factory := func() Ticker {
		if !invoked.CompareAndSwap(false, true) {
			panic("factory invoked multiple times")
		}
		return t
	}
	return tick, factory
}
